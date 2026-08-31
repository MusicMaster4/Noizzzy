from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

from voice_worker.config import Settings
from voice_worker.pipeline import VoicePipeline


def test_separator_is_routed_to_isolated_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = tmp_path / "separator_bridge.py"
    settings = Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        separator_python=Path(sys.executable),
        separator_runner=runner,
        separator_device="cpu",
    )
    pipeline = VoicePipeline(settings)
    source = tmp_path / "source.wav"
    source.write_bytes(b"source")
    output = tmp_path / "stems"
    output.mkdir()
    commands: list[list[str]] = []

    async def fake_run(args: list[str], **_kwargs) -> tuple[str, str]:
        commands.append(args)
        (output / "noizzzy_vocals.wav").write_bytes(b"vocals")
        (output / "noizzzy_instrumental.wav").write_bytes(b"instrumental")
        return "", ""

    monkeypatch.setattr("voice_worker.pipeline.run_command", fake_run)
    vocal, instrumental = asyncio.run(
        pipeline._separate(source, output, asyncio.Event(), lambda *_args: asyncio.sleep(0))
    )

    assert vocal.name == "noizzzy_vocals.wav"
    assert instrumental.name == "noizzzy_instrumental.wav"
    assert commands == [[
        sys.executable,
        str(runner),
        str(source),
        str(output),
        str(settings.model_dir),
        settings.separator_model,
        "cpu",
    ]]


def test_enhancer_uses_configured_runner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = tmp_path / "enhancer_bridge.py"
    settings = Settings(
        data_dir=tmp_path / "data",
        model_dir=tmp_path / "models",
        enhancer_python=Path(sys.executable),
        enhancer_runner=runner,
    )
    pipeline = VoicePipeline(settings)
    source = tmp_path / "source.wav"
    destination = tmp_path / "enhanced.wav"
    source.write_bytes(b"source")
    commands: list[list[str]] = []

    async def fake_run(args: list[str], **_kwargs) -> tuple[str, str]:
        commands.append(args)
        destination.write_bytes(b"enhanced")
        return "", ""

    monkeypatch.setattr("voice_worker.pipeline.run_command", fake_run)
    asyncio.run(pipeline._enhance(source, destination, asyncio.Event(), lambda *_args: asyncio.sleep(0)))

    assert commands == [[sys.executable, str(runner), str(source), str(destination), settings.enhancer_model]]
