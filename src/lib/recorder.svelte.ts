// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL LECTURE-RECORDING ENGINE
//
// Lives OUTSIDE the Recorder view so a recording is a background activity:
// navigating anywhere in the app (or closing the Recorder view) keeps the
// capture running, and the floating RecordingActivity widget mirrors it from
// any screen — the same pattern as the Pomodoro LiveActivity.
//
// Two capture engines, picked automatically:
//   • web    — getUserMedia + MediaRecorder (with the WebKitGTK WAV fallback).
//              Desktop and Android.
//   • native — Tauri commands backed by AVAudioRecorder on iOS. WKWebView's
//              custom-scheme pages aren't a secure context, so
//              navigator.mediaDevices never exists there — getUserMedia can NOT
//              work no matter what permissions are granted. The native recorder
//              also keeps recording with the phone locked / app backgrounded
//              (AVAudioSession + UIBackgroundModes audio), which a webview
//              capture never survives.
// ─────────────────────────────────────────────────────────────────────────────
import * as api from "./api";
import { app } from "./store.svelte";
import { isIOS, isMacOS, isMobile } from "./platform";
import { describeMicrophoneFailure } from "./recorder-errors";
import { hasRecordingInput, recordingInputs } from "./recording-input";
import { formatBilingualTranscript, LiveCaptions, type Caption } from "./live-captions";
import { normalizeLiveAsrProvider } from "./realtime-asr";
import { VoxtralCaptions } from "./vibevoice";
import {
  prepareCaptionAudioCapture,
  startCaptionAudioCapture,
  type CaptionAudioCapture,
} from "./caption-audio";

const SEG_MS = 4000;
// Below this mean |amplitude| (normalized 0-1) a WAV segment is treated as a
// pause and skipped — no whisper call, no UI change.
const SILENCE_RMS = 0.006;

/** Linear-interpolation downsample of one Float32 block to 16 kHz Int16. */
function downsampleTo16k(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / 16000;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const s = input[i0] + (input[i1] - input[i0]) * (pos - i0);
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}

/** Assemble PCM chunks into a complete 16 kHz mono 16-bit WAV file. */
function encodeWav(pcm: Int16Array[]): Uint8Array {
  const total = pcm.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + total * 2);
  const dv = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF"); dv.setUint32(4, 36 + total * 2, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); // PCM, mono
  dv.setUint32(24, 16000, true); dv.setUint32(28, 16000 * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, total * 2, true);
  let off = 44;
  for (const c of pcm) for (let i = 0; i < c.length; i++) { dv.setInt16(off, c[i], true); off += 2; }
  return new Uint8Array(buf);
}

/** Mean |amplitude| (0-1) across PCM blocks, for the silence gate. */
function meanAmplitude(pcm: Int16Array[]): number {
  let sum = 0;
  let n = 0;
  for (const c of pcm) {
    for (let i = 0; i < c.length; i++) sum += Math.abs(c[i]);
    n += c.length;
  }
  return n === 0 ? 0 : sum / n / 32768;
}

class RecorderStore {
  // ---- reactive state (drives the Recorder view AND the floating widget) ----
  recording = $state(false);
  paused = $state(false);
  secs = $state(0);
  status = $state<"ready" | "recording" | "review" | "transcribing" | "done">("ready");
  errorMsg = $state<string | null>(null);
  canOpenMicrophoneSettings = $state(false);
  canOpenSystemAudioSettings = $state(false);
  note = $state("");
  tags = $state<{ at: string }[]>([]);

  // live transcript
  transcriptCollapsed = $state(false);
  translationTarget = $state("zh-CN");
  captions = $state<Caption[]>([]);
  captionError = $state("");
  finishing = $state(false);
  liveBackendText = $state("");
  liveUpdating = $state(false);

  // review & save step
  // reviewBytes/reviewPath are NOT $state: megabytes of audio must never be
  // wrapped in a deep reactive proxy (it makes IPC serialization crawl).
  reviewBytes: Uint8Array = new Uint8Array(0);
  reviewPath = "";      // native (iOS) recordings stay a backend file — no bytes over IPC
  private reviewSavedSourceId = "";
  reviewExt = "webm";
  reviewName = $state("");
  reviewSubjectId = $state("");
  reviewTopicId = $state("");
  /** Per-recording "multiple people speaking" → speaker labels in the transcript. */
  reviewDiarize = $state(true);
  reviewDuration = $state("00:00");
  reviewTranscript = $state("");
  reviewUsesLiveTranscript = $state(false);
  reviewSourceLabel = $state("");

  // waveform inputs: web engine exposes the analyser; native exposes a 0-1 level
  analyser = $state<AnalyserNode | null>(null);
  nativeLevel = $state(0);
  /** True while the native (iOS) engine is the active capture path. */
  native = $state(false);

  // ---- non-reactive machinery ----
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private srcNode: MediaStreamAudioSourceNode | null = null;
  private chunks: Blob[] = [];
  private captureMode: "media" | "wav" = "media";
  private wavProc: ScriptProcessorNode | null = null;
  private wavChunks: Int16Array[] = [];
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private meterPollActive = false;
  liveAsrProvider = $state("whisper");
  private vibevoiceUrl = "http://127.0.0.1:7870";
  private vibevoiceToken = "";
  private captionSession: LiveCaptions | VoxtralCaptions | null = null;
  private captionTimer: ReturnType<typeof setInterval> | null = null;
  private captionCapture: CaptionAudioCapture | null = null;
  private captionPcm: Int16Array[] = [];
  private captionSamples = 0;
  private captionCapturedSamples = 0;
  private captionGeneration = 0;
  private captionHealthTimer: ReturnType<typeof setInterval> | null = null;
  private nativeCaptionCursor = 0;
  private captionStart = 0;
  private liveTranscriptComplete = false;
  private starting = false;

  // ---- derived helpers ----
  get mm(): string { return String(Math.floor(this.secs / 60)).padStart(2, "0"); }
  get ss(): string { return String(this.secs % 60).padStart(2, "0"); }
  get live(): boolean { return this.recording && !this.paused; }
  get liveTranscriptOn(): boolean { return !this.transcriptCollapsed; }


  // ════════════════════════════ lifecycle ════════════════════════════

  async start(): Promise<void> {
    // No new take while one is live OR while the previous one is still being
    // saved/transcribed — a fresh session would trample the in-flight state.
    if (this.starting || this.finishing || this.recording || this.status === "transcribing") return;
    if (!app.activeSubject) {
      app.pushToast({ kind: "error", title: "Open a subject first", body: "Select a subject before recording." });
      return;
    }
    this.errorMsg = null;
    this.canOpenMicrophoneSettings = false;
    this.canOpenSystemAudioSettings = false;
    this.starting = true;
    try {
    const settings = await api.getAllSettings();
    this.liveAsrProvider = normalizeLiveAsrProvider(settings.live_asr_provider);
    this.vibevoiceUrl = settings.vibevoice_url || "http://127.0.0.1:7870";
    this.vibevoiceToken = settings.vibevoice_token || "";
    if (this.liveAsrProvider === "voxtral" && settings.offline_mode === "true" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(new URL(this.vibevoiceUrl).hostname)) {
      this.errorMsg = "Offline mode only allows a local Voxtral server";
      return;
    }
    if (isIOS) return await this.startNative(true, false);
    const [recordMicrophone, recordSystemAudio, runtimePlatform] = await Promise.all([
      api.getSetting("record_microphone").catch(() => null),
      api.getSetting("record_system_audio").catch(() => null),
      api.runtimePlatform().catch(() => (isMacOS ? "macos" : "unknown")),
    ]);
    const inputs = recordingInputs(recordMicrophone, recordSystemAudio, runtimePlatform === "macos");
    if (!hasRecordingInput(inputs)) {
      this.errorMsg = "Select at least one recording input in Settings → Audio.";
      return;
    }
    if (inputs.systemAudio) return await this.startNative(inputs.microphone, inputs.systemAudio);
    return await this.startWeb();
    } catch (error) { this.errorMsg = String(error); }
    finally { this.starting = false; }
  }

  /** Native iOS mic capture or macOS system-audio capture with an optional microphone. */
  private async startNative(includeMicrophone: boolean, includeSystemAudio: boolean): Promise<void> {
    try {
      await api.nativeRecStart(includeMicrophone, includeSystemAudio);
    } catch (e) {
      this.errorMsg = includeMicrophone && includeSystemAudio
        ? "Couldn't start microphone and system audio: " + String(e)
        : includeSystemAudio
          ? "Couldn't start system audio: " + String(e)
          : "Couldn't start the microphone: " + String(e);
      this.canOpenMicrophoneSettings = includeMicrophone;
      this.canOpenSystemAudioSettings = includeSystemAudio;
      return;
    }
    this.native = true;
    this.beginSession();
    this.meterPollActive = true;
    void this.pollNativeMeter();
    if (!isMobile && this.liveTranscriptOn) void this.startCaptions();
  }

  /**
   * Native metering loop. Self-rescheduling (never stacks a second IPC call on
   * a slow round-trip) and cadence-aware: ~8 fps while the Recorder view shows
   * the waveform, a 1 s clock tick anywhere else (only the widget's mm:ss needs
   * it). The sample also carries the recorder's own elapsed time — webview JS
   * timers freeze while the phone is locked, so the UI clock resyncs from it.
   */
  private async pollNativeMeter(): Promise<void> {
    while (this.meterPollActive && this.recording) {
      if (this.live) {
        try {
          const m = await api.nativeRecLevel();
          this.nativeLevel = m.level;
          const authoritative = Math.floor(m.secs);
          if (Math.abs(authoritative - this.secs) > 1) this.secs = authoritative;
        } catch { /* transient IPC hiccup — next tick retries */ }
      }
      await new Promise((r) => setTimeout(r, app.view === "recorder" ? 120 : 1000));
    }
  }

  private async startWeb(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.errorMsg =
        "Microphone capture isn't available in this webview. You can still add a lecture with “Upload an audio file”.";
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const failure = describeMicrophoneFailure(e, isMacOS);
      this.errorMsg = failure.message;
      this.canOpenMicrophoneSettings = failure.canOpenSettings;
      return;
    }
    this.native = false;
    // analyser for the live waveform
    this.audioCtx = new AudioContext();
    this.srcNode = this.audioCtx.createMediaStreamSource(this.stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 256;
    this.srcNode.connect(analyser);
    this.analyser = analyser;

    let captionCaptureError = "";
    if (!isMobile && this.liveTranscriptOn) {
      try { await prepareCaptionAudioCapture(this.audioCtx); }
      catch (error) { captionCaptureError = `Couldn't start reliable live audio capture: ${String(error)}`; }
    }

    this.chunks = [];
    this.wavChunks = [];
    this.captureMode = "media";
    // Ask for a container WebKitGTK claims to support; an unsupported default
    // is one way recordings end up empty.
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      .find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(m));
    try {
      this.mediaRecorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
      this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
      this.mediaRecorder.onstop = () => void this.finalizeWeb();
      this.mediaRecorder.start(1000);
    } catch (err) {
      console.warn("[recorder] MediaRecorder unavailable", err);
      this.mediaRecorder = null;
    }
    this.beginSession();
    if (captionCaptureError) {
      this.liveTranscriptComplete = false;
      this.captionError = captionCaptureError;
    }
    // Watchdog: if MediaRecorder is silently broken (WebKitGTK), no chunk will
    // have arrived a few seconds in — swap engines without losing the session.
    if (this.mediaRecorder) {
      this.watchdog = setTimeout(() => {
        if (this.recording && this.chunks.length === 0) this.switchToWavCapture();
      }, 3500);
    } else {
      this.switchToWavCapture();
    }
    if (!isMobile && this.liveTranscriptOn && !captionCaptureError) void this.startCaptions();
  }

  /** Shared session bootstrap once an engine is capturing. */
  private beginSession(): void {
    this.recording = true;
    this.paused = false;
    this.status = "recording";
    this.secs = 0;
    this.tags = [];
    this.captions = [];
    this.captionError = "";
    this.liveBackendText = "";
    this.liveTranscriptComplete = !isMobile && this.liveTranscriptOn;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { if (this.live) this.secs += 1; }, 1000);
  }

  async togglePause(): Promise<void> {
    if (!this.recording || this.finishing) return;
    try {
      if (this.native) {
        if (this.paused) await api.nativeRecResume();
        else await api.nativeRecPause();
      } else if (this.captureMode === "media") {
        if (this.paused) this.mediaRecorder?.resume();
        else this.mediaRecorder?.pause();
      }
      this.paused = !this.paused;
      if (this.paused) void this.captionSession?.poll();
    } catch (error) { this.errorMsg = String(error); }
  }

  tagMoment(): void {
    if (this.recording) this.tags = [...this.tags, { at: `${this.mm}:${this.ss}` }];
  }

  stop(): void {
    if (!this.recording || this.finishing) return;
    if (this.native) { void this.finalizeNative(); return; }
    if (this.captureMode === "wav") { void this.finalizeWeb(); return; }
    if (!this.mediaRecorder) return;
    this.mediaRecorder.stop(); // triggers onstop → finalizeWeb()
  }

  /** Abort the in-flight recording and throw the audio away. */
  discardRecording(): void {
    if (this.finishing) return;
    this.stopCaptions();
    if (this.native) {
      api.nativeRecCancel().catch(() => {});
    } else if (this.mediaRecorder && this.recording) {
      this.mediaRecorder.onstop = null;
      try { this.mediaRecorder.stop(); } catch { /* noop */ }
    }
    this.cleanupStream();
    this.endTimers();
    this.native = false;
    this.recording = false;
    this.paused = false;
    this.secs = 0;
    this.tags = [];
    this.status = "ready";
    this.liveBackendText = ""; this.captions = []; this.captionError = "";
  }

  private endTimers(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.meterPollActive = false;
    this.nativeLevel = 0;
  }

  private cleanupStream(): void {
    this.detachCaptionCapture();
    if (this.watchdog) { clearTimeout(this.watchdog); this.watchdog = null; }
    if (this.wavProc) { try { this.wavProc.disconnect(); } catch { /* noop */ } this.wavProc = null; }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => {});
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.srcNode = null;
    this.mediaRecorder = null;
  }

  private async finalizeNative(): Promise<void> {
    this.finishing = true;
    try {
      await api.nativeRecPause();
      this.paused = true;
      await this.finishCaptions();
    } catch (error) { this.captionError = String(error); this.stopCaptions(); }
    this.recording = false;
    this.paused = false;
    this.endTimers();
    let res: { path: string; secs: number; ext: string };
    try {
      res = await api.nativeRecStop();
    } catch (e) {
      this.native = false;
      this.errorMsg = "Couldn't finish the recording: " + String(e);
      this.status = "ready";
      return;
    } finally {
      this.finishing = false;
    }
    if (!res.path) {
      this.native = false;
      this.errorMsg = "Nothing was captured — the selected recording inputs produced no audio.";
      this.status = "ready";
      return;
    }
    // Duration from the RECORDER's clock, not this.secs: webview timers freeze
    // while the phone is locked, so the JS count can lag the real length.
    const total = Math.max(0, Math.round(res.secs));
    this.secs = total;
    const dur = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    if (!app.activeSubject) {
      // Nothing to attach the take to — don't leak the temp file on disk.
      api.nativeRecDiscardFile(res.path).catch(() => {});
      this.native = false;
      this.status = "ready";
      return;
    }
    this.reviewBytes = new Uint8Array(0);
    this.reviewPath = res.path;
    this.reviewExt = res.ext || "m4a";
    const transcript = this.liveTranscriptComplete && !this.captionError
      ? this.formattedLiveTranscript()
      : "";
    this.enterReview(`Lecture ${this.stamp()}`, dur, "captured", transcript, !!transcript);
  }

  private async finalizeWeb(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    await this.finishCaptions();
    this.recording = false;
    this.paused = false;
    this.cleanupStream();
    this.endTimers();
    try {
    if (!app.activeSubject) { this.status = "ready"; return; }

    let bytes: Uint8Array;
    if (this.captureMode === "wav") {
      bytes = encodeWav(this.wavChunks);
      this.reviewExt = "wav";
    } else {
      const blob = new Blob(this.chunks, { type: this.chunks[0]?.type || "audio/webm" });
      bytes = new Uint8Array(await blob.arrayBuffer());
      this.reviewExt = "webm";
    }
    if (bytes.length === 0) {
      this.errorMsg = "Nothing was captured — the microphone produced no audio. Check the input device in your system sound settings, then try again.";
      this.status = "ready";
      return;
    }
    const transcript = this.liveTranscriptComplete && !this.captionError
      ? this.formattedLiveTranscript()
      : "";
    this.reviewBytes = bytes;
    this.reviewPath = "";
    this.enterReview(`Lecture ${this.stamp()}`, `${this.mm}:${this.ss}`, "captured", transcript, !!transcript);
    } catch (error) { this.errorMsg = String(error); this.status = "ready"; }
    finally { this.finishing = false; }
  }

  private stamp(): string {
    // A friendly default name, e.g. "Lecture Jun 3, 2:07 PM".
    return new Date().toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
  }

  // ════════════════════════════ review & save ════════════════════════════

  /** Move into the review step (used by both engines and file uploads). */
  enterReview(name: string, duration: string, sourceLabel: string, transcript = "", usesLiveTranscript = false): void {
    const subj = app.activeSubject;
    if (!subj) { this.status = "ready"; return; }
    this.reviewName = name;
    this.reviewDuration = duration;
    this.reviewSourceLabel = sourceLabel;
    this.reviewTranscript = transcript;
    this.reviewUsesLiveTranscript = usesLiveTranscript;
    // Default home: the active subject (changeable on the save screen) and its
    // first topic when it has any, otherwise "no topic".
    this.reviewSubjectId = subj.id;
    this.reviewTopicId = subj.topics[0]?.id ?? "";
    this.reviewDiarize = true;
    this.errorMsg = null;
    this.status = "review";
  }

  /** Retarget the pending recording at another subject (save screen). */
  setReviewSubject(id: string): void {
    if (id === this.reviewSubjectId) return;
    this.reviewSubjectId = id;
    const subj = app.subjects.find((s) => s.id === id);
    this.reviewTopicId = subj?.topics[0]?.id ?? "";
  }

  /** Stash an uploaded audio file and enter review. */
  enterReviewFromUpload(bytes: Uint8Array, name: string, ext: string): void {
    this.reviewBytes = bytes;
    this.reviewPath = "";
    this.reviewExt = ext;
    this.enterReview(name, "—:—", "uploaded");
  }

  async confirmSave(): Promise<void> {
    if (this.status === "transcribing") return;
    const subjId = this.reviewSubjectId || app.activeSubject?.id;
    if (!subjId) { this.status = "ready"; return; }
    const name = this.reviewName.trim() || "Untitled recording";
    const topicId = this.reviewTopicId || undefined;
    const capturedLabel = `${this.reviewDuration} ${this.reviewSourceLabel}`;

    // The save itself is quick now — it persists the audio and queues the
    // transcription on the BACKGROUND worker (homelab/cloud/local per
    // Settings → Transcription), which keeps running with the app minimised or
    // the machine locked. No more blocking "transcribing…" screen.
    this.status = "transcribing";
    this.errorMsg = null;
    try {
      const liveTranscript = this.reviewUsesLiveTranscript ? this.reviewTranscript : undefined;
      if (this.reviewSavedSourceId) {
        await api.commitLiveTranscript(this.reviewSavedSourceId, this.reviewTranscript);
      } else this.reviewPath
        ? await api.saveRecordingPath(subjId, name, this.reviewPath, topicId, this.reviewDiarize, liveTranscript)
        : await api.saveRecordingRaw(subjId, name, this.reviewBytes, topicId, this.reviewExt, this.reviewDiarize, liveTranscript);
      // The take is committed (and the native temp file consumed) — clear the
      // review state NOW so a failure in any post-save step can't bounce the
      // user back to a review whose audio no longer exists.
      this.reviewBytes = new Uint8Array(0);
      this.reviewPath = "";
      this.native = false;
      // Post-save niceties are best-effort; the recording is already saved.
      try { await app.refresh(); } catch { /* stale list until next refresh */ }
      app.pushToast({
        kind: "success",
        title: "Recording saved",
        body: this.reviewUsesLiveTranscript
          ? `${capturedLabel} · indexing the realtime transcript; the original audio is retained.`
          : `${capturedLabel} · transcribing with Whisper in the background — you'll get a notification when it's ready.`,
      });
      // Reset to a clean slate — reopening the Recorder should read READY, not
      // the finished take's leftover clock and tags.
      this.discardReview();
      // Land on the subject the recording was saved TO (it may differ from the
      // one that was active when recording started).
      app.openSubject(subjId);
      app.setTab("sources");
    } catch (e) {
      if (e instanceof api.TranscriptSaveError) this.reviewSavedSourceId = e.sourceId;
      this.errorMsg = String(e);
      this.status = "review"; // back to review so the user can retry without losing the audio
    }
  }

  discardReview(): void {
    this.reviewSavedSourceId = "";
    this.stopCaptions();
    if (this.reviewPath) api.nativeRecDiscardFile(this.reviewPath).catch(() => {});
    this.reviewBytes = new Uint8Array(0);
    this.reviewPath = "";
    this.reviewName = "";
    this.reviewSubjectId = "";
    this.reviewTopicId = "";
    this.reviewTranscript = "";
    this.reviewUsesLiveTranscript = false;
    this.reviewDuration = "00:00";
    this.secs = 0;
    this.tags = [];
    this.liveBackendText = ""; this.captions = []; this.captionError = "";
    this.native = false;
    this.status = "ready";
  }

  // ════════════════════ live bilingual captions ════════════════════

  toggleTranscriptPanel(): void {
    if (this.finishing) return;
    this.transcriptCollapsed = !this.transcriptCollapsed;
    if (!this.recording || isMobile) return;
    this.liveTranscriptComplete = false;
    if (this.transcriptCollapsed) this.stopCaptions();
    else void this.startCaptions();
  }

  private async startCaptions(): Promise<void> {
    this.stopCaptions();
    const generation = this.captionGeneration;
    this.captionError = "";
    this.captionStart = this.secs;
    this.captionCapturedSamples = 0;
    // Opening mid-recording starts at the current capture position.
    this.nativeCaptionCursor = Math.floor(this.secs * 16000);
    const target = this.translationTarget;
    const streaming = this.liveAsrProvider === "voxtral";
    const readAudio = async () => {
        const at = this.captionStart;
        if (this.native) {
          const chunk = await api.nativeRecChunk(this.nativeCaptionCursor, streaming);
          this.nativeCaptionCursor = chunk.cursor;
          this.captionStart = chunk.cursor / 16000;
          return chunk.audio.length ? { audio: chunk.audio, at } : null;
        }
        const pcm = this.captionPcm;
        this.captionPcm = [];
        this.captionSamples = 0;
        this.captionStart = this.secs;
        if (!pcm.length || (!streaming && meanAmplitude(pcm) < SILENCE_RMS)) return null;
        return { audio: Array.from(encodeWav(pcm)), at };
      };
    const publish = (caption: Caption) => {
        const index = this.captions.findIndex((item) => item.id === caption.id);
        if (index === -1) this.captions = [...this.captions, { ...caption }];
        else this.captions = this.captions.map((item, i) => i === index ? { ...caption } : item);
        this.liveBackendText = this.captions.map((item) => item.original).join(" ");
      };
    const translate = (text: string, draft = false, context = "") => api.translateCaption(text, target, draft, context);
    const onError = (error: string) => {
      this.liveTranscriptComplete = false;
      this.captionError = error;
      this.stopCaptions();
    };
    let session: LiveCaptions | VoxtralCaptions;
    try {
      session = streaming
        ? new VoxtralCaptions(this.vibevoiceUrl, this.vibevoiceToken, readAudio, translate, publish, onError, this.secs)
        : new LiveCaptions(readAudio, (audio) => api.transcribePartial(audio, "wav"), (text) => translate(text), publish, onError);
    } catch (error) { onError(String(error)); return; }
    this.captionSession = session;
    if (!this.native && this.audioCtx && this.srcNode) {
      try {
        const capture = await startCaptionAudioCapture(this.audioCtx, this.srcNode, (pcm) => {
          if (!this.live || !this.liveTranscriptOn) return;
          if (this.captionSamples + pcm.length > 16000 * 120) {
            this.captionError = "Live captions are more than two minutes behind. Close and reopen captions to resume; the full recording is retained.";
            this.stopCaptions();
            return;
          }
          this.captionPcm.push(pcm);
          this.captionSamples += pcm.length;
          this.captionCapturedSamples += pcm.length;
        });
        if (generation !== this.captionGeneration || this.captionSession !== session) {
          capture.close();
          return;
        }
        this.captionCapture = capture;
      } catch (error) {
        onError(`Couldn't start reliable live audio capture: ${String(error)}`);
        return;
      }
    }
    this.captionTimer = setInterval(() => {
      if (!this.live) return;
      this.liveUpdating = true;
      void session.poll().finally(() => {
        if (this.captionSession === session) this.liveUpdating = false;
      });
    }, streaming ? 250 : SEG_MS);
    this.captionHealthTimer = setInterval(() => {
      const transport = session instanceof VoxtralCaptions ? session.diagnostics() : null;
      console.info("[live-captions] health", {
        capture: this.native ? "native" : "audio-worklet",
        capturedAudioSeconds: Math.round((this.captionCapturedSamples / 16000) * 10) / 10,
        queuedAudioSeconds: Math.round((this.captionSamples / 16000) * 10) / 10,
        ...transport,
      });
    }, 10000);
  }

  private detachCaptionCapture(): void {
    this.captionCapture?.close();
    this.captionCapture = null;
  }

  private stopCaptions(): void {
    this.captionGeneration++;
    if (this.captionTimer) clearInterval(this.captionTimer);
    this.captionTimer = null;
    if (this.captionHealthTimer) clearInterval(this.captionHealthTimer);
    this.captionHealthTimer = null;
    this.captionSession?.cancel();
    this.captionSession = null;
    this.detachCaptionCapture();
    this.captionPcm = [];
    this.captionSamples = 0;
    this.liveUpdating = false;
  }

  private async finishCaptions(): Promise<void> {
    if (this.captionTimer) clearInterval(this.captionTimer);
    this.captionTimer = null;
    if (this.captionHealthTimer) clearInterval(this.captionHealthTimer);
    this.captionHealthTimer = null;
    this.liveUpdating = true;
    const session = this.captionSession;
    try {
      await this.captionCapture?.flush();
      this.detachCaptionCapture();
      await session?.finish();
    }
    catch (error) { this.captionError = String(error); }
    finally { this.stopCaptions(); }
  }

  private formattedLiveTranscript(): string {
    return formatBilingualTranscript(this.captions, this.translationTarget);
  }

  async exportCaptions(): Promise<void> {
    const text = this.captions.map((item) => {
      const at = `${Math.floor(item.at / 60).toString().padStart(2, "0")}:${Math.floor(item.at % 60).toString().padStart(2, "0")}`;
      return `[${at}]${item.speaker ? ` ${item.speaker}` : ""}\n${item.original}\n${item.translated}`;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      app.pushToast({ kind: "success", title: "Bilingual captions copied" });
    } catch (error) {
      app.pushToast({ kind: "error", title: "Couldn't copy captions", body: String(error) });
    }
  }

  // ════════════════════ WAV capture fallback (WebKitGTK) ════════════════════
  // WebKitGTK's MediaRecorder can run without error yet deliver ZERO data —
  // every saved lecture came out empty. getUserMedia + Web Audio provably work
  // (the live waveform uses them), so when the watchdog sees no data arrive we
  // capture raw PCM off the same graph and encode 16 kHz mono WAV ourselves.
  private switchToWavCapture(): void {
    if (this.captureMode === "wav" || !this.audioCtx || !this.srcNode || !this.recording) return;
    console.warn("[recorder] MediaRecorder produced no data — switching to WAV capture");
    try {
      if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.ondataavailable = null;
        this.mediaRecorder.stop();
      }
    } catch { /* noop */ }
    this.mediaRecorder = null;
    this.captureMode = "wav";
    this.wavChunks = [];
    this.wavProc = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.srcNode.connect(this.wavProc);
    // The processor only runs while routed to the destination — mute it.
    const mute = this.audioCtx.createGain();
    mute.gain.value = 0;
    this.wavProc.connect(mute).connect(this.audioCtx.destination);
    const rate = this.audioCtx.sampleRate;
    this.wavProc.onaudioprocess = (e) => {
      if (!this.recording || this.paused) return;
      this.wavChunks.push(downsampleTo16k(e.inputBuffer.getChannelData(0), rate));
    };
  }
}

export const rec = new RecorderStore();
