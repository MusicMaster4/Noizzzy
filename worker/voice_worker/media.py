from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from .models import LoudnessMetrics, MasteringProfile


class ProcessingError(RuntimeError):
    pass


class JobCancelled(RuntimeError):
    pass


async def run_command(
    args: list[str],
    *,
    cancel_event: asyncio.Event | None = None,
    cwd: Path | None = None,
) -> tuple[str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            *args,
            cwd=str(cwd) if cwd else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise ProcessingError(f"Executable not found: {args[0]}") from exc

    communicate = asyncio.create_task(process.communicate())
    while not communicate.done():
        if cancel_event and cancel_event.is_set():
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                process.kill()
                await process.wait()
            await communicate
            raise JobCancelled("Processing cancelled")
        await asyncio.sleep(0.15)

    stdout_bytes, stderr_bytes = await communicate
    stdout = stdout_bytes.decode("utf-8", errors="replace")
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    if process.returncode != 0:
        detail = "\n".join(stderr.strip().splitlines()[-12:])
        raise ProcessingError(f"{Path(args[0]).name} failed ({process.returncode}): {detail}")
    return stdout, stderr


async def probe_media(ffprobe: str, source: Path) -> tuple[str, dict[str, Any]]:
    stdout, _ = await run_command(
        [
            ffprobe,
            "-v", "error",
            "-show_entries", "format=duration:stream=index,codec_type,sample_rate,channels",
            "-of", "json",
            str(source),
        ]
    )
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise ProcessingError("The file did not return valid media metadata") from exc
    streams = payload.get("streams", [])
    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    if not has_audio:
        raise ProcessingError("The file does not contain an audio track")
    kind = "video" if any(stream.get("codec_type") == "video" for stream in streams) else "audio"
    return kind, payload


def _last_loudnorm_json(stderr: str) -> dict[str, Any]:
    candidates = re.findall(r"\{\s*\"input_i\".*?\}", stderr, flags=re.DOTALL)
    if not candidates:
        raise ProcessingError("FFmpeg did not return the expected loudness metrics")
    try:
        return json.loads(candidates[-1])
    except json.JSONDecodeError as exc:
        raise ProcessingError("Invalid loudness metrics") from exc


def _float_or_none(value: Any) -> float | None:
    try:
        result = float(value)
        return result if result not in {float("inf"), float("-inf")} else None
    except (TypeError, ValueError):
        return None


async def analyze_loudness(
    ffmpeg: str,
    ffprobe: str,
    source: Path,
    *,
    cancel_event: asyncio.Event | None = None,
) -> LoudnessMetrics:
    _, stderr = await run_command(
        [
            ffmpeg, "-hide_banner", "-nostdin", "-i", str(source),
            "-af", "loudnorm=I=-23:LRA=7:TP=-1:print_format=json",
            "-f", "null", "-",
        ],
        cancel_event=cancel_event,
    )
    measured = _last_loudnorm_json(stderr)
    _, probe = await probe_media(ffprobe, source)
    audio = next((s for s in probe.get("streams", []) if s.get("codec_type") == "audio"), {})
    return LoudnessMetrics(
        integrated_lufs=_float_or_none(measured.get("input_i")),
        true_peak_dbtp=_float_or_none(measured.get("input_tp")),
        loudness_range_lu=_float_or_none(measured.get("input_lra")),
        threshold_lufs=_float_or_none(measured.get("input_thresh")),
        duration_seconds=_float_or_none(probe.get("format", {}).get("duration")),
        sample_rate_hz=int(audio["sample_rate"]) if audio.get("sample_rate") else None,
        channels=int(audio["channels"]) if audio.get("channels") else None,
    )


async def normalize_two_pass(
    ffmpeg: str,
    ffprobe: str,
    source: Path,
    destination: Path,
    profile: MasteringProfile,
    *,
    cancel_event: asyncio.Event | None = None,
) -> tuple[LoudnessMetrics, LoudnessMetrics]:
    before = await analyze_loudness(ffmpeg, ffprobe, source, cancel_event=cancel_event)
    _, stderr = await run_command(
        [
            ffmpeg, "-hide_banner", "-nostdin", "-i", str(source),
            "-af",
            (
                f"loudnorm=I={profile.integrated_lufs}:LRA={profile.loudness_range_lu}:"
                f"TP={profile.true_peak_dbtp}:print_format=json"
            ),
            "-f", "null", "-",
        ],
        cancel_event=cancel_event,
    )
    measured = _last_loudnorm_json(stderr)
    required = ["input_i", "input_tp", "input_lra", "input_thresh", "target_offset"]
    if any(_float_or_none(measured.get(key)) is None for key in required):
        raise ProcessingError("The audio is silent or could not be normalized with EBU R128")
    loudnorm = (
        f"loudnorm=I={profile.integrated_lufs}:LRA={profile.loudness_range_lu}:TP={profile.true_peak_dbtp}:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured['target_offset']}:linear=true:print_format=summary"
    )
    await run_command(
        [
            ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(source),
            "-af", loudnorm,
            "-ar", "48000", "-c:a", "pcm_s24le", str(destination),
        ],
        cancel_event=cancel_event,
    )
    after = await analyze_loudness(ffmpeg, ffprobe, destination, cancel_event=cancel_event)
    return before, after


async def normalize_transparent(
    ffmpeg: str,
    ffprobe: str,
    source: Path,
    destination: Path,
    profile: MasteringProfile,
    before: LoudnessMetrics,
    *,
    cancel_event: asyncio.Event | None = None,
) -> LoudnessMetrics:
    """Adjust gain without denoising, compression, limiting, or changing the stereo image."""
    if before.integrated_lufs is None or before.true_peak_dbtp is None:
        raise ProcessingError("The audio is silent or could not be mastered transparently")

    loudness_gain = profile.integrated_lufs - before.integrated_lufs
    peak_safe_gain = profile.true_peak_dbtp - before.true_peak_dbtp
    gain_db = min(loudness_gain, peak_safe_gain)
    await run_command(
        [
            ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(source),
            "-map", "0:a:0", "-vn", "-af", f"volume={gain_db:.6f}dB",
            "-ar", "48000", "-c:a", "pcm_s24le", str(destination),
        ],
        cancel_event=cancel_event,
    )
    return await analyze_loudness(ffmpeg, ffprobe, destination, cancel_event=cancel_event)
