from __future__ import annotations

import re
import shutil
import unicodedata
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .config import Settings, get_settings
from .jobs import JobManager
from .media import ProcessingError, probe_media
from .models import Job, JobCreated, JobResponse, ProfileName
from .pipeline import VoicePipeline

ALLOWED_SUFFIXES = {
    ".aac", ".aif", ".aiff", ".flac", ".m4a", ".mka", ".mp3", ".ogg", ".opus", ".wav", ".wma",
    ".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv",
}
UPLOAD_CHUNK_BYTES = 1024 * 1024


def safe_filename(name: str | None) -> str:
    raw = Path((name or "upload").replace("\\", "/")).name
    normalized = unicodedata.normalize("NFKC", raw)
    cleaned = re.sub(r"[^\w.() -]", "_", normalized, flags=re.UNICODE).strip(" .")
    return (cleaned or "upload")[:180]


async def stream_upload(upload: UploadFile, destination: Path, max_bytes: int) -> int:
    total = 0
    try:
        with destination.open("xb") as handle:
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                total += len(chunk)
                if total > max_bytes:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=f"File exceeds the {max_bytes // (1024 * 1024)} MB limit",
                    )
                handle.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()
    if total == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty file")
    return total


def create_app(settings: Settings | None = None, pipeline: VoicePipeline | None = None) -> FastAPI:
    configured = settings or get_settings()

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        configured.data_dir.mkdir(parents=True, exist_ok=True)
        application.state.settings = configured
        application.state.manager = JobManager(
            pipeline or VoicePipeline(configured),
            ttl_hours=configured.job_ttl_hours,
        )
        application.state.manager.start_cleanup_loop()
        yield
        await application.state.manager.shutdown()

    application = FastAPI(
        title="Noizzzy Worker",
        version="1.0.1",
        lifespan=lifespan,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=configured.cors_origin_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
    )

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @application.post("/api/jobs", response_model=JobCreated, status_code=status.HTTP_202_ACCEPTED)
    async def create_job(
        request: Request,
        file: Annotated[UploadFile, File(...)],
        profile: Annotated[ProfileName, Form()] = "streaming",
        separate_voice: Annotated[bool, Form()] = True,
    ) -> JobCreated:
        original_name = safe_filename(file.filename)
        suffix = Path(original_name).suffix.lower()
        if suffix not in ALLOWED_SUFFIXES:
            await file.close()
            raise HTTPException(status_code=415, detail=f"Unsupported media extension: {suffix or '(missing)'}")

        job_id = uuid4().hex
        directory = configured.data_dir.resolve() / job_id
        directory.mkdir(parents=True, exist_ok=False)
        source_path = directory / f"source{suffix}"
        try:
            await stream_upload(file, source_path, configured.max_upload_bytes)
            input_kind, _ = await probe_media(configured.ffprobe, source_path)
        except HTTPException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        except ProcessingError as exc:
            shutil.rmtree(directory, ignore_errors=True)
            raise HTTPException(status_code=415, detail=str(exc)) from exc

        job = Job(
            id=job_id,
            input_name=original_name,
            input_kind=input_kind,  # type: ignore[arg-type]
            profile=profile,
            directory=directory,
            source_path=source_path,
            separate_voice=separate_voice,
        )
        response = await request.app.state.manager.submit(job)
        return JobCreated(id=response.id, status=response.status)

    @application.get("/api/jobs/{job_id}", response_model=JobResponse)
    async def get_job(job_id: str, request: Request) -> JobResponse:
        response = await request.app.state.manager.response(job_id)
        if response is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return response

    @application.delete("/api/jobs/{job_id}", response_model=JobResponse, status_code=status.HTTP_202_ACCEPTED)
    async def cancel_job(job_id: str, request: Request) -> JobResponse:
        response = await request.app.state.manager.cancel(job_id)
        if response is None:
            raise HTTPException(status_code=404, detail="Job not found")
        return response

    @application.get("/api/jobs/{job_id}/source")
    async def get_source(job_id: str, request: Request) -> FileResponse:
        job = await request.app.state.manager.get(job_id)
        if job is None or not job.source_path.is_file():
            raise HTTPException(status_code=404, detail="Source not found")
        return FileResponse(
            job.source_path,
            filename=job.input_name,
            content_disposition_type="inline",
        )

    @application.get("/api/jobs/{job_id}/outputs/{output_name}")
    async def get_output(job_id: str, output_name: str, request: Request) -> FileResponse:
        job = await request.app.state.manager.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        output = next((item for item in job.outputs if item.name == output_name), None)
        if output is None:
            raise HTTPException(status_code=404, detail="Output not found")
        path = job.directory / output.name
        if not path.is_file() or path.parent.resolve() != job.directory.resolve():
            raise HTTPException(status_code=404, detail="Output not found")
        return FileResponse(path, filename=output.name, media_type=output.mime)

    return application


app = create_app()
