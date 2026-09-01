"use client";

import {
  ArrowDownToLine, AudioLines, Check, ChevronRight, CircleStop, FileAudio, FileVideo,
  Gauge, LoaderCircle, Pause, Play, Radio, RefreshCw, RotateCcw,
  ShieldCheck, Upload, Volume2, WandSparkles, X,
} from "lucide-react";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type JobStatus = "queued" | "processing" | "cancelling" | "completed" | "failed" | "cancelled";
type AudioMetrics = { integrated_lufs?: number | null; true_peak_dbtp?: number | null; loudness_range_lu?: number | null };
type OutputFile = { kind: string; name: string; mime: string; size: number; url: string };
type Job = {
  id: string; status: JobStatus; stage: string; progress: number; error?: string | null;
  input_name?: string; input_kind?: "audio" | "video"; source_url?: string; separate_voice?: boolean;
  metrics_before?: AudioMetrics | null; metrics_after?: AudioMetrics | null; outputs?: OutputFile[];
};

type RuntimeStatus = { ready: boolean; installing: boolean; progress: number; message: string; error?: string | null };
type AppInfo = {
  name: string; version: string; platform: string; arch: string; acceleration: string; engineLabel: string;
  worker: { ready: boolean; message?: string; error?: string | null };
};
type NoizzzyDesktop = {
  getAppInfo: () => Promise<AppInfo>;
  getRuntimeStatus: () => Promise<RuntimeStatus>;
  installRuntime: () => Promise<RuntimeStatus>;
  onRuntimeStatus: (callback: (status: RuntimeStatus) => void) => () => void;
  onWorkerStatus: (callback: (status: AppInfo["worker"]) => void) => () => void;
};

declare global { interface Window { noizzzy?: NoizzzyDesktop } }

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") || "http://localhost:35592";
const MAX_BYTES = 5 * 1024 * 1024 * 1024;
const AUTOMATIC_PROFILE = "streaming";
const AUTOMATIC_SEPARATION = true;
const ACCEPTED = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/flac", "audio/ogg", "audio/opus", "audio/aiff", "audio/x-aiff", "video/mp4"];
const allStages = [
  { key: "prepar", label: "Preparing media" }, { key: "extract", label: "Extracting audio" },
  { key: "separ", label: "Isolating voice" }, { key: "enhanc", label: "Restoring detail" },
  { key: "master", label: "Leveling and mastering" }, { key: "export", label: "Generating downloads" },
];

function humanSize(bytes = 0) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}
function clock(value: number) { return Number.isFinite(value) ? `${Math.floor(value / 60)}:${Math.floor(value % 60).toString().padStart(2, "0")}` : "0:00"; }
function metric(value: number | null | undefined, suffix: string) { return value == null || !Number.isFinite(value) ? "—" : `${value.toFixed(1)} ${suffix}`; }
function absoluteUrl(url?: string) { return !url ? "" : url.startsWith("http") ? url : `${API_URL}${url.startsWith("/") ? "" : "/"}${url}`; }
function isMp4(file: File) { return file.type === "video/mp4" || /\.mp4$/i.test(file.name); }
function outputLabel(kind: string) {
  if (kind === "instrumental") return "Voice-free audio";
  if (kind === "video") return "Video with clean voice";
  return "Clean voice";
}
function stageKey(stage = "queued") {
  const value = stage.toLowerCase();
  if (value.includes("extract")) return "extract";
  if (value.includes("separ") || value.includes("no_stem")) return "separ";
  if (value.includes("preserving") || value.includes("using_uploaded")) return "ready";
  if (value.includes("enhanc") || value.includes("ffmpeg_enhancement")) return "enhanc";
  if (value.includes("normali") || value.includes("master")) return "master";
  if (value.includes("remux") || value.includes("final") || value.includes("export")) return "export";
  return "prepar";
}
function progressPercent(value = 0) { return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value)); }
function jobStages(job: Job) {
  if (job.separate_voice !== false) return allStages;
  return allStages.filter((item) => item.key !== "separ").map((item) => {
    if (item.key === "extract") return { key: "extract", label: "Preparing audio" };
    if (item.key === "enhanc") return { key: "ready", label: "Preserving voice" };
    return item;
  });
}

function StageRail({ job }: { job: Job }) {
  const stages = jobStages(job); const current = Math.max(0, stages.findIndex((item) => item.key === stageKey(job.stage)));
  return <ol className="stage-rail" aria-label="Processing stages">{stages.map((item, index) => {
    const done = index < current || job.status === "completed";
    const active = index === current && job.status !== "completed";
    return <li className={done ? "done" : active ? "active" : ""} key={item.key}>
      <span className="stage-dot" aria-hidden="true">{done ? <Check size={13} /> : index + 1}</span><span>{item.label}</span>
    </li>;
  })}</ol>;
}

function ABPlayer({ before, after }: { before: string; after: string }) {
  const beforeRef = useRef<HTMLAudioElement>(null); const afterRef = useRef<HTMLAudioElement>(null);
  const [active, setActive] = useState<"before" | "after">("after"); const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0); const [position, setPosition] = useState(0);
  const bars = useMemo(() => Array.from({ length: 54 }, (_, index) => 18 + Math.abs(Math.sin(index * 1.73) * 48 + Math.cos(index * .43) * 22)), []);
  const audios = () => [beforeRef.current, afterRef.current].filter(Boolean) as HTMLAudioElement[];
  async function togglePlay() {
    const refs = audios();
    if (playing) { refs.forEach((audio) => audio.pause()); setPlaying(false); return; }
    refs.forEach((audio) => { audio.currentTime = Math.min(position, duration || position); });
    try { await Promise.all(refs.map((audio) => audio.play())); setPlaying(true); } catch { setPlaying(false); }
  }
  function seek(value: number) { setPosition(value); audios().forEach((audio) => { audio.currentTime = value; }); }
  function switchSide(side: "before" | "after") {
    setActive(side);
    if (beforeRef.current && afterRef.current) { beforeRef.current.muted = side !== "before"; afterRef.current.muted = side !== "after"; }
  }
  return <section className="player-panel" aria-label="Audio comparison">
    <audio ref={beforeRef} src={before} preload="metadata" muted={active !== "before"} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
    <audio ref={afterRef} src={after} preload="metadata" muted={active !== "after"} onTimeUpdate={(event) => { if (active === "after") setPosition(event.currentTarget.currentTime); }} onEnded={() => setPlaying(false)} />
    <div className="player-topline"><div><span className="eyebrow">A/B MONITOR</span><h3>Hear the difference</h3></div>
      <div className="ab-switch" role="group" aria-label="Audio source"><button className={active === "before" ? "selected" : ""} onClick={() => switchSide("before")}>Before</button><button className={active === "after" ? "selected" : ""} onClick={() => switchSide("after")}>After</button></div>
    </div>
    <div className={`waveform ${active}`} aria-hidden="true">{bars.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div>
    <div className="transport"><button className="play-button" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><span className="timecode">{clock(position)}</span><input aria-label="Audio position" type="range" min={0} max={duration || 1} step=".05" value={Math.min(position, duration || 1)} onChange={(event) => seek(Number(event.target.value))} /><span className="timecode">{clock(duration)}</span><Volume2 size={17} /></div>
  </section>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null); const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null); const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragging, setDragging] = useState(false); const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null); const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const busy = uploading || job?.status === "queued" || job?.status === "processing" || job?.status === "cancelling"; const complete = job?.status === "completed";
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);
  useEffect(() => {
    if (!window.noizzzy) return;
    let active = true;
    void Promise.all([window.noizzzy.getAppInfo(), window.noizzzy.getRuntimeStatus()]).then(([info, status]) => {
      if (!active) return;
      setAppInfo(info); setRuntime(status); document.documentElement.dataset.platform = info.platform;
    });
    const offRuntime = window.noizzzy.onRuntimeStatus((status) => { if (active) setRuntime(status); });
    const offWorker = window.noizzzy.onWorkerStatus((status) => { if (active) setAppInfo((current) => current ? { ...current, worker: status } : current); });
    return () => { active = false; offRuntime(); offWorker(); };
  }, []);
  function validate(candidate: File) {
    if (candidate.size > MAX_BYTES) return "This file exceeds the 5 GB limit.";
    if (!ACCEPTED.includes(candidate.type) && !/\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|wma|mp4)$/i.test(candidate.name)) return "Unsupported format. Upload an MP4 video or a WAV, MP3, FLAC, M4A, AAC, OGG, or AIFF audio file.";
    return null;
  }
  function choose(candidate?: File) { if (!candidate) return; const issue = validate(candidate); if (issue) { setError(issue); return; } setError(null); setFile(candidate); setJob(null); }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }
  async function refreshJob(id: string) {
    try {
      const response = await fetch(`${API_URL}/api/jobs/${id}`, { cache: "no-store" }); if (!response.ok) throw new Error("Could not retrieve the processing status.");
      const fresh = await response.json() as Job; setJob(fresh);
      if (["completed", "failed", "cancelled"].includes(fresh.status) && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } catch (reason) { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setError(reason instanceof Error ? reason.message : "The connection to the local processor was interrupted."); }
  }
  async function start() {
    if (!file) return;
    if (runtime && !runtime.ready) { setError("Install the AI models to start automatic cleanup."); return; }
    setUploading(true); setUploadProgress(0); setError(null); const form = new FormData(); form.append("file", file); form.append("profile", AUTOMATIC_PROFILE); form.append("separate_voice", String(AUTOMATIC_SEPARATION));
    try {
      const payload = await new Promise<{ id: string; status: JobStatus; detail?: string }>((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open("POST", `${API_URL}/api/jobs`);
        request.upload.onprogress = (event) => { if (event.lengthComputable) setUploadProgress((event.loaded / event.total) * 100); };
        request.onerror = () => reject(new Error("The connection to the local processor was interrupted."));
        request.onload = () => {
          let body: { id: string; status: JobStatus; detail?: string };
          try { body = JSON.parse(request.responseText); } catch { reject(new Error("The local processor returned an invalid response.")); return; }
          if (request.status < 200 || request.status >= 300) { reject(new Error(body.detail || "The local processor rejected this file.")); return; }
          resolve(body);
        };
        request.send(form);
      });
      setJob({ id: payload.id, status: payload.status, stage: "queued", progress: 0, separate_voice: AUTOMATIC_SEPARATION });
      pollRef.current = setInterval(() => refreshJob(payload.id), 900); await refreshJob(payload.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not start processing."); } finally { setUploading(false); }
  }
  async function cancel() { if (!job) return; await fetch(`${API_URL}/api/jobs/${job.id}`, { method: "DELETE" }); await refreshJob(job.id); }
  async function installRuntime() { if (!window.noizzzy) return; setError(null); const status = await window.noizzzy.installRuntime(); setRuntime(status); if (status.error) setError(status.error); }
  function reset() { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setFile(null); setJob(null); setError(null); if (inputRef.current) inputRef.current.value = ""; }
  const cleanAudio = job?.outputs?.find((output) => output.kind === "audio");
  const originalUrl = absoluteUrl(job?.source_url || (job ? `/api/jobs/${job.id}/source` : "")); const resultUrl = absoluteUrl(cleanAudio?.url);

  return <main className="app-shell">
    <nav className="topbar"><a className="brand" href="#top" aria-label="Noizzzy, home"><span className="brand-mark"><AudioLines size={21} /></span><span>NOI<span>ZZZ</span>Y</span></a><div className={`engine-status ${appInfo?.worker.ready === false ? "offline" : ""}`}><span /> {appInfo?.worker.ready === false ? "PROCESSOR UNAVAILABLE" : appInfo?.engineLabel || "LOCAL PROCESSING · PRIVATE"}</div></nav>
    <div className="workspace" id="top">
      <header className="intro"><span className="eyebrow"><Radio size={14} /> VOICE STUDIO</span><h1>From noise to <em>presence.</em></h1><p>Drop in audio or an MP4 video. Noizzzy removes music and background noise, restores the voice, and delivers streaming-ready loudness.</p><div className="signal-line" aria-hidden="true">{Array.from({ length: 9 }).map((_, index) => <span key={index} />)}</div></header>
      <section className="studio-card">
        <div className="studio-head"><div><span className="eyebrow">NEW SESSION</span><h2>{complete ? "Final master" : busy ? "Processing signal" : "Send your audio"}</h2></div><span className="session-tag">LOCAL / 001</span></div>
        {!file && <div className={`dropzone ${dragging ? "dragging" : ""}`} role="button" tabIndex={0} onClick={() => inputRef.current?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <input ref={inputRef} type="file" accept="audio/*,video/mp4,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.aif,.aiff,.wma,.mp4" onChange={(event: ChangeEvent<HTMLInputElement>) => choose(event.target.files?.[0])} /><div className="upload-orbit"><Upload size={29} /></div><h3>Drop your audio or MP4 here</h3><p>or click to choose from your computer</p><div className="format-row">{["MP4", "WAV", "MP3", "FLAC", "M4A", "AAC", "OGG"].map((item) => <span key={item}>{item}</span>)}</div><small>up to 5 GB · your file never leaves this device</small>
        </div>}
        {file && !complete && <><div className="file-card"><div className="file-icon">{isMp4(file) ? <FileVideo /> : <FileAudio />}</div><div className="file-info"><strong>{file.name}</strong><span>{isMp4(file) ? "MP4 video" : "Audio file"} · {humanSize(file.size)}</span></div>{!busy && <button className="icon-button" aria-label="Remove file" onClick={reset}><X size={19} /></button>}</div>
          {!busy && <div className="automatic-flow"><div className="automatic-plan" aria-label="Automatic settings"><span><WandSparkles size={20} /></span><div><small>AUTOMATIC FLOW</small><strong>Complete streaming cleanup</strong><p>We assume background noise and apply isolation, restoration, and a −16 LUFS master.</p></div><Check size={18} /></div>{runtime && !runtime.ready && <div className="runtime-setup"><div><Gauge size={18} /><span><strong>{runtime.message}</strong><small>{runtime.installing ? `Preparing local AI · ${runtime.progress}%` : "Required once; approximately 4 GB to download."}</small></span></div><button type="button" onClick={installRuntime} disabled={runtime.installing}>{runtime.installing ? <><LoaderCircle className="spin" size={15} /> Installing</> : "Install models"}</button>{runtime.installing && <div className="runtime-progress"><span style={{ width: `${runtime.progress}%` }} /></div>}</div>}<button className="primary-action" onClick={start} disabled={Boolean(runtime && !runtime.ready)}><WandSparkles size={19} /> {isMp4(file) ? "Clean the video audio" : "Clean audio for streaming"} <ChevronRight size={19} /></button></div>}
          {uploading && !job && <div className="processing" aria-live="polite"><div className="progress-copy"><div><LoaderCircle className="spin" /><span><strong>Transferring to the local processor</strong><small>The file stays on this device.</small></span></div><b>{Math.round(uploadProgress)}%</b></div><div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div></div>}
          {busy && job && <div className="processing" aria-live="polite"><div className="progress-copy"><div><LoaderCircle className="spin" /><span><strong>{job.status === "cancelling" ? "Cancelling safely" : jobStages(job).find((item) => item.key === stageKey(job.stage))?.label || "Preparing media"}</strong><small>The models process the signal without sending your file to the cloud.</small></span></div><b>{Math.round(progressPercent(job.progress))}%</b></div><div className="progress-track"><span style={{ width: `${progressPercent(job.progress)}%` }} /></div><StageRail job={job} /><button className="cancel-button" onClick={cancel} disabled={job.status === "cancelling"}><CircleStop size={16} /> {job.status === "cancelling" ? "Cancelling…" : "Cancel processing"}</button></div>}
        </>}
        {error && <div className="error-notice" role="alert"><CircleStop size={19} /><div><strong>Could not continue</strong><span>{error}</span></div>{file && !busy && <button onClick={start}><RefreshCw size={15} /> Try again</button>}</div>}
        {job?.status === "failed" && !error && <div className="error-notice" role="alert"><CircleStop size={19} /><div><strong>Processing stopped</strong><span>{job.error || "Check the local processor and try again."}</span></div><button onClick={start}><RefreshCw size={15} /> Try again</button></div>}
        {complete && cleanAudio && <div className="result-area"><div className="success-ribbon"><span><Check size={18} /></span><div><strong>Voice restored and mastered</strong><small>Separation, cleanup, and streaming loudness are complete.</small></div></div><ABPlayer before={originalUrl} after={resultUrl} /><div className="metrics-strip"><div><span>LOUDNESS</span><strong>{metric(job.metrics_after?.integrated_lufs, "LUFS")}</strong><small>{metric(job.metrics_before?.integrated_lufs, "LUFS")} before</small></div><div><span>TRUE PEAK</span><strong>{metric(job.metrics_after?.true_peak_dbtp, "dBTP")}</strong><small>{metric(job.metrics_before?.true_peak_dbtp, "dBTP")} before</small></div><div><span>DYNAMIC RANGE</span><strong>{metric(job.metrics_after?.loudness_range_lu, "LU")}</strong><small>{metric(job.metrics_before?.loudness_range_lu, "LU")} before</small></div></div><div className="download-list">{job.outputs?.map((output) => <a className="download-card" href={absoluteUrl(output.url)} download key={output.url}><span className="download-icon">{output.kind === "video" ? <FileVideo /> : <FileAudio />}</span><span><strong>{outputLabel(output.kind)}</strong><small>{output.name} · {humanSize(output.size)}</small></span><ArrowDownToLine size={21} /></a>)}</div><button className="reset-button" onClick={reset}><RotateCcw size={16} /> Process another file</button></div>}
      </section>
    </div>
    <footer><span><ShieldCheck size={15} /> Local and temporary processing</span><span><Gauge size={15} /> {appInfo?.acceleration === "cuda" ? "CUDA ACTIVE" : appInfo?.platform === "darwin" ? "OPTIMIZED FOR MAC" : "CPU COMPATIBLE"}</span><span>Files are removed automatically after 24 hours</span></footer>
  </main>;
}
