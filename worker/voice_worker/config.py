from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="VOICE_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    data_dir: Path = Path(".voice-data")
    model_dir: Path = Path("models")
    max_upload_mb: int = 5120
    cors_origins: str = "http://localhost:27295"
    ffmpeg: str = "ffmpeg"
    ffprobe: str = "ffprobe"
    separator_model: str = "vocals_mel_band_roformer.ckpt"
    separator_device: str = "auto"
    separator_python: Path | None = None
    separator_runner: Path | None = None
    enhancer_model: str = "MossFormer2_SE_48K"
    enhancer_python: Path | None = None
    enhancer_runner: Path | None = None
    allow_development_fallback: bool = False
    job_ttl_hours: float = 24

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @property
    def cors_origin_list(self) -> list[str]:
        return [part.strip() for part in self.cors_origins.split(",") if part.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
