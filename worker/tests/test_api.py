from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi.testclient import TestClient

from voice_worker.config import Settings
from voice_worker.main import create_app, safe_filename
from voice_worker.media import JobCancelled


class WaitingPipeline:
    async def process(self, job, cancel_event: asyncio.Event, progress):
        await progress("test_processing", 0.25)
        while not cancel_event.is_set():
            await asyncio.sleep(0.01)
        raise JobCancelled("cancelled in test")


def test_safe_filename_removes_client_path() -> None:
    assert safe_filename(r"..\..\segredo.wav") == "segredo.wav"
    assert safe_filename("../../fala?.mp3") == "fala_.mp3"


def test_job_contract_source_and_cancel(tmp_path: Path, monkeypatch) -> None:
    async def fake_probe(ffprobe: str, source: Path):
        return "audio", {"streams": [{"codec_type": "audio"}]}

    monkeypatch.setattr("voice_worker.main.probe_media", fake_probe)
    settings = Settings(data_dir=tmp_path, job_ttl_hours=0)
    app = create_app(settings, pipeline=WaitingPipeline())  # type: ignore[arg-type]

    with TestClient(app) as client:
        created = client.post(
            "/api/jobs",
            files={"file": ("../../minha fala.wav", b"RIFF-test", "audio/wav")},
            data={"profile": "broadcast", "separate_voice": "false"},
        )
        assert created.status_code == 202
        body = created.json()
        assert body["status"] in {"queued", "processing"}

        detail = client.get(f"/api/jobs/{body['id']}")
        assert detail.status_code == 200
        assert detail.json()["input_name"] == "minha fala.wav"
        assert detail.json()["input_kind"] == "audio"
        assert detail.json()["separate_voice"] is False

        source = client.get(f"/api/jobs/{body['id']}/source")
        assert source.status_code == 200
        assert source.content == b"RIFF-test"

        cancelled = client.delete(f"/api/jobs/{body['id']}")
        assert cancelled.status_code == 202
        assert cancelled.json()["status"] in {"cancelling", "cancelled"}


def test_rejects_unknown_extension_before_probe(tmp_path: Path) -> None:
    app = create_app(Settings(data_dir=tmp_path), pipeline=WaitingPipeline())  # type: ignore[arg-type]
    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("payload.exe", b"not-media", "application/octet-stream")},
            data={"profile": "streaming"},
        )
    assert response.status_code == 415


def test_rejects_invalid_profile(tmp_path: Path) -> None:
    app = create_app(Settings(data_dir=tmp_path), pipeline=WaitingPipeline())  # type: ignore[arg-type]
    with TestClient(app) as client:
        response = client.post(
            "/api/jobs",
            files={"file": ("voice.wav", b"audio", "audio/wav")},
            data={"profile": "cinema"},
        )
    assert response.status_code == 422
