extends SceneTree
## Round-trip verification for exported .tres animations: load one, apply it to
## the imported FBX skeleton via its AnimationPlayer, then read bone poses back
## for numeric comparison against the source data. Usage:
##   godot --headless --path . -s res://tools/roundtrip_test.gd -- <anim.tres> <imported_scene.scn>

func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	if args.size() < 2:
		print("RT_FAIL usage: <anim.tres> <scene.scn>")
		quit(1)
		return
	var tres_res: String = args[0]
	var scene_res: String = args[1]

	var packed: PackedScene = ResourceLoader.load(scene_res)
	if packed == null:
		print("RT_FAIL cannot load scene ", scene_res)
		quit(1)
		return
	var scene_inst: Node3D = packed.instantiate()
	root.add_child(scene_inst)

	var skel: Skeleton3D = _find(scene_inst, "Skeleton3D")
	var ap: AnimationPlayer = _find(scene_inst, "AnimationPlayer")
	if skel == null or ap == null:
		print("RT_FAIL no skeleton/anim player")
		quit(1)
		return

	var anim: Animation = ResourceLoader.load(tres_res)
	if anim == null:
		print("RT_FAIL cannot load anim ", tres_res)
		quit(1)
		return
	print("RT anim: length=", anim.length, " loop_mode=", anim.loop_mode,
		" step=", anim.step, " tracks=", anim.get_track_count())

	var missing := 0
	var bad_values := 0
	for i in anim.get_track_count():
		var p: String = anim.track_get_path(i)
		var parts: PackedStringArray = p.split(":", true, 1)
		if parts.size() != 2 or parts[0] != "Skeleton3D":
			bad_values += 1
			continue
		if skel.find_bone(parts[1]) == -1:
			missing += 1
			if missing <= 3:
				print("  RT missing bone for track: ", parts[1])
	print("RT tracks with non-skeleton path: ", bad_values)
	print("RT tracks with unknown bone: ", missing)

	var lib: AnimationLibrary = ap.get_animation_library("")
	if lib == null:
		lib = AnimationLibrary.new()
		ap.add_animation_library("", lib)
	lib.add_animation("rt", anim)
	ap.play("rt")
	ap.seek(1.0, true)
	ap.advance(0.0)

	var hips: int = skel.find_bone("mixamorig_Hips")
	var neck: int = skel.find_bone("mixamorig_Neck")
	var spine: int = skel.find_bone("mixamorig_Spine")
	for pair in [["Hips", hips], ["Spine", spine], ["Neck", neck]]:
		var pose: Transform3D = skel.get_bone_pose(pair[1])
		var q: Quaternion = pose.basis.get_rotation_quaternion()
		print("RT %s @1.0s: t=(%.6f, %.6f, %.6f) q=(%.6f, %.6f, %.6f, %.6f)" % [
			pair[0], pose.origin.x, pose.origin.y, pose.origin.z, q.x, q.y, q.z, q.w])
	quit(0)


func _find(n: Node, cls: String) -> Node:
	if n.get_class() == cls:
		return n
	for c in n.get_children():
		var r: Node = _find(c, cls)
		if r != null:
			return r
	return null
