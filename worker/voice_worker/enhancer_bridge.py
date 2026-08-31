from __future__ import annotations

import argparse
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Isolated ClearerVoice enhancement bridge")
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("model")
    args = parser.parse_args()

    from clearvoice import ClearVoice  # type: ignore[import-not-found]

    clearer = ClearVoice(task="speech_enhancement", model_names=[args.model])
    output = clearer(input_path=str(args.source), online_write=False)
    clearer.write(output, output_path=str(args.destination))


if __name__ == "__main__":
    main()

