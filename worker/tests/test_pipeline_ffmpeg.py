from __future__ import annotations

import asyncio
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from voice_worker.config import Settings
from voice_worker.models import Job
from voice_worker.pipeline import VoicePipeline


def test_separator_uses_stem_label_instead_of_model_name(tmp_path: Path) -> None:
    instrumental = tmp_path / "source_audio_(other)_vocals_mel_band_roformer.wav"
    vocal = tmp_path / "source_audio_(vocals)_vocals_mel_band_roformer.wav"

    selected_vocal, selected_instrumental = VoicePipeline._identify_separated_stems(
        [instrumental, vocal]
    )

    assert selected_vocal == vocal
    assert selected_instrumental == instrumental


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg não instalado")
def test_development_pipeline_produces_mastered_wav(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
            "-filter:a", "volume=0.1", str(source),
        ],
        check=True,
    )
    job = Job(
        id="integration",
        input_name="tone.wav",
        input_kind="audio",
        profile="streaming",
        directory=tmp_path,
        source_path=source,
    )
    pipeline = VoicePipeline(
        Settings(
            data_dir=tmp_path,
            enhancer_python=Path(sys.executable),
            allow_development_fallback=True,
            job_ttl_hours=0,
        )
    )
    monkeypatch.setattr(
        pipeline,
        "_run_audio_separator",
        lambda *_: (_ for _ in ()).throw(RuntimeError("separador ausente no teste")),
    )

    async def run_pipeline():
        stages: list[str] = []

        async def progress(stage: str, value: float) -> None:
            stages.append(stage)

        result = await pipeline.process(job, asyncio.Event(), progress)
        return result, stages

    (before, after, outputs), stages = asyncio.run(run_pipeline())
    assert before.integrated_lufs is not None
    assert after.integrated_lufs == pytest.approx(-16, abs=0.2)
    assert [output.kind for output in outputs] == ["audio", "instrumental"]
    assert all(output.mime == "audio/wav" for output in outputs)
    assert all((tmp_path / output.name).stat().st_size > 1000 for output in outputs)
    assert "development_fallback_no_stem_separation" in stages
    assert "development_fallback_ffmpeg_enhancement" in stages


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg não instalado")
def test_pipeline_skips_separator_for_isolated_voice(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "isolated_voice.wav"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
            "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
            "-filter:a", "volume=0.1", str(source),
        ],
        check=True,
    )
    job = Job(
        id="skip-separation",
        input_name="isolated_voice.wav",
        input_kind="audio",
        profile="streaming",
        directory=tmp_path,
        source_path=source,
        separate_voice=False,
    )
    pipeline = VoicePipeline(
        Settings(
            data_dir=tmp_path,
            enhancer_python=Path(sys.executable),
            allow_development_fallback=True,
            job_ttl_hours=0,
        )
    )
    separator_called = False
    enhancer_called = False

    def unexpected_separator(*_args) -> None:
        nonlocal separator_called
        separator_called = True
        raise AssertionError("o separador não deveria ser chamado")

    monkeypatch.setattr(pipeline, "_run_audio_separator", unexpected_separator)

    async def unexpected_enhancer(*_args) -> None:
        nonlocal enhancer_called
        enhancer_called = True
        raise AssertionError("o restaurador não deveria alterar uma voz já pronta")

    monkeypatch.setattr(pipeline, "_enhance", unexpected_enhancer)

    async def run_pipeline():
        stages: list[str] = []

        async def progress(stage: str, value: float) -> None:
            stages.append(stage)

        result = await pipeline.process(job, asyncio.Event(), progress)
        return result, stages

    (_, after, outputs), stages = asyncio.run(run_pipeline())
    assert separator_called is False
    assert enhancer_called is False
    assert after.integrated_lufs == pytest.approx(-16, abs=0.2)
    assert [output.kind for output in outputs] == ["audio"]
    assert "using_uploaded_voice_directly" in stages
    assert "preserving_ready_voice" in stages
    assert not any("separat" in stage for stage in stages)
    assert not any("enhanc" in stage for stage in stages)


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="FFmpeg não instalado")
def test_mp4_produces_clean_audio_and_video_with_replaced_audio(tmp_path: Path) -> None:
    source = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:d=0.8:r=24",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.8",
            "-filter:a", "volume=0.1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(source),
        ],
        check=True,
    )
    job = Job(
        id="video",
        input_name="clip.mp4",
        input_kind="video",
        profile="streaming",
        directory=tmp_path,
        source_path=source,
        separate_voice=False,
    )
    pipeline = VoicePipeline(Settings(data_dir=tmp_path, job_ttl_hours=0))

    async def run_pipeline():
        stages: list[str] = []

        async def progress(stage: str, value: float) -> None:
            stages.append(stage)

        result = await pipeline.process(job, asyncio.Event(), progress)
        return result, stages

    (_, after, outputs), stages = asyncio.run(run_pipeline())
    assert after.integrated_lufs == pytest.approx(-16, abs=0.2)
    assert [output.kind for output in outputs] == ["audio", "video"]
    assert [output.mime for output in outputs] == ["audio/wav", "video/mp4"]
    assert "remuxing_video" in stages

    final_video = tmp_path / outputs[1].name
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "stream=codec_type",
            "-of", "default=noprint_wrappers=1:nokey=1", str(final_video),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert probe.stdout.splitlines() == ["video", "audio"]
    assert final_video.stat().st_size > 1000
