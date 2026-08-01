#!/usr/bin/env python3
"""Build the public README poster and HD GIF from synthetic Dashboard captures."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

MINIMUM_WIDTH = 1600
MINIMUM_HEIGHT = 1000
FRAME_NAMES = (
    "00-overview.png",
    "01-runs.png",
    "02-approvals.png",
    "03-tasks.png",
    "04-radar.png",
    "05-memory.png",
    "06-overview-cd.png",
    "07-work.png",
)


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        description="Assemble Restork README raster assets from public synthetic screenshots."
    )
    command.add_argument("--frames", type=Path, required=True)
    command.add_argument("--output", type=Path, default=Path("assets/readme"))
    return command


def main() -> int:
    arguments = parser().parse_args()
    frame_dir = arguments.frames.expanduser().resolve()
    output_dir = arguments.output.expanduser().resolve()
    sources = [frame_dir / name for name in FRAME_NAMES]
    poster_source = frame_dir / "poster.png"
    missing = [path.name for path in (*sources, poster_source) if not path.is_file()]
    if missing:
        raise SystemExit("missing synthetic capture(s): " + ", ".join(missing))

    frames = [_read_rgb(path) for path in sources]
    size = frames[0].size
    if size[0] < MINIMUM_WIDTH or size[1] < MINIMUM_HEIGHT:
        raise SystemExit(f"GIF frames must be at least {MINIMUM_WIDTH}x{MINIMUM_HEIGHT}")
    if any(frame.size != size for frame in frames):
        raise SystemExit("all GIF captures must have identical dimensions")

    poster = _read_rgb(poster_source)
    if poster.width < MINIMUM_WIDTH or poster.height < MINIMUM_HEIGHT:
        raise SystemExit(f"poster must be at least {MINIMUM_WIDTH}x{MINIMUM_HEIGHT}")
    output_dir.mkdir(parents=True, exist_ok=True)
    poster.save(
        output_dir / "demo-poster.webp",
        "WEBP",
        quality=88,
        method=6,
        exact=True,
    )

    sequence: list[Image.Image] = []
    durations: list[int] = []
    for index, frame in enumerate(frames):
        sequence.append(frame)
        durations.append(950 if index else 1_300)
        if index + 1 < len(frames):
            next_frame = frames[index + 1]
            sequence.extend(
                (
                    Image.blend(frame, next_frame, 0.34),
                    Image.blend(frame, next_frame, 0.67),
                )
            )
            durations.extend((90, 90))

    palette = sequence[0].quantize(
        colors=192,
        method=Image.Quantize.MAXCOVERAGE,
        dither=Image.Dither.NONE,
    )
    indexed = [
        frame.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG)
        for frame in sequence
    ]
    indexed[0].save(
        output_dir / "demo-hd.gif",
        "GIF",
        save_all=True,
        append_images=indexed[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
        comment=b"Restork public synthetic Dashboard demo",
    )
    _verify(output_dir / "demo-poster.webp", minimum_height=MINIMUM_HEIGHT)
    _verify(output_dir / "demo-hd.gif", minimum_height=MINIMUM_HEIGHT)
    print(f"Wrote {output_dir / 'demo-poster.webp'}")
    print(f"Wrote {output_dir / 'demo-hd.gif'} ({len(indexed)} frames)")
    return 0


def _read_rgb(path: Path) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGB")


def _verify(path: Path, *, minimum_height: int) -> None:
    with Image.open(path) as image:
        if image.width < MINIMUM_WIDTH or image.height < minimum_height:
            raise SystemExit(f"generated asset is undersized: {path}")


if __name__ == "__main__":
    raise SystemExit(main())
