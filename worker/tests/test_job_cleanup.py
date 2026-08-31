from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

from voice_worker.jobs import JobManager
from voice_worker.models import Job


class UnusedPipeline:
    async def process(self, job, cancel_event, progress):  # pragma: no cover
        raise AssertionError("pipeline should not run")


def test_periodic_cleanup_removes_expired_terminal_job(tmp_path: Path) -> None:
    async def scenario() -> None:
        directory = tmp_path / "expired"
        directory.mkdir()
        (directory / "result.wav").write_bytes(b"old")
        job = Job(
            id="expired",
            input_name="old.wav",
            input_kind="audio",
            profile="streaming",
            directory=directory,
            source_path=directory / "source.wav",
            created_at=datetime.now(UTC) - timedelta(hours=2),
            status="completed",
            stage="completed",
            progress=1,
        )
        manager = JobManager(
            UnusedPipeline(),  # type: ignore[arg-type]
            ttl_hours=1,
            cleanup_interval_seconds=0.01,
        )
        manager.jobs[job.id] = job
        manager.start_cleanup_loop()
        await asyncio.sleep(0.05)
        assert await manager.get(job.id) is None
        assert not directory.exists()
        await manager.shutdown()

    asyncio.run(scenario())

