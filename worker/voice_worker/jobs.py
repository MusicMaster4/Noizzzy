from __future__ import annotations

import asyncio
import shutil
from datetime import UTC, datetime, timedelta

from .media import JobCancelled
from .models import Job, JobResponse
from .pipeline import VoicePipeline


class JobManager:
    def __init__(
        self,
        pipeline: VoicePipeline,
        ttl_hours: float = 24,
        cleanup_interval_seconds: float | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.ttl_hours = ttl_hours
        self.cleanup_interval_seconds = cleanup_interval_seconds or min(3600, ttl_hours * 1800)
        self.jobs: dict[str, Job] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.cancel_events: dict[str, asyncio.Event] = {}
        self.cleanup_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()

    def start_cleanup_loop(self) -> None:
        if self.ttl_hours <= 0 or self.cleanup_task is not None:
            return
        self.cleanup_task = asyncio.create_task(
            self._cleanup_loop(),
            name="voice-job-cleanup",
        )

    async def _cleanup_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self.cleanup_interval_seconds)
                await self.cleanup_expired()
        except asyncio.CancelledError:
            return

    async def submit(self, job: Job) -> JobResponse:
        await self.cleanup_expired()
        async with self._lock:
            self.jobs[job.id] = job
            event = asyncio.Event()
            self.cancel_events[job.id] = event
            self.tasks[job.id] = asyncio.create_task(self._run(job, event), name=f"voice-job-{job.id}")
            return self._response(job)

    async def _run(self, job: Job, event: asyncio.Event) -> None:
        async def progress(stage: str, value: float) -> None:
            async with self._lock:
                if job.status not in {"cancelled", "cancelling"}:
                    job.status = "processing"
                    job.stage = stage
                    job.progress = max(job.progress, min(value, 0.99))

        try:
            metrics_before, metrics_after, outputs = await self.pipeline.process(job, event, progress)
            async with self._lock:
                if event.is_set():
                    raise JobCancelled("Processamento cancelado")
                job.metrics_before = metrics_before
                job.metrics_after = metrics_after
                job.outputs = outputs
                job.status = "completed"
                job.stage = "completed"
                job.progress = 1.0
        except (JobCancelled, asyncio.CancelledError):
            async with self._lock:
                job.status = "cancelled"
                job.stage = "cancelled"
                job.error = None
        except Exception as exc:  # noqa: BLE001 - job boundary must retain failures for API polling
            async with self._lock:
                job.status = "failed"
                job.stage = "failed"
                job.error = str(exc)

    async def get(self, job_id: str) -> Job | None:
        async with self._lock:
            return self.jobs.get(job_id)

    async def response(self, job_id: str) -> JobResponse | None:
        async with self._lock:
            job = self.jobs.get(job_id)
            return self._response(job) if job else None

    async def cancel(self, job_id: str) -> JobResponse | None:
        async with self._lock:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            if job.status in {"queued", "processing"}:
                job.status = "cancelling"
                job.stage = "cancelling"
                self.cancel_events[job_id].set()
            return self._response(job)

    async def cleanup_expired(self) -> None:
        if self.ttl_hours <= 0:
            return
        cutoff = datetime.now(UTC) - timedelta(hours=self.ttl_hours)
        expired_dirs = []
        async with self._lock:
            for job_id, job in list(self.jobs.items()):
                if job.created_at < cutoff and job.status in {"cancelled", "completed", "failed"}:
                    expired_dirs.append(job.directory)
                    self.jobs.pop(job_id, None)
                    self.tasks.pop(job_id, None)
                    self.cancel_events.pop(job_id, None)
        for directory in expired_dirs:
            shutil.rmtree(directory, ignore_errors=True)

    async def shutdown(self) -> None:
        if self.cleanup_task is not None:
            self.cleanup_task.cancel()
            await asyncio.gather(self.cleanup_task, return_exceptions=True)
            self.cleanup_task = None
        async with self._lock:
            events = list(self.cancel_events.values())
            tasks = list(self.tasks.values())
        for event in events:
            event.set()
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=8)
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    @staticmethod
    def _response(job: Job) -> JobResponse:
        return JobResponse(
            id=job.id,
            status=job.status,
            stage=job.stage,
            progress=job.progress,
            error=job.error,
            input_name=job.input_name,
            input_kind=job.input_kind,
            separate_voice=job.separate_voice,
            created_at=job.created_at,
            metrics_before=job.metrics_before,
            metrics_after=job.metrics_after,
            outputs=job.outputs or None,
        )
