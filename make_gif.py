"""PNG sequence -> GIF converter for the FBX animation extractor.

Kept deliberately dependency-light: Pillow only.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image

__version__ = "1.1.0"


def _rgba(bg_hex: str) -> tuple[int, int, int, int]:
    bg = bg_hex.lstrip("#")
    return tuple(int(bg[i : i + 2], 16) for i in (0, 2, 4)) + (255,)


def collect_frames(folder: Path, pattern: str) -> list[Path]:
    rx = re.compile(pattern.replace("*", r".*").replace("?", r"."))
    files = sorted(
        (p for p in folder.iterdir() if p.suffix.lower() == ".png" and rx.match(p.name)),
        key=lambda p: p.name,
    )
    return files


def build_gif(
    files: list[Path],
    out: Path,
    fps: float,
    loop: int,
    bg_hex: str,
) -> None:
    if not files:
        raise SystemExit(f"no PNG frames found in {out.parent}")

    # GIF stores per-frame delays in whole centiseconds, so the exact
    # 1000/fps value is not always representable. 30fps -> 33.3ms would be
    # rounded to 30ms and play ~11% fast. Instead we build an accumulator and
    # emit frames with alternating delays so the AVERAGE duration lands on the
    # requested fps (30fps becomes an alternating 30/40ms pattern).
    exact_ms = 1000.0 / fps
    cm = round(exact_ms / 10.0)
    if cm < 1:
        cm = 1
    base = cm * 10

    frames: list[Image.Image] = []
    for f in files:
        im = Image.open(f).convert("RGBA")
        # Composite over a flat background: GIF is palette based and has no alpha.
        canvas = Image.new("RGBA", im.size, _rgba(bg_hex))
        canvas.alpha_composite(im)
        frames.append(canvas.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT))

    durations: list[int] = _accumulate_delays(len(frames), exact_ms)
    assert len(durations) == len(frames)

    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=loop,
        optimize=True,
        disposal=2,
    )
    avg = sum(durations) / len(durations)
    print(
        f"[gif] {out}  frames={len(frames)} fps={fps} "
        f"avg={avg:.1f}ms/frame actual={1000/avg:.2f}fps"
    )


def _accumulate_delays(n: int, exact_ms: float) -> list[int]:
    """Per-frame integer delays (ms) whose mean equals exact_ms.

    GIF quantises each delay to whole centiseconds, so the exact 1000/fps
    value is not representable. Rounding every frame independently biases the
    average; instead we walk the ideal cumulative timeline and emit the
    difference between consecutive centisecond marks.30fps then comes out as
    a repeating 30/40ms pattern averaging exactly 33.3ms.
    """
    delays: list[int] = []
    prev_cs = 0
    for i in range(n):
        ideal_cs = int(round(((i + 1) * exact_ms) / 10.0))
        delays.append((ideal_cs - prev_cs) * 10)
        prev_cs = ideal_cs
    return delays


def build_contact_sheet(
    files: list[Path],
    out: Path,
    cols: int,
    bg_hex: str,
    scale: int,
) -> None:
    """Grid preview of every Nth frame - quick visual sanity check."""
    if not files:
        return
    step = max(1, len(files) // (cols * 4))
    picks = files[::step][: cols * 4]
    first = Image.open(picks[0])
    tw, th = first.width // scale, first.height // scale
    rows = (len(picks) + cols - 1) // cols
    bg_rgb = _rgba(bg_hex)[:3]
    sheet = Image.new("RGB", (cols * tw, rows * th), bg_rgb)
    for idx, p in enumerate(picks):
        im = Image.open(p).convert("RGB").resize((tw, th), Image.LANCZOS)
        sheet.paste(im, ((idx % cols) * tw, (idx // cols) * th))
    sheet.save(out)
    print(f"[sheet] {out}  {len(picks)} thumbs  {sheet.width}x{sheet.height}")


def main() -> int:
    ap = argparse.ArgumentParser(description="PNG sequence -> GIF")
    ap.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    ap.add_argument("folder", type=Path, help="folder containing frame_*.png")
    ap.add_argument("-o", "--out", type=Path, default=None, help="output .gif path")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--loop", type=int, default=0, help="0 = forever")
    ap.add_argument("--bg", default="#17171c", help="background hex")
    ap.add_argument("--pattern", default="frame_*.png")
    ap.add_argument("--sheet", action="store_true", help="also write a contact sheet")
    ap.add_argument("--sheet-cols", type=int, default=8)
    ap.add_argument("--sheet-scale", type=int, default=4)
    args = ap.parse_args()

    folder: Path = args.folder
    if not folder.is_dir():
        print(f"not a directory: {folder}", file=sys.stderr)
        return 1

    files = collect_frames(folder, args.pattern)
    if not files:
        print(f"no frames matched {args.pattern} in {folder}", file=sys.stderr)
        return 1

    out = args.out or (folder / "animation.gif")
    build_gif(files, out, args.fps, args.loop, args.bg)

    if args.sheet:
        build_contact_sheet(
            files,
            folder / "contact_sheet.png",
            args.sheet_cols,
            args.bg,
            args.sheet_scale,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())