from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

ProfileName = Literal["streaming", "broadcast"]
JobStatus = Literal["queued", "processing", "cancelling", "cancelled", "completed", "failed"]


@dataclass(frozen=True)
class MasteringProfile:
    integrated_lufs: float
    true_peak_dbtp: float
    loudness_range_lu: float = 7.0


PROFILES: dict[ProfileName, MasteringProfile] = {
    "streaming": MasteringProfile(integrated_lufs=-16.0, true_peak_dbtp=-1.5),
    "broadcast": MasteringProfile(integrated_lufs=-23.0, true_peak_dbtp=-1.0),
}


class LoudnessMetrics(BaseModel):
    integrated_lufs: float | None = None
    true_peak_dbtp: float | None = None
    loudness_range_lu: float | None = None
    threshold_lufs: float | None = None
    duration_seconds: float | None = None
    sample_rate_hz: int | None = None
    channels: int | None = None


class OutputInfo(BaseModel):
    kind: Literal["audio", "instrumental", "video"]
    name: str
    mime: str
    size: int
    url: str


class JobResponse(BaseModel):
    id: str
    status: JobStatus
    stage: str
    progress: float
    error: str | None = None
    input_name: str
    input_kind: Literal["audio", "video"]
    separate_voice: bool
    created_at: datetime
    metrics_before: LoudnessMetrics | None = None
    metrics_after: LoudnessMetrics | None = None
    outputs: list[OutputInfo] | None = None


class JobCreated(BaseModel):
    id: str
    status: JobStatus


@dataclass
class Job:
    id: str
    input_name: str
    input_kind: Literal["audio", "video"]
    profile: ProfileName
    directory: Path
    source_path: Path
    separate_voice: bool = True
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    status: JobStatus = "queued"
    stage: str = "queued"
    progress: float = 0.0
    error: str | None = None
    metrics_before: LoudnessMetrics | None = None
    metrics_after: LoudnessMetrics | None = None
    outputs: list[OutputInfo] = field(default_factory=list)
