from __future__ import annotations

import asyncio
import importlib
import logging
import re
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import quote

from .config import Settings
from .media import (
    JobCancelled,
    ProcessingError,
    analyze_loudness,
    normalize_transparent,
    normalize_two_pass,
    run_command,
)
from .models import PROFILES, Job, LoudnessMetrics, OutputInfo

ProgressCallback = Callable[[str, float], Awaitable[None]]


class VoicePipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    async def process(
        self,
        job: Job,
        cancel_event: asyncio.Event,
        progress: ProgressCallback,
    ) -> tuple[LoudnessMetrics, LoudnessMetrics, list[OutputInfo]]:
        work = job.directory / "work"
        work.mkdir(exist_ok=True)

        extracted = work / "source_audio.wav"
        await progress("extracting_audio", 0.08)
        await run_command(
            [
                self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin",
                "-i", str(job.source_path), "-vn", "-map", "0:a:0",
                "-ar", "44100" if job.separate_voice else "48000",
                "-c:a", "pcm_f32le", str(extracted),
            ],
            cancel_event=cancel_event,
        )
        metrics_before = await analyze_loudness(
            self.settings.ffmpeg,
            self.settings.ffprobe,
            extracted,
            cancel_event=cancel_event,
        )

        separated_instrumental: Path | None = None
        if job.separate_voice:
            separated_dir = work / "separated"
            separated_dir.mkdir(exist_ok=True)
            await progress("separating_voice_mel_band_roformer", 0.24)
            separated_voice, separated_instrumental = await self._separate(
                extracted, separated_dir, cancel_event, progress
            )
        else:
            await progress("using_uploaded_voice_directly", 0.24)
            separated_voice = extracted

        if job.separate_voice:
            await progress("enhancing_voice_mossformer2_48k", 0.58)
            enhanced = work / "enhanced.wav"
            await self._enhance(separated_voice, enhanced, cancel_event, progress)

            await progress("mastering_dialogue_dsp", 0.70)
            prepared = work / "master_prepared.wav"
            await run_command(
                [
                    self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(enhanced),
                    "-af",
                    (
                        "highpass=f=75,deesser=i=0.12:m=0.35:f=0.5,"
                        "acompressor=threshold=-18dB:ratio=2.5:attack=15:release=120:knee=2.8:makeup=1.2"
                    ),
                    "-ar", "48000", "-c:a", "pcm_f32le", str(prepared),
                ],
                cancel_event=cancel_event,
            )
        else:
            await progress("preserving_ready_voice", 0.58)
            prepared = extracted

        await progress("normalizing_ebu_r128_pass_1", 0.76)
        safe_stem = Path(job.input_name).stem[:80] or "audio"
        final_audio = job.directory / f"{safe_stem}_noizzzy_{job.profile}.wav"
        if job.separate_voice:
            _, metrics_after = await normalize_two_pass(
                self.settings.ffmpeg,
                self.settings.ffprobe,
                prepared,
                final_audio,
                PROFILES[job.profile],
                cancel_event=cancel_event,
            )
        else:
            metrics_after = await normalize_transparent(
                self.settings.ffmpeg,
                self.settings.ffprobe,
                prepared,
                final_audio,
                PROFILES[job.profile],
                metrics_before,
                cancel_event=cancel_event,
            )

        outputs = [self._output(job, final_audio, "audio", "audio/wav")]
        if separated_instrumental is not None:
            await progress("exporting_instrumental", 0.86)
            final_instrumental = job.directory / f"{safe_stem}_without_voice.wav"
            await run_command(
                [
                    self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin",
                    "-i", str(separated_instrumental),
                    "-ar", "48000", "-c:a", "pcm_s24le", str(final_instrumental),
                ],
                cancel_event=cancel_event,
            )
            outputs.append(self._output(job, final_instrumental, "instrumental", "audio/wav"))
        if job.input_kind == "video":
            await progress("remuxing_video", 0.91)
            final_video = job.directory / f"{safe_stem}_noizzzy_{job.profile}.mp4"
            await self._remux_video(job.source_path, final_audio, final_video, cancel_event)
            outputs.append(self._output(job, final_video, "video", "video/mp4"))

        await progress("finalizing", 0.98)
        shutil.rmtree(work, ignore_errors=True)
        return metrics_before, metrics_after, outputs

    async def _separate(
        self,
        source: Path,
        output_dir: Path,
        cancel_event: asyncio.Event,
        progress: ProgressCallback,
    ) -> tuple[Path, Path]:
        try:
            if self.settings.separator_python:
                runner = self.settings.separator_runner or Path(__file__).with_name("separator_bridge.py")
                await run_command(
                    [
                        str(self.settings.separator_python),
                        str(runner),
                        str(source),
                        str(output_dir),
                        str(self.settings.model_dir),
                        self.settings.separator_model,
                        self.settings.separator_device,
                    ],
                    cancel_event=cancel_event,
                )
                result = (
                    output_dir / "noizzzy_vocals.wav",
                    output_dir / "noizzzy_instrumental.wav",
                )
                if not all(path.is_file() and path.stat().st_size for path in result):
                    raise ProcessingError("O separador isolado não produziu os dois stems esperados")
            else:
                result = await asyncio.to_thread(self._run_audio_separator, source, output_dir)
            if cancel_event.is_set():
                raise JobCancelled("Processamento cancelado")
            return result
        except JobCancelled:
            raise
        except Exception as exc:
            if not self.settings.allow_development_fallback:
                raise ProcessingError(
                    "Mel-Band RoFormer indisponível. Instale o extra 'separation' e confirme o modelo "
                    f"{self.settings.separator_model!r}. Fallback de desenvolvimento está desativado. "
                    f"Detalhe: {exc}"
                ) from exc
            logging.getLogger(__name__).warning("Usando fallback de separação apenas para desenvolvimento: %s", exc)
            await progress("development_fallback_no_stem_separation", 0.42)
            destination = output_dir / "vocals_development_fallback.wav"
            await run_command(
                [
                    self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(source),
                    "-af", "highpass=f=70,lowpass=f=12000",
                    "-ar", "44100", "-c:a", "pcm_f32le", str(destination),
                ],
                cancel_event=cancel_event,
            )
            instrumental = output_dir / "instrumental_development_fallback.wav"
            await run_command(
                [
                    self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin",
                    "-i", str(source), "-i", str(destination),
                    "-filter_complex", "[0:a][1:a]amix=inputs=2:weights='1 -1':normalize=0",
                    "-ar", "44100", "-c:a", "pcm_f32le", str(instrumental),
                ],
                cancel_event=cancel_event,
            )
            return destination, instrumental

    def _run_audio_separator(self, source: Path, output_dir: Path) -> tuple[Path, Path]:
        # Keep optional multi-gigabyte ML dependencies out of the core desktop sidecar.
        # The Electron runtime normally invokes separator_bridge.py in its isolated env.
        torch = importlib.import_module("".join(("to", "rch")))
        separator_module = importlib.import_module("".join(("audio_", "separator", ".separator")))
        Separator = separator_module.Separator

        requested_device = self.settings.separator_device.lower()
        use_autocast = requested_device == "cuda" or (
            requested_device == "auto" and torch.cuda.is_available()
        )

        self.settings.model_dir.mkdir(parents=True, exist_ok=True)
        separator = Separator(
            log_level=logging.INFO,
            model_file_dir=str(self.settings.model_dir.resolve()),
            output_dir=str(output_dir),
            output_format="WAV",
            use_autocast=use_autocast,
        )
        separator.load_model(model_filename=self.settings.separator_model)
        returned = separator.separate(str(source))
        paths: list[Path] = []
        for item in returned or []:
            candidate = Path(item)
            paths.append(candidate if candidate.is_absolute() else output_dir / candidate)
        paths.extend(output_dir.glob("*.wav"))
        unique = list(dict.fromkeys(path.resolve() for path in paths if path.exists()))
        return self._identify_separated_stems(unique)

    @staticmethod
    def _identify_separated_stems(paths: list[Path]) -> tuple[Path, Path]:
        def stem_label(path: Path) -> str | None:
            labels = re.findall(r"_\(([^)]+)\)(?:_|\.)", path.name.lower())
            return labels[-1] if labels else None

        labelled = [(path, stem_label(path)) for path in paths]
        vocal = next((path for path, label in labelled if label in {"vocal", "vocals"}), None)
        instrumental = next(
            (
                path for path, label in labelled
                if label in {"instrumental", "other", "no_vocal", "no_vocals", "accompaniment"}
            ),
            None,
        )
        remaining = [path for path in paths if path != vocal]
        if instrumental is None and len(remaining) == 1:
            instrumental = remaining[0]
        if vocal is None or instrumental is None or vocal == instrumental:
            raise ProcessingError("audio-separator não produziu os stems de voz e instrumental esperados")
        return vocal, instrumental

    async def _enhance(
        self,
        source: Path,
        destination: Path,
        cancel_event: asyncio.Event,
        progress: ProgressCallback,
    ) -> None:
        try:
            if self.settings.enhancer_python:
                runner = self.settings.enhancer_runner or Path(__file__).with_name("enhancer_bridge.py")
                await run_command(
                    [
                        str(self.settings.enhancer_python),
                        str(runner),
                        str(source),
                        str(destination),
                        self.settings.enhancer_model,
                    ],
                    cancel_event=cancel_event,
                )
            else:
                await asyncio.to_thread(self._run_clearer_voice, source, destination)
            if cancel_event.is_set():
                raise JobCancelled("Processamento cancelado")
            if not destination.exists() or destination.stat().st_size == 0:
                raise ProcessingError("ClearerVoice não produziu o WAV esperado")
        except JobCancelled:
            raise
        except Exception as exc:
            if not self.settings.allow_development_fallback:
                raise ProcessingError(
                    "MossFormer2_SE_48K indisponível. Instale ClearerVoice-Studio e seus pesos. "
                    f"Fallback de desenvolvimento está desativado. Detalhe: {exc}"
                ) from exc
            logging.getLogger(__name__).warning("Usando fallback de enhancement apenas para desenvolvimento: %s", exc)
            await progress("development_fallback_ffmpeg_enhancement", 0.66)
            await run_command(
                [
                    self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin", "-i", str(source),
                    "-af",
                    (
                        "highpass=f=70,lowpass=f=14000,afftdn=nr=10:nf=-35:tn=1,"
                        "acompressor=threshold=-18dB:ratio=2.5:attack=10:release=100:makeup=2"
                    ),
                    "-ar", "48000", "-c:a", "pcm_s24le", str(destination),
                ],
                cancel_event=cancel_event,
            )

    def _run_clearer_voice(self, source: Path, destination: Path) -> None:
        clearer_module = importlib.import_module("".join(("clear", "voice")))
        ClearVoice = clearer_module.ClearVoice

        clearer = ClearVoice(task="speech_enhancement", model_names=[self.settings.enhancer_model])
        output = clearer(input_path=str(source), online_write=False)
        clearer.write(output, output_path=str(destination))

    async def _remux_video(
        self,
        video: Path,
        audio: Path,
        destination: Path,
        cancel_event: asyncio.Event,
    ) -> None:
        common = [
            self.settings.ffmpeg, "-y", "-hide_banner", "-nostdin",
            "-i", str(video), "-i", str(audio),
            "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "0",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart",
        ]
        try:
            await run_command(common + ["-c:v", "copy", str(destination)], cancel_event=cancel_event)
        except ProcessingError:
            destination.unlink(missing_ok=True)
            await run_command(
                common + ["-c:v", "libx264", "-preset", "medium", "-crf", "18", str(destination)],
                cancel_event=cancel_event,
            )

    @staticmethod
    def _output(job: Job, path: Path, kind: str, mime: str) -> OutputInfo:
        return OutputInfo(
            kind=kind,  # type: ignore[arg-type]
            name=path.name,
            mime=mime,
            size=path.stat().st_size,
            url=f"/api/jobs/{job.id}/outputs/{quote(path.name)}",
        )
