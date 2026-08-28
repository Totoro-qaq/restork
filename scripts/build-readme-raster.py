#!/usr/bin/env python3
"""Build the public README poster and HD GIF from synthetic Dashboard captures."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image

MINIMUM_WIDTH = 1600
MINIMUM_HEIGHT = 1000
GIF_FRAME_NAMES = (
    "01-radar.png",
    "02-topic-saved.png",
    "03-drafts.png",
    "04-variants.png",
    "05-recorded.png",
)
SHOWCASE_FRAMES = {
    "showcase-start": "00-start.png",
    "showcase-radar": "01-radar.png",
    "showcase-drafts": "04-variants.png",
    "showcase-run": "06-run.png",
    "showcase-approval": "07-approval.png",
    "showcase-vault": "08-vault.png",
}


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        description="Assemble Restork README raster assets from public synthetic screenshots."
    )
    command.add_argument("--frames", type=Path, required=True)
    command.add_argument("--output", type=Path, default=Path("assets/readme"))
    command.add_argument("--locale", choices=("en", "zh-CN"), required=True)
    return command


def main() -> int:
    arguments = parser().parse_args()
    frame_dir = arguments.frames.expanduser().resolve()
    output_dir = arguments.output.expanduser().resolve()
    suffix = "" if arguments.locale == "en" else ".zh-CN"
    poster_output = output_dir / f"demo-poster{suffix}.webp"
    gif_output = output_dir / f"demo-hd{suffix}.gif"
    social_output = output_dir / f"social-preview{suffix}.png"
    sources = [frame_dir / name for name in GIF_FRAME_NAMES]
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
        poster_output,
        "WEBP",
        quality=88,
        method=6,
        exact=True,
    )
    social = poster.resize((1280, 800), Image.Resampling.LANCZOS).crop((0, 0, 1280, 640))
    social.save(social_output, "PNG", optimize=True)
    for output_name, source_name in SHOWCASE_FRAMES.items():
        showcase = _read_rgb(frame_dir / source_name)
        showcase.save(
            output_dir / f"{output_name}{suffix}.webp",
            "WEBP",
            quality=86,
            method=6,
            exact=True,
        )

    sequence: list[Image.Image] = []
    durations: list[int] = []
    for index, frame in enumerate(frames):
        sequence.append(frame)
        durations.append(1_100 if index else 1_450)

    palette = sequence[0].quantize(
        colors=96,
        method=Image.Quantize.MAXCOVERAGE,
        dither=Image.Dither.NONE,
    )
    indexed = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE)
        for frame in sequence
    ]
    indexed[0].save(
        gif_output,
        "GIF",
        save_all=True,
        append_images=indexed[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=True,
        comment=f"Restork public synthetic Dashboard demo ({arguments.locale})".encode(),
    )
    _verify(poster_output, minimum_height=MINIMUM_HEIGHT)
    _verify(gif_output, minimum_height=MINIMUM_HEIGHT)
    print(f"Wrote {poster_output}")
    print(f"Wrote {gif_output} ({len(indexed)} frames)")
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
