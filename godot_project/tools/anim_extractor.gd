extends Node3D
## Offscreen frame extractor + bone data exporter for imported FBX characters.
##
## Poll-based by design: begin() then call step_frame(i) once per rendered frame.
## Godot cannot resolve `await` reliably in non-windowed/CLI modes, so the whole
## pipeline is a plain state machine driven by the caller's _process().

var fps := 30.0
var facing_yaw_deg := 180.0
var out_dir := "user://out"
var do_render := true
var do_bones := true
var camera_mode := "side"
var width := 512
var height := 512
var bg := Color(0.09, 0.09, 0.11, 1.0)
var anim_name := ""
## Zero out horizontal root translation after sampling, so a run cycle plays
## in place instead of walking out of frame.
var in_place := true
## Keep the original root motion inside the exported bone JSON.
var keep_root_motion := true

var scene_root: Node3D
var skeleton: Skeleton3D
var anim_player: AnimationPlayer
var model_root: Node3D

var viewport: SubViewport
var camera: Camera3D
var light: DirectionalLight3D

var frames: Array = []
var bone_names: PackedStringArray = []
var results := {}

var _clip := ""
var _length := 1.0
var _step := 1.0 / 30.0
var _frame_count := 0
var _png_queue: Array[int] = []
var _cam_yaw := 0.0
var _cam_dist := 4.0
var _cam_center_y := 1.0


func setup(p_scene: PackedScene, p_out: String, p_fps: float, p_facing: float,
		p_render: bool, p_bones: bool, p_anim: String, p_w: int, p_h: int,
		p_cam: String, p_bg: Color, p_in_place: bool = true,
		p_keep_root: bool = true) -> void:
	out_dir = p_out
	fps = p_fps
	facing_yaw_deg = p_facing
	do_render = p_render
	do_bones = p_bones
	anim_name = p_anim
	width = p_w
	height = p_h
	camera_mode = p_cam
	bg = p_bg
	in_place = p_in_place
	keep_root_motion = p_keep_root
	_step = 1.0 / p_fps

	scene_root = p_scene.instantiate() as Node3D
	if scene_root == null:
		results["fatal"] = "instantiate_failed"
		return
	add_child(scene_root)

	skeleton = _find_first(scene_root, "Skeleton3D") as Skeleton3D
	anim_player = _find_first(scene_root, "AnimationPlayer") as AnimationPlayer
	if skeleton == null:
		results["fatal"] = "no_skeleton"
		return
	if anim_player == null:
		results["fatal"] = "no_anim_player"
		return

	model_root = scene_root
	model_root.rotation.y = deg_to_rad(facing_yaw_deg)

	bone_names = PackedStringArray()
	for i in skeleton.get_bone_count():
		bone_names.append(skeleton.get_bone_name(i))

	if do_render:
		_build_render_env()

	results["ok"] = true


func _find_first(n: Node, cls: String) -> Node:
	if n.get_class() == cls:
		return n
	for c in n.get_children():
		var r := _find_first(c, cls)
		if r != null:
			return r
	return null


func _build_render_env() -> void:
	viewport = SubViewport.new()
	viewport.size = Vector2i(width, height)
	viewport.own_world_3d = true
	viewport.msaa_3d = Viewport.MSAA_DISABLED
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.positional_shadow_atlas_size = 1024
	add_child(viewport)

	var world_env := WorldEnvironment.new()
	var env := Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = bg
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.72, 0.74, 0.82)
	env.ambient_light_energy = 0.7
	world_env.environment = env
	viewport.add_child(world_env)

	light = DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-35, 145, 0)
	light.light_energy = 1.6
	light.shadow_enabled = false
	viewport.add_child(light)

	camera = Camera3D.new()
	viewport.add_child(camera)

	var old_parent := scene_root.get_parent()
	old_parent.remove_child(scene_root)
	viewport.add_child(scene_root)


func list_animations() -> PackedStringArray:
	if anim_player == null:
		return PackedStringArray()
	return anim_player.get_animation_list()


## Approximate visual height from bone rest poses so the camera can frame any
## character without hardcoded magic numbers.
func _measure_height() -> float:
	var lo := INF
	var hi := -INF
	for i in skeleton.get_bone_count():
		var y: float = skeleton.get_bone_rest(i).origin.y
		lo = min(lo, y)
		hi = max(hi, y)
	return max(hi - lo, 0.5)


## Prepare the run. Returns total frame count.
func begin() -> int:
	if results.get("fatal", "") != "":
		return 0

	if anim_name != "" and anim_player.has_animation(anim_name):
		_clip = anim_name
	else:
		var list := list_animations()
		if list.is_empty():
			results["fatal"] = "no_animations"
			return 0
		if anim_name != "":
			print("[WARN] animation '%s' not found, using '%s'" % [anim_name, list[0]])
		_clip = list[0]

	var anim: Animation = anim_player.get_animation(_clip)
	_length = anim.length
	if _length <= 0.0:
		_length = 1.0
	_frame_count = int(round(_length * fps))
	if _frame_count < 1:
		_frame_count = 1

	results["animation"] = _clip
	results["length_sec"] = _length
	results["frames"] = _frame_count
	results["bone_count"] = skeleton.get_bone_count()

	var h := _measure_height()
	results["measured_height"] = h
	if do_render:
		_frame_camera(h)

	# Edit the track while the clip is still stopped: modifying keyframes of a
	# playing Animation invalidates its cached playback data and stalls the
	# playback cache rebuild in a render loop.
	if in_place and not (do_bones and keep_root_motion):
		_disable_root_motion()
	anim_player.play(_clip)
	anim_player.seek(0.0, true)
	anim_player.advance(0.0)
	return _frame_count


## Advance to frame f, export its bones, and queue a PNG grab.
func step_frame(f: int) -> void:
	if skeleton == null:
		return
	var t: float = minf(f * _step, _length)
	anim_player.seek(t, true)
	anim_player.advance(0.0)

	if do_bones:
		_capture_frame(f, t)
	if do_render:
		_recenter_camera()
		_png_queue.append(f)


## Cancel horizontal root motion at the source.
##
## Verified against the FBX importer output: the skeleton root track path is
## "Skeleton3D:mixamorig_Hips" (bone NAME, not "bone/N"), so we blank the x/z
## components of every keyframe on that track. Limb tracks are untouched, which
## keeps the authored animation intact while pinning the hips to the origin.
func _disable_root_motion() -> void:
	var anim: Animation = anim_player.get_animation(_clip)
	var ri := _root_bone_index()
	if ri < 0:
		return
	var bone_name: String = skeleton.get_bone_name(ri)
	var rn: Node = anim_player.get_node(anim_player.get_root_node())
	var skel_rel: NodePath = rn.get_path_to(skeleton)
	var wanted := NodePath("%s:%s" % [str(skel_rel), bone_name])

	for t in range(anim.get_track_count()):
		if anim.track_get_path(t) != wanted:
			continue
		if anim.track_get_type(t) != Animation.TYPE_POSITION_3D:
			continue
		var n: int = anim.track_get_key_count(t)
		for k in range(n):
			var v: Variant = anim.track_get_key_value(t, k)
			if v is Vector3:
				# Preserve the authored vertical bob; only flatten the
				# horizontal run drift so the clip plays in place.
				var y: float = v.y
				anim.track_set_key_value(t, k, Vector3(0.0, y, 0.0))
		print("[root_motion] neutralised %s (%d keys)" % [wanted, n])
		return


## Keep the animated root from walking out of shot: measure its horizontal
## offset each frame and slide the camera by the same amount.
func _recenter_camera() -> void:
	if camera == null or skeleton == null:
		return
	var root_i := _root_bone_index()
	if root_i < 0:
		return
	var gp: Transform3D = skeleton.get_bone_global_pose(root_i)
	var offset := Vector3(gp.origin.x, 0, gp.origin.z)
	# Slide with the animated root so the character never walks out of frame.
	# The camera sits OUTBOARD of the target, i.e. back along -view_dir.
	var dir := Vector3(sin(_cam_yaw), 0, cos(_cam_yaw))
	camera.position = offset - dir * _cam_dist + Vector3(0, _cam_center_y, 0)
	camera.look_at(offset + Vector3(0, _cam_center_y, 0), Vector3.UP)


func _root_bone_index() -> int:
	for i in skeleton.get_bone_count():
		var n: String = skeleton.get_bone_name(i).to_lower()
		if n.ends_with("hips") or n.ends_with("root") or n == "armature" or n == "bone":
			return i
	return 0


## Drain queued PNGs. Called every tick by the driver so each saved image is
## the one actually presented on screen.
func drain_pngs() -> void:
	if not do_render or viewport == null:
		return
	var q := _png_queue.duplicate()
	_png_queue.clear()
	if q.is_empty():
		return
	var img: Image = viewport.get_texture().get_image()
	if img == null:
		return
	for f in q:
		img.save_png(out_dir.path_join("frame_%04d.png" % f))


func _capture_frame(f: int, t: float) -> void:
	var local_trs: Array = []
	var global_trs: Array = []
	for i in skeleton.get_bone_count():
		var bn: String = skeleton.get_bone_name(i)
		var pose: Transform3D = skeleton.get_bone_pose(i)
		var gt: Transform3D = skeleton.get_bone_global_pose(i)
		local_trs.append({
			"name": bn,
			"t": _v3(pose.origin),
			"r": _v4(pose.basis.orthonormalized()),
			"s": _v3(pose.basis.get_scale()),
		})
		global_trs.append({
			"name": bn,
			"t": _v3(gt.origin),
			"r": _v4(gt.basis.orthonormalized()),
		})
	frames.append({
		"frame": f,
		"time": snappedf(t, 0.000001),
		"local": local_trs,
		"global": global_trs,
	})


func _frame_camera(h: float) -> void:
	# Bone Y extents measure the skeleton, but the mesh (hair, hat, sword) can
	# exceed it. Add generous headroom and sit the aim point at chest height.
	_cam_center_y = h * 0.62
	_cam_dist = h * 2.9
	# camera_mode is a FIXED world-space viewing direction. The model's own yaw
	# (facing_yaw_deg) is applied to model_root and must NOT be mixed in here,
	# otherwise the camera would orbit with the model and the facing change
	# would be invisible.
	#
	#   side-> world yaw 0deg  (camera on +Z, looking toward -Z; model faces X)
	#   front -> world yaw 90deg (camera on +X, looking toward -X)
	#   three_quarter -> world yaw 50deg
	var world_yaw := 0.0
	match camera_mode:
		"side":
			world_yaw = 0.0
		"front":
			world_yaw = 90.0
		"three_quarter":
			world_yaw = 50.0
	_cam_yaw = deg_to_rad(world_yaw)
	var dir := Vector3(sin(_cam_yaw), 0, cos(_cam_yaw))
	camera.position = -dir * _cam_dist + Vector3(0, _cam_center_y, 0)
	camera.look_at(Vector3(0, _cam_center_y, 0), Vector3.UP)
	camera.fov = 40.0
	camera.near = 0.05
	camera.far = _cam_dist * 4.0


func write_json(path: String) -> void:
	var payload := {
		"animation": results.get("animation", ""),
		"length_sec": results.get("length_sec", 0.0),
		"fps": fps,
		"frame_count": frames.size(),
		"bone_count": skeleton.get_bone_count() if skeleton else 0,
		"bone_names": Array(bone_names),
		"facing_yaw_deg": facing_yaw_deg,
		"convention": {
			"handedness": "left-handed (Godot)",
			"forward": "-Z when facing_yaw_deg is 0",
			"rotation": "quaternion xyzw",
			"pose_space": "bone-local, parent-relative to FBX bone rest",
		},
		"frames": frames,
	}
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		printerr("[WARN] cannot write ", path)
		return
	f.store_string(JSON.stringify(payload))
	f.close()


func _v3(v: Vector3) -> Array:
	return [snappedf(v.x, 0.000001), snappedf(v.y, 0.000001), snappedf(v.z, 0.000001)]


func _v4(q: Quaternion) -> Array:
	return [snappedf(q.x, 0.000001), snappedf(q.y, 0.000001),
			snappedf(q.z, 0.000001), snappedf(q.w, 0.000001)]