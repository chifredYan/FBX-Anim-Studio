extends Node
## CLI entry point. Launched by:
##   godot --path <project> res://tools/run_extract.tscn -- <args>
##
## NOTE: driven from _process() rather than await/coroutines. In --script mode
## Godot's main loop does not pump rendering frames, so any `await` on a
## frame signal deadlocks. A poll-based state machine works in every mode.

const Extractor := preload("res://tools/anim_extractor.gd")

var ex
var out_dir := ""
var do_render := true
var do_tres := true
var pending := false
var frame_i := 0
var total_frames := 0
var started := false
var flush_at := 0
## Version of the driving Python tool; stamped into meta.json when provided.
var tool_version := ""


func _ready() -> void:
	var args := _parse_args(OS.get_cmdline_user_args())
	var res_path: String = args.get("res", "")
	if res_path == "":
		_fail("--res <imported scene path> is required")
		return

	out_dir = args.get("out", "user://extract_out")
	var fps := float(args.get("fps", "30"))
	var facing_arg: String = args.get("facing", "left")
	# Named facings keep intent readable; a raw number is still accepted.
	# FBX/Godot convention: model forward is -Z at yaw 0.
	#   left-> +90  (side view, character looks toward screen-left)
	#   right -> -90  (side view, character looks toward screen-right)
	#   front-> 0 / back -> 180
	var facing := 90.0
	match facing_arg.to_lower():
		"left", "l":
			facing = 90.0
		"right", "r":
			facing = -90.0
		"front", "f":
			facing = 0.0
		"back":
			facing = 180.0
		_:
			facing = facing_arg.to_float()
	var w := int(args.get("width", "512"))
	var h := int(args.get("height", "512"))
	var anim: String = args.get("anim", "")
	var cam: String = args.get("cam", "side")
	var bg := _parse_bg(args.get("bg", ""))
	var do_render: bool = args.get("render", "1") == "1"
	var do_bones: bool = args.get("bones", "1") == "1"
	var do_tres: bool = args.get("tres", "1") == "1"
	tool_version = args.get("tool_version", "")

	var packed: PackedScene = ResourceLoader.load(res_path, "PackedScene")
	if packed == null:
		_fail("cannot load scene: " + res_path)
		return
	DirAccess.make_dir_recursive_absolute(out_dir)

	var in_place: bool = args.get("in_place", "1") == "1"
	var keep_root: bool = args.get("keep_root_motion", "1") == "1"

	ex = Extractor.new()
	add_child(ex)
	ex.setup(packed, out_dir, fps, facing, do_render, do_bones, anim, w, h, cam, bg,
			in_place, keep_root, do_tres)

	if ex.results.get("fatal", "") != "":
		_fail(ex.results["fatal"])
		return

	total_frames = ex.begin()
	started = true
	print("[EXTRACT] anim=%s frames=%d bones=%d fps=%d facing=%.0f" % [
		ex.results.get("animation", "?"), total_frames,
		ex.results.get("bone_count", 0), int(fps), facing])


func _process(_dt: float) -> void:
	if not started:
		return

	# Step one frame per process tick so the renderer can actually present.
	if frame_i < total_frames:
		ex.drain_pngs()          # save what was presented last tick
		ex.step_frame(frame_i)    # advance the pose for this tick
		frame_i += 1
		if frame_i == total_frames:
			flush_at = 2   # let the final frame get presented + saved
		return

	if flush_at > 0:
		ex.drain_pngs()
		flush_at -= 1
		return

	_finish()


func _finish() -> void:
	started = false
	var meta := {
		"animation": ex.results.get("animation", ""),
		"length_sec": ex.results.get("length_sec", 0.0),
		"fps": ex.fps,
		"frames": frame_i,
		"bone_count": ex.results.get("bone_count", 0),
		"bone_names": Array(ex.bone_names),
		"facing_yaw_deg": ex.facing_yaw_deg,
		"camera_mode": ex.camera_mode,
		"resolution": [ex.width, ex.height],
		"animations_available": Array(ex.list_animations()),
		"rendered": do_render,
		"bones_exported": do_bones_meta(),
	}
	if tool_version != "":
		meta["tool"] = "fbx-anim-tool"
		meta["tool_version"] = tool_version
	var mf := FileAccess.open(out_dir.path_join("meta.json"), FileAccess.WRITE)
	if mf:
		mf.store_string(JSON.stringify(meta, "", false))
		mf.close()
	if do_bones_meta():
		ex.write_json(out_dir.path_join("bones.json"))
	if do_tres:
		ex.write_tres(out_dir.path_join("animation.tres"))

	print("[EXTRACT_DONE] ", JSON.stringify({
		"animation": meta["animation"],
		"frames": meta["frames"],
		"bones": meta["bone_count"],
		"out": ProjectSettings.globalize_path(out_dir),
	}))
	get_tree().quit(0)


func do_bones_meta() -> bool:
	var v: bool = ex.do_bones
	return v


func _parse_color(s: String, fallback: Color) -> Color:
	if s == "":
		return fallback
	if s.begins_with("#"):
		s = s.substr(1)
	if s.length() != 6 and s.length() != 8:
		return fallback
	var col := Color.html(s)
	# Color.html leaves alpha at 0 for 6-digit input; force opaque.
	if s.length() == 6:
		col.a = 1.0
	return col


func _parse_bg(s: String) -> Color:
	return _parse_color(s, Color(0.09, 0.09, 0.11, 1.0))


func _parse_args(argv: PackedStringArray) -> Dictionary:
	var d := {}
	var i := 0
	while i < argv.size():
		var a := argv[i]
		if a.begins_with("--"):
			var key := a.substr(2)
			if i + 1 < argv.size() and not argv[i + 1].begins_with("--"):
				d[key] = argv[i + 1]
				i += 2
			else:
				d[key] = "1"
				i += 1
		else:
			i += 1
	return d


func _fail(msg: String) -> void:
	printerr("[EXTRACT_FAIL] ", msg)
	get_tree().quit(1)