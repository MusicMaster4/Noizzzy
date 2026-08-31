"use client";

import {
  ArrowDownToLine, AudioLines, Check, ChevronRight, CircleStop, FileAudio,
  FileVideo, Gauge, LoaderCircle, Pause, Play, Radio, RefreshCw, RotateCcw,
  ShieldCheck, Sparkles, Upload, Volume2, WandSparkles, X,
} from "lucide-react";
import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type Profile = "streaming" | "broadcast";
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
const ACCEPTED = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/flac", "audio/ogg", "video/mp4", "video/quicktime", "video/webm", "video/x-matroska"];
const allStages = [
  { key: "prepar", label: "Preparando mídia" }, { key: "extract", label: "Extraindo áudio" },
  { key: "separ", label: "Isolando voz" }, { key: "enhanc", label: "Restaurando detalhes" },
  { key: "master", label: "Nivelando e finalizando" }, { key: "export", label: "Gerando downloads" },
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
function outputLabel(kind: string) {
  if (kind === "video") return "Vídeo com voz limpa";
  if (kind === "instrumental") return "Áudio sem voz";
  return "Voz limpa";
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
    if (item.key === "extract") return { key: "extract", label: "Preparando áudio" };
    if (item.key === "enhanc") return { key: "ready", label: "Preservando voz" };
    return item;
  });
}

function StageRail({ job }: { job: Job }) {
  const stages = jobStages(job); const current = Math.max(0, stages.findIndex((item) => item.key === stageKey(job.stage)));
  return <ol className="stage-rail" aria-label="Etapas do processamento">{stages.map((item, index) => {
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
  return <section className="player-panel" aria-label="Comparação de áudio">
    <audio ref={beforeRef} src={before} preload="metadata" muted={active !== "before"} onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} />
    <audio ref={afterRef} src={after} preload="metadata" muted={active !== "after"} onTimeUpdate={(event) => { if (active === "after") setPosition(event.currentTarget.currentTime); }} onEnded={() => setPlaying(false)} />
    <div className="player-topline"><div><span className="eyebrow">MONITOR A/B</span><h3>Ouça o que permaneceu</h3></div>
      <div className="ab-switch" role="group" aria-label="Fonte de áudio"><button className={active === "before" ? "selected" : ""} onClick={() => switchSide("before")}>Antes</button><button className={active === "after" ? "selected" : ""} onClick={() => switchSide("after")}>Depois</button></div>
    </div>
    <div className={`waveform ${active}`} aria-hidden="true">{bars.map((height, index) => <span key={index} style={{ height: `${height}%` }} />)}</div>
    <div className="transport"><button className="play-button" onClick={togglePlay} aria-label={playing ? "Pausar" : "Reproduzir"}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button><span className="timecode">{clock(position)}</span><input aria-label="Posição do áudio" type="range" min={0} max={duration || 1} step=".05" value={Math.min(position, duration || 1)} onChange={(event) => seek(Number(event.target.value))} /><span className="timecode">{clock(duration)}</span><Volume2 size={17} /></div>
  </section>;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null); const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [file, setFile] = useState<File | null>(null); const [profile, setProfile] = useState<Profile>("streaming");
  const [separateVoice, setSeparateVoice] = useState(true);
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
    if (candidate.size > MAX_BYTES) return "O arquivo ultrapassa o limite de 5 GB.";
    if (!ACCEPTED.includes(candidate.type) && !/\.(wav|mp3|m4a|aac|flac|ogg|mp4|mov|webm|mkv)$/i.test(candidate.name)) return "Formato não reconhecido. Envie WAV, MP3, FLAC, M4A, MP4, MOV, WebM ou MKV.";
    return null;
  }
  function choose(candidate?: File) { if (!candidate) return; const issue = validate(candidate); if (issue) { setError(issue); return; } setError(null); setFile(candidate); setJob(null); }
  function onDrop(event: DragEvent<HTMLDivElement>) { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }
  async function refreshJob(id: string) {
    try {
      const response = await fetch(`${API_URL}/api/jobs/${id}`, { cache: "no-store" }); if (!response.ok) throw new Error("Não foi possível consultar o processamento.");
      const fresh = await response.json() as Job; setJob(fresh);
      if (["completed", "failed", "cancelled"].includes(fresh.status) && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    } catch (reason) { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setError(reason instanceof Error ? reason.message : "A conexão com o processador foi interrompida."); }
  }
  async function start() {
    if (!file) return;
    if (separateVoice && runtime && !runtime.ready) { setError("Instale os modelos de IA antes de isolar a voz, ou escolha “Voz já pronta”."); return; }
    setUploading(true); setUploadProgress(0); setError(null); const form = new FormData(); form.append("file", file); form.append("profile", profile); form.append("separate_voice", String(separateVoice));
    try {
      const payload = await new Promise<{ id: string; status: JobStatus; detail?: string }>((resolve, reject) => {
        const request = new XMLHttpRequest(); request.open("POST", `${API_URL}/api/jobs`);
        request.upload.onprogress = (event) => { if (event.lengthComputable) setUploadProgress((event.loaded / event.total) * 100); };
        request.onerror = () => reject(new Error("A conexão com o processador foi interrompida."));
        request.onload = () => {
          let body: { id: string; status: JobStatus; detail?: string };
          try { body = JSON.parse(request.responseText); } catch { reject(new Error("O processador retornou uma resposta inválida.")); return; }
          if (request.status < 200 || request.status >= 300) { reject(new Error(body.detail || "O processador recusou este arquivo.")); return; }
          resolve(body);
        };
        request.send(form);
      });
      setJob({ id: payload.id, status: payload.status, stage: "queued", progress: 0, separate_voice: separateVoice });
      pollRef.current = setInterval(() => refreshJob(payload.id), 900); await refreshJob(payload.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Não foi possível iniciar o processamento."); } finally { setUploading(false); }
  }
  async function cancel() { if (!job) return; await fetch(`${API_URL}/api/jobs/${job.id}`, { method: "DELETE" }); await refreshJob(job.id); }
  async function installRuntime() { if (!window.noizzzy) return; setError(null); const status = await window.noizzzy.installRuntime(); setRuntime(status); if (status.error) setError(status.error); }
  function reset() { if (pollRef.current) clearInterval(pollRef.current); pollRef.current = null; setFile(null); setJob(null); setError(null); if (inputRef.current) inputRef.current.value = ""; }
  const cleanAudio = job?.outputs?.find((output) => output.kind === "audio");
  const originalUrl = absoluteUrl(job?.source_url || (job ? `/api/jobs/${job.id}/source` : "")); const resultUrl = absoluteUrl(cleanAudio?.url);

  return <main className="app-shell">
    <nav className="topbar"><a className="brand" href="#top" aria-label="Noizzzy, início"><span className="brand-mark"><AudioLines size={21} /></span><span>NOI<span>ZZZ</span>Y</span></a><div className={`engine-status ${appInfo?.worker.ready === false ? "offline" : ""}`}><span /> {appInfo?.worker.ready === false ? "PROCESSADOR INDISPONÍVEL" : appInfo?.engineLabel || "PROCESSAMENTO LOCAL · PRIVADO"}</div></nav>
    <div className="workspace" id="top">
      <header className="intro"><span className="eyebrow"><Radio size={14} /> ESTÚDIO DE VOZ</span><h1>Do ruído à <em>presença.</em></h1><p>Isole falas de música e ambiente. Restaure detalhes e finalize o volume com padrões usados em broadcast.</p><div className="signal-line" aria-hidden="true">{Array.from({ length: 9 }).map((_, index) => <span key={index} />)}</div><div className="engine-notes"><div><span>01</span><strong>Mel-Band RoFormer</strong><small>Separação neural de voz</small></div><div><span>02</span><strong>MossFormer2 · 48 kHz</strong><small>Restauração full-band</small></div><div><span>03</span><strong>ITU-R BS.1770</strong><small>Loudness e true peak</small></div></div></header>
      <section className="studio-card">
        <div className="studio-head"><div><span className="eyebrow">NOVA SESSÃO</span><h2>{complete ? "Master final" : busy ? "Processando sinal" : "Envie sua mídia"}</h2></div><span className="session-tag">LOCAL / 001</span></div>
        {!file && <div className={`dropzone ${dragging ? "dragging" : ""}`} role="button" tabIndex={0} onClick={() => inputRef.current?.click()} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") inputRef.current?.click(); }} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
          <input ref={inputRef} type="file" accept="audio/*,video/mp4,video/quicktime,video/webm,.mkv" onChange={(event: ChangeEvent<HTMLInputElement>) => choose(event.target.files?.[0])} /><div className="upload-orbit"><Upload size={29} /></div><h3>Arraste áudio ou vídeo</h3><p>ou clique para escolher do computador</p><div className="format-row">{["WAV", "MP3", "FLAC", "MP4", "MOV", "MKV"].map((item) => <span key={item}>{item}</span>)}</div><small>até 5 GB · o áudio nunca sai desta máquina</small>
        </div>}
        {file && !complete && <><div className="file-card"><div className="file-icon">{file.type.startsWith("video/") ? <FileVideo /> : <FileAudio />}</div><div className="file-info"><strong>{file.name}</strong><span>{file.type.startsWith("video/") ? "Vídeo com faixa de áudio" : "Arquivo de áudio"} · {humanSize(file.size)}</span></div>{!busy && <button className="icon-button" aria-label="Remover arquivo" onClick={reset}><X size={19} /></button>}</div>
          {!busy && <div className="profile-area"><div className="section-label"><span>TRATAMENTO DA ENTRADA</span><small>Escolha se a voz precisa ser isolada</small></div><div className="mode-grid"><button type="button" aria-pressed={separateVoice} className={separateVoice ? "mode-option selected" : "mode-option"} onClick={() => setSeparateVoice(true)}><span className="radio-dot" /><div><strong>Isolar e restaurar voz</strong><small>Para áudio com música, ruído ou outros sons</small></div><AudioLines size={18} /></button><button type="button" aria-pressed={!separateVoice} className={!separateVoice ? "mode-option selected" : "mode-option"} onClick={() => setSeparateVoice(false)}><span className="radio-dot" /><div><strong>Voz já pronta</strong><small>Preserva timbre e efeitos; ajusta somente nível e pico</small></div><WandSparkles size={18} /></button></div><div className="section-label delivery-label"><span>PERFIL DE ENTREGA</span><small>Define loudness e teto de pico</small></div><div className="profile-grid"><button className={profile === "streaming" ? "profile selected" : "profile"} onClick={() => setProfile("streaming")}><span className="radio-dot" /><div><strong>Streaming / Voz pronta</strong><small>−16 LUFS · −1,5 dBTP</small></div><Sparkles size={18} /></button><button className={profile === "broadcast" ? "profile selected" : "profile"} onClick={() => setProfile("broadcast")}><span className="radio-dot" /><div><strong>Broadcast EBU R128</strong><small>−23 LUFS · −1,0 dBTP</small></div><Radio size={18} /></button></div>{separateVoice && runtime && !runtime.ready && <div className="runtime-setup"><div><Gauge size={18} /><span><strong>{runtime.message}</strong><small>{runtime.installing ? `Preparando IA local · ${runtime.progress}%` : "Necessário uma vez; download de aproximadamente 4 GB."}</small></span></div><button type="button" onClick={installRuntime} disabled={runtime.installing}>{runtime.installing ? <><LoaderCircle className="spin" size={15} /> Instalando</> : "Instalar modelos"}</button>{runtime.installing && <div className="runtime-progress"><span style={{ width: `${runtime.progress}%` }} /></div>}</div>}<button className="primary-action" onClick={start} disabled={Boolean(separateVoice && runtime && !runtime.ready)}><WandSparkles size={19} /> {separateVoice ? "Isolar e finalizar voz" : "Finalizar sem alterar o timbre"} <ChevronRight size={19} /></button></div>}
          {uploading && !job && <div className="processing" aria-live="polite"><div className="progress-copy"><div><LoaderCircle className="spin" /><span><strong>Transferindo para o worker local</strong><small>O arquivo permanece nesta máquina.</small></span></div><b>{Math.round(uploadProgress)}%</b></div><div className="progress-track"><span style={{ width: `${uploadProgress}%` }} /></div></div>}
          {busy && job && <div className="processing" aria-live="polite"><div className="progress-copy"><div><LoaderCircle className="spin" /><span><strong>{job.status === "cancelling" ? "Cancelando com segurança" : jobStages(job).find((item) => item.key === stageKey(job.stage))?.label || "Preparando mídia"}</strong><small>Os modelos trabalham no sinal sem enviar o arquivo para a nuvem.</small></span></div><b>{Math.round(progressPercent(job.progress))}%</b></div><div className="progress-track"><span style={{ width: `${progressPercent(job.progress)}%` }} /></div><StageRail job={job} /><button className="cancel-button" onClick={cancel} disabled={job.status === "cancelling"}><CircleStop size={16} /> {job.status === "cancelling" ? "Cancelando…" : "Cancelar processamento"}</button></div>}
        </>}
        {error && <div className="error-notice" role="alert"><CircleStop size={19} /><div><strong>Não foi possível continuar</strong><span>{error}</span></div>{file && !busy && <button onClick={start}><RefreshCw size={15} /> Tentar novamente</button>}</div>}
        {job?.status === "failed" && !error && <div className="error-notice" role="alert"><CircleStop size={19} /><div><strong>O processamento parou</strong><span>{job.error || "Verifique o processador e tente novamente."}</span></div><button onClick={start}><RefreshCw size={15} /> Tentar novamente</button></div>}
        {complete && cleanAudio && <div className="result-area"><div className="success-ribbon"><span><Check size={18} /></span><div><strong>{job.separate_voice === false ? "Voz preservada e finalizada" : "Voz restaurada e finalizada"}</strong><small>{job.separate_voice === false ? "Timbre, efeitos e imagem estéreo preservados; apenas nível e pico foram ajustados." : "Separação, limpeza e loudness concluídos."}</small></div></div><ABPlayer before={originalUrl} after={resultUrl} /><div className="metrics-strip"><div><span>LOUDNESS</span><strong>{metric(job.metrics_after?.integrated_lufs, "LUFS")}</strong><small>{metric(job.metrics_before?.integrated_lufs, "LUFS")} antes</small></div><div><span>TRUE PEAK</span><strong>{metric(job.metrics_after?.true_peak_dbtp, "dBTP")}</strong><small>{metric(job.metrics_before?.true_peak_dbtp, "dBTP")} antes</small></div><div><span>FAIXA DINÂMICA</span><strong>{metric(job.metrics_after?.loudness_range_lu, "LU")}</strong><small>{metric(job.metrics_before?.loudness_range_lu, "LU")} antes</small></div></div><div className="download-list">{job.outputs?.map((output) => <a className="download-card" href={absoluteUrl(output.url)} download key={output.url}><span className="download-icon">{output.kind === "video" ? <FileVideo /> : <FileAudio />}</span><span><strong>{outputLabel(output.kind)}</strong><small>{output.name} · {humanSize(output.size)}</small></span><ArrowDownToLine size={21} /></a>)}</div><button className="reset-button" onClick={reset}><RotateCcw size={16} /> Processar outro arquivo</button></div>}
      </section>
    </div>
    <footer><span><ShieldCheck size={15} /> Processamento local e temporário</span><span><Gauge size={15} /> {appInfo?.acceleration === "cuda" ? "CUDA ATIVO" : appInfo?.platform === "darwin" ? "OTIMIZADO PARA MAC" : "CPU COMPATÍVEL"}</span><span>Arquivos removidos automaticamente após 24 h</span></footer>
  </main>;
}
