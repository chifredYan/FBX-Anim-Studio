"""fbx-anim-tool: one-command FBX skeletal animation extractor.

Pipeline:
    FBX (already imported by Godot) -> Skeleton3D + AnimationPlayer
      -> (A) left-facing bone keyframe data  -> bones.json
      -> (B) 30 fps PNG sequence             -> frame_XXXX.png
      -> (C) 30 fps GIF                     -> animation.gif

The heavy lifting runs inside Godot 4 (scene tree + Vulkan), driven by a
poll-based extractor script. This module owns argument parsing, resource
discovery, and GIF assembly.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

__version__ = "1.1.0"

HERE = Path(__file__).resolve().parent
GODOT_PROJECT = HERE / "godot_project"
TOOLS_SRC = GODOT_PROJECT / "tools"

# Full paths are environment specific; override via --godot / env var.
DEFAULT_GODOT = os.environ.get(
    "FBXAT_GODOT",
    r"E:\AI\Godot_v4.7.2-stable_mono_win64\Godot_v4.7.2-stable_mono_win64_console.exe",
)
DEFAULT_HOST_PROJECT = Path(
    os.environ.get("FBXAT_HOST_PROJECT", r"D:\ChifredDrive\MYWorkBuddy\Code\TestDemo")
)
TOOL_FILES = ["anim_extractor.gd", "run_extract.gd", "run_extract.tscn"]


def log(msg: str) -> None:
    print(f"[fbxat] {msg}", flush=True)


def find_godot() -> Path:
    p = Path(DEFAULT_GODOT)
    if p.exists():
        return p
    found = shutil.which("godot") or shutil.which("godot4")
    if found:
        return Path(found)
    raise SystemExit(
        "Godot executable not found. Pass --godot <path> or set FBXAT_GODOT."
    )


def deploy_tools(host_project: Path) -> Path:
    """Copy the GDScript pair into the host project so res:// paths resolve."""
    dest = host_project / "tools"
    dest.mkdir(parents=True, exist_ok=True)
    for f in TOOL_FILES:
        src = TOOLS_SRC / f
        if not src.exists():
            raise SystemExit(f"missing tool source: {src}")
        shutil.copy2(src, dest / f)
    return dest


def resolve_resource(host_project: Path, target: str) -> str:
    """Map a user-supplied FBX / .scn path to a res:// path Godot can load.

    Priority:
      1. already a res:// or absolute .godot/imported path -> use as-is
      2. an .fbx inside the host project -> its generated .scn
      3. an external .fbx  -> copied into the host project, then imported
    """
    if target.startswith("res://"):
        return target

    t = Path(target)

    # Already an imported scene.
    if t.suffix == ".scn":
        if t.is_absolute() and t.exists():
            try:
                return "res://" + str(t.relative_to(host_project)).replace("\\", "/")
            except ValueError:
                pass
        return target

    if t.suffix.lower() != ".fbx":
        raise SystemExit(f"unsupported input: {target} (expected .fbx or .scn)")

    # Inside the host project already.
    try:
        rel = t.resolve().relative_to(host_project.resolve())
        stem = str(rel.with_suffix("")) .replace("\\", "/")
        return f"res://{stem}"
    except ValueError:
        pass

    # External file: stage it under assets/_fbxat/ and let Godot import it.
    staging = host_project / "assets" / "_fbxat"
    staging.mkdir(parents=True, exist_ok=True)
    dst = staging / t.name
    if not dst.exists() or dst.stat().st_size != t.stat().st_size:
        log(f"staging {t.name} ({t.stat().st_size/1e6:.1f} MB) -> {staging}")
        shutil.copy2(t, dst)
    return f"res://assets/_fbxat/{t.name}"


def import_pending(host_project: Path, godot: Path, res_path: str) -> None:
    """Run one editor import pass so a freshly staged FBX becomes a .scn."""
    log("running Godot import pass (needed for newly added FBX)...")
    cmd = [
        str(godot),
        "--headless",
        "--path",
        str(host_project),
        "--import",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    tail = (r.stdout or "") + (r.stderr or "")
    if "ERROR" in tail and "Cannot open" in tail:
        log("import reported errors; continuing (may still be cached)")


def build_scene_path(host_project: Path, res_path: str) -> str:
    """If res_path points at an .fbx, swap in the generated .scn."""
    p = Path(res_path.replace("res://", ""))
    if p.suffix.lower() != ".fbx":
        return res_path
    imp_file = host_project / f"{p}.import"
    if imp_file.exists():
        for line in imp_file.read_text(encoding="utf-8", errors="ignore").splitlines():
            m = re.match(r'^path="(.+\.scn)"', line.strip())
            if m:
                raw = m.group(1)
                # The .import file already stores a res:// path; don't re-prefix.
                if raw.startswith("res://"):
                    return raw
                return "res://" + raw.lstrip("./").replace("\\", "/")
    # Fall back to whatever .scn the importer produced.
    imported = host_project / ".godot" / "imported"
    stem = p.stem
    if imported.exists():
        for c in imported.glob(f"{stem}-*.scn"):
            return "res://.godot/imported/{c.name}"
    # Neither a .import nor a generated .scn: fail loudly rather than handing
    # Godot a .fbx path, which it cannot load at runtime.
    raise SystemExit(
        f"'{res_path}' has not been imported yet (no .import and no generated .scn).\n"
        f"Run the Godot editor once on {host_project}, or drop --no-import."
    )


def run_extract(
    godot: Path,
    host_project: Path,
    scene_res: str,
    out_dir: Path,
    fps: float,
    facing: str,
    cam: str,
    width: int,
    height: int,
    anim: str,
    render: bool,
    bones: bool,
    in_place: bool,
    keep_root: bool,
    bg: str,
    tres: bool,
) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    args = [
        str(godot),
        "--path",
        str(host_project),
        "--resolution",
        "64x64",
        "--position",
        "5000,5000",  # park the helper window off-screen
        "--rendering-driver",
        "vulkan",
        "res://tools/run_extract.tscn",
        "--",
        "--res",
        scene_res,
        "--out",
        out_dir.as_posix(),
        "--fps",
        str(fps),
        "--facing",
        facing,
        "--cam",
        cam,
        "--width",
        str(width),
        "--height",
        str(height),
        "--render",
        "1" if render else "0",
        "--bones",
        "1" if bones else "0",
        "--in_place",
        "1" if in_place else "0",
        "--keep_root_motion",
        "1" if keep_root else "0",
        "--tool_version",
        __version__,
        "--tres",
        "1" if tres else "0",
    ]
    if anim:
        args += ["--anim", anim]
    if bg:
        args += ["--bg", bg.lstrip("#")]

    log(f"godot extract ({'render+bones' if render and bones else 'bones' if bones else 'render'})")
    proc = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=3600,
        cwd=str(host_project),
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    m = re.search(r"\[EXTRACT_DONE\]\s*(\{.*\})", out)
    if not m:
        errs = [ln for ln in out.splitlines() if "ERROR" in ln or "Parse Error" in ln]
        raise SystemExit(
            "extraction failed (exit %d)\n%s"
            % (proc.returncode, "\n".join(errs[:8]) or out[-800:])
        )
    return json.loads(m.group(1))


def make_gif(folder: Path, fps: float, loop: int, bg: str, sheet: bool, scale: int) -> None:
    sys.path.insert(0, str(HERE))
    from make_gif import build_contact_sheet, build_gif, collect_frames  # type: ignore

    files = collect_frames(folder, "frame_*.png")
    if not files:
        raise SystemExit(f"no PNG frames in {folder}")
    build_gif(files, folder / "animation.gif", fps, loop, bg)
    if sheet:
        build_contact_sheet(files, folder / "contact_sheet.png", 8, bg, scale)


def main() -> int:
    ap = argparse.ArgumentParser(
        prog="fbx-anim-tool",
        description="Extract left-facing bone animation + 30fps GIF/PNG from an FBX.",
    )
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    ap.add_argument("input", help="path to a .fbx (or .scn) file")
    ap.add_argument("-o", "--out", type=Path, default=HERE / "output", help="output folder")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument(
        "--facing",
        default="left",
        help="left | right | front | back | <degrees>  (default: left)",
    )
    ap.add_argument("--cam", default="side", choices=["side", "front", "three_quarter"])
    ap.add_argument("-W", "--width", type=int, default=512)
    ap.add_argument("-H", "--height", type=int, default=512)
    ap.add_argument("-a", "--anim", default="", help="animation name (default: first clip)")
    ap.add_argument("--bones", action="store_true", default=True, help="export bones.json")
    ap.add_argument("--no-bones", dest="bones", action="store_false")
    ap.add_argument("--render", action="store_true", default=True, help="render PNG frames")
    ap.add_argument("--no-render", dest="render", action="store_false")
    ap.add_argument("--gif", action="store_true", default=True, help="assemble GIF")
    ap.add_argument("--no-gif", dest="gif", action="store_false")
    ap.add_argument("--loop", type=int, default=0, help="0 = forever")
    ap.add_argument("--bg", default="#17171c")
    ap.add_argument("--sheet", action="store_true", help="also write a contact sheet")
    ap.add_argument("--sheet-scale", type=int, default=4)
    ap.add_argument(
        "--no-in-place",
        dest="in_place",
        action="store_false",
        default=True,
        help="keep the authored root motion instead of pinning the hips",
    )
    ap.add_argument(
        "--keep-root-motion",
        action="store_true",
        default=False,
        help="also preserve root drift inside bones.json",
    )
    ap.add_argument(
        "--no-tres",
        dest="tres",
        action="store_false",
        default=True,
        help="skip the native Godot Animation .tres export (on by default)",
    )
    ap.add_argument("--godot", type=Path, default=None)
    ap.add_argument("--host-project", type=Path, default=DEFAULT_HOST_PROJECT)
    ap.add_argument(
        "--no-import",
        dest="do_import",
        action="store_false",
        default=True,
        help="skip the editor import pass (FBX already imported)",
    )
    args = ap.parse_args()
    log(f"fbx-anim-tool v{__version__}")

    godot = find_godot() if args.godot is None else args.godot
    if not Path(godot).exists():
        raise SystemExit(f"Godot not found: {godot}")
    host = args.host_project.resolve()
    if not (host / "project.godot").exists():
        raise SystemExit(f"not a Godot project: {host}")

    log(f"godot  = {godot}")
    log(f"host   = {host}")
    deploy_tools(host)

    res = resolve_resource(host, args.input)
    is_fbx = res.lower().endswith(".fbx")
    imp = host / (res.replace("res://", "") + ".import")

    # A newly staged FBX has no .import yet, so the .scn does not exist.
    # Import is mandatory in that case regardless of --no-import: skipping it
    # would guarantee a "No loader found for resource" failure.
    need_import = is_fbx and not imp.exists()
    if need_import:
        import_pending(host, godot, res)
    elif is_fbx and args.do_import:
        # Already imported, but the file may have changed on disk.
        stale = imp.stat().st_mtime < (host / res.replace("res://", "")).stat().st_mtime
        if stale:
            import_pending(host, godot, res)

    scene = build_scene_path(host, res)
    log(f"scene  = {scene}")

    out_dir = args.out.resolve()
    if out_dir.exists():
        for f in out_dir.glob("frame_*.png"):
            f.unlink()

    meta = run_extract(
        godot, host, scene, out_dir, args.fps, args.facing, args.cam,
        args.width, args.height, args.anim, args.render, args.bones,
        args.in_place, args.keep_root_motion, args.bg, args.tres,
    )

    if args.gif and args.render:
        make_gif(out_dir, args.fps, args.loop, args.bg, args.sheet, args.sheet_scale)

    log("=" * 58)
    log(f"animation : {meta['animation']}")
    log(f"frames    : {meta['frames']} @ {args.fps:g} fps")
    log(f"bones     : {meta['bones']}")
    log(f"facing    : {args.facing}")
    log(f"output    : {out_dir}")
    produced = sorted(
        p.name for p in out_dir.iterdir()
        if p.suffix in {".json", ".gif", ".png", ".tres"} and not p.name.startswith("contact_")
    )
    log(f"files     : {len(produced)} ({', '.join(produced[:6])}{'...' if len(produced) > 6 else ''})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())