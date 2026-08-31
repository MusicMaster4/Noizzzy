from __future__ import annotations

import argparse
import logging
import re
import shutil
from pathlib import Path


def stem_label(path: Path) -> str | None:
    labels = re.findall(r"_\(([^)]+)\)(?:_|\.)", path.name.lower())
    return labels[-1] if labels else None


def identify(paths: list[Path]) -> tuple[Path, Path]:
    labelled = [(path, stem_label(path)) for path in paths]
    vocal = next((path for path, label in labelled if label in {"vocal", "vocals"}), None)
    instrumental = next(
        (
            path for path, label in labelled
            if label in {"instrumental", "other", "no_vocal", "no_vocals", "accompaniment"}
        ),
        None,
    )
    remaining = [path for path in paths if path != vocal]
    if instrumental is None and len(remaining) == 1:
        instrumental = remaining[0]
    if vocal is None or instrumental is None or vocal == instrumental:
        raise RuntimeError("audio-separator não produziu os stems de voz e instrumental esperados")
    return vocal, instrumental


def main() -> None:
    parser = argparse.ArgumentParser(description="Noizzzy isolated audio-separator bridge")
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("model_dir", type=Path)
    parser.add_argument("model")
    parser.add_argument("device")
    args = parser.parse_args()

    import torch
    from audio_separator.separator import Separator  # type: ignore[import-not-found]

    args.output_dir.mkdir(parents=True, exist_ok=True)
    args.model_dir.mkdir(parents=True, exist_ok=True)
    use_autocast = args.device.lower() == "cuda" or (
        args.device.lower() == "auto" and torch.cuda.is_available()
    )
    separator = Separator(
        log_level=logging.INFO,
        model_file_dir=str(args.model_dir.resolve()),
        output_dir=str(args.output_dir.resolve()),
        output_format="WAV",
        use_autocast=use_autocast,
    )
    separator.load_model(model_filename=args.model)
    returned = separator.separate(str(args.source.resolve()))
    candidates: list[Path] = []
    for item in returned or []:
        candidate = Path(item)
        candidates.append(candidate if candidate.is_absolute() else args.output_dir / candidate)
    candidates.extend(args.output_dir.glob("*.wav"))
    unique = list(dict.fromkeys(path.resolve() for path in candidates if path.exists()))
    vocal, instrumental = identify(unique)
    shutil.copy2(vocal, args.output_dir / "noizzzy_vocals.wav")
    shutil.copy2(instrumental, args.output_dir / "noizzzy_instrumental.wav")


if __name__ == "__main__":
    main()
