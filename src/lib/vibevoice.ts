import { makeCaption, type Caption, type CaptionAudio } from "./live-captions";

export function realtimeSocketUrl(address: string): string {
  const url = new URL(address.trim());
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP or HTTPS realtime ASR server URL without credentials or query parameters");
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "") + "/ws/cortex";
  return url.href;
}

/** Legacy export retained for existing tests and integrations. */
export const vibevoiceSocketUrl = realtimeSocketUrl;

export function pcmFromWav(audio: number[]): Uint8Array {
  const bytes = Uint8Array.from(audio);
  const data = new DataView(bytes.buffer);
  const tag = (at: number) => String.fromCharCode(...bytes.slice(at, at + 4));
  if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Invalid caption WAV");
  let validFormat = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = data.getUint32(at + 4, true);
    if (at + 8 + size > bytes.length) throw new Error("Truncated caption WAV");
    if (tag(at) === "fmt ") {
      validFormat = size >= 16 && data.getUint16(at + 8, true) === 1 && data.getUint16(at + 10, true) === 1
        && data.getUint32(at + 12, true) === 16000 && data.getUint16(at + 22, true) === 16;
    }
    if (tag(at) === "data") {
      if (!validFormat || size % 2) throw new Error("Captions require mono 16 kHz PCM16");
      return bytes.slice(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("Caption WAV has no audio data");
}

export async function deadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}

/** Audio transmission and text translation have independent, bounded queues. */
export class VoxtralCaptions {
  private socket: WebSocket;
  private ready: Promise<void>;
  private ended: Promise<void>;
  private cancelled = false;
  private done = false;
  private pending: Promise<void> | null = null;
  private translations = Promise.resolve();
  private waiting = new Set<Caption>();
  private draft: Caption | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private draftPending: Promise<void> | null = null;
  private draftVersion = 0;
  private draftTexts = new Map<number, string>();
  private finalContext: string[] = [];
  private speaker: string | undefined;
  private lastIndex = -1;
  private sentAudioBytes = 0;
  private captionChunks = 0;
  private lastAudioAt: number | null = null;
  private lastCaptionAt: number | null = null;
  private abortReady: () => void;
  private abortEnd: () => void;

  constructor(address: string, token: string,
    private readAudio: () => Promise<CaptionAudio | null>,
    private translate: (text: string, draft: boolean, context?: string) => Promise<string>,
    private publish: (caption: Caption) => void,
    private onError: (error: string) => void,
    private startAt = 0,
    private draftDelay = 150,
  ) {
    this.socket = new WebSocket(realtimeSocketUrl(address));
    let opened!: () => void, rejectOpen!: (reason: Error) => void;
    let ended!: () => void, rejectEnd!: (reason: Error) => void;
    this.ready = deadline(new Promise<void>((resolve, reject) => { opened = resolve; rejectOpen = reject; }),
      30000, "Voxtral connection timed out");
    this.ended = new Promise<void>((resolve, reject) => { ended = resolve; rejectEnd = reject; });
    this.abortReady = () => rejectOpen(new Error("Caption session cancelled"));
    this.abortEnd = () => rejectEnd(new Error("Caption session cancelled"));
    // The recording may never call finish after an early failure.
    void this.ended.catch(() => {});
    const fail = (reason: string) => {
      const error = new Error(reason);
      rejectOpen(error); rejectEnd(error);
      if (!this.cancelled) { this.onError(reason); this.cancel(); }
    };
    void this.ready.catch((error) => fail(String(error)));
    this.socket.onopen = () => { if (!this.cancelled) this.socket.send(JSON.stringify({ protocol: "cortex-pcm-v1", token })); };
    this.socket.onerror = () => fail("Couldn't connect to Voxtral. Check the server address and service.");
    this.socket.onclose = () => { if (!this.done && !this.cancelled) fail("Voxtral disconnected before finishing captions"); };
    this.socket.onmessage = (event) => {
      if (this.cancelled) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "ready" && message.sample_rate === 16000) opened();
        else if (message.type === "error") fail(String(message.error));
        else if (message.type === "done") { this.done = true; this.flush(); ended(); }
        else if (message.type === "chunk") {
          if (!Number.isInteger(message.index) || message.index !== this.lastIndex + 1 ||
              !Number.isFinite(message.at) || message.at < 0 || typeof message.text !== "string" || message.text.length > 16000) {
            throw new Error("Invalid or missing Voxtral caption chunk");
          }
          this.lastIndex = message.index;
          this.captionChunks++;
          this.lastCaptionAt = Date.now();
          this.append(message.text, this.startAt + message.at);
        } else throw new Error("Unexpected Voxtral response");
      } catch (error) { fail(String(error)); }
    };
  }

  private append(text: string, at: number): void {
    // Some ASR backends emit this sentinel for windows without speech. It is protocol
    // metadata, not transcript content and must never be sent for translation.
    text = text.replace(/\[Silence\]/gi, "");
    if (!text.trim()) return;
    for (const part of text.split(/(Speaker\s+\d+:)/g)) {
      if (/^Speaker\s+\d+:$/.test(part)) {
        this.flush(); this.speaker = part.slice(0, -1); continue;
      }
      if (!part.trim() && !this.draft) continue;
      this.draft ??= makeCaption(at, "", this.speaker);
      this.draft.original += part;
      // A model chunk can finish one sentence and start the next. Translate
      // the completed sentence immediately while its successor remains a draft.
      while (this.draft) {
        const sentence = this.draft.original.match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s+|$))/);
        if (!sentence) break;
        const rest = this.draft.original.slice(sentence[0].length);
        this.draft.original = sentence[0];
        this.draft.final = true;
        this.publish(this.draft);
        this.flush();
        if (rest.trim()) this.draft = makeCaption(at, rest, this.speaker);
      }
      if (this.draft) {
        this.publish(this.draft);
        this.scheduleDraft();
        if (this.draft.original.length >= 240) {
          this.draft.final = true;
          this.publish(this.draft);
          this.flush();
        }
      }
    }
  }

  private scheduleDraft(): void {
    this.draftVersion++;
    if (this.draftTimer || this.draftPending || !this.draft) return;
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      const caption = this.draft;
      if (!caption || caption.final || this.cancelled) return;
      const text = caption.original;
      const version = this.draftVersion;
      this.draftPending = this.translateDraft(caption, text).finally(() => {
        this.draftPending = null;
        if (this.draft && !this.draft.final && version !== this.draftVersion) this.scheduleDraft();
      });
    }, this.draftDelay);
  }

  private async translateDraft(caption: Caption, text: string): Promise<void> {
    try {
      const translated = await deadline(this.translate(text, true), 5000, "Draft translation timed out");
      if (!this.cancelled && !caption.translationFinal && translated.trim()) {
        caption.translated = translated.trim();
        caption.translationFinal = false;
        caption.error = "";
        this.draftTexts.set(caption.id, text);
        this.publish(caption);
      }
    } catch {
      // Drafts are best-effort. The authoritative final translation still runs.
    }
  }

  private flush(): void {
    const caption = this.draft;
    const pendingDraft = this.draftPending;
    this.draft = null;
    this.draftVersion++;
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    if (!caption || !caption.original.trim()) return;
    caption.final = true;
    const current = caption.original.trim();
    const context = this.finalContext.slice(-2).join(" ");
    this.finalContext.push(current);
    if (this.finalContext.length > 2) this.finalContext.shift();
    if (this.waiting.size >= 12) {
      caption.error = "Translation is falling behind; the original transcript is retained";
      this.publish(caption); return;
    }
    this.waiting.add(caption);
    // Voxtral often emits a short sentence and its punctuation together. Start
    // the fast draft outside the final queue so it remains responsive, then
    // serialize only the more expensive authoritative translations.
    const draft = (async () => {
      await pendingDraft;
      if (!this.cancelled && this.draftTexts.get(caption.id) !== current) {
        await this.translateDraft(caption, current);
      }
    })();
    this.translations = Promise.all([this.translations, draft]).then(async () => {
      if (this.cancelled) return;
      try {
        const text = await deadline(this.translate(current, false, context), 20000, "Caption translation timed out");
        if (!text.trim()) throw new Error("The translation model returned no text");
        caption.translated = text.trim();
        caption.translationFinal = true;
        caption.error = "";
      } catch (error) {
        caption.translationFinal = false;
        caption.error = String(error);
      }
      finally {
        this.waiting.delete(caption);
        this.draftTexts.delete(caption.id);
      }
      if (!this.cancelled) this.publish(caption);
    });
  }

  poll(): Promise<void> {
    if (this.cancelled || this.done) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await this.ready;
      const chunk = await this.readAudio();
      if (!chunk || this.cancelled) return;
      const pcm = pcmFromWav(chunk.audio);
      if (this.socket.bufferedAmount + pcm.length > 16000 * 2 * 30) throw new Error("Live audio connection is falling behind");
      // Split a delayed native/WebAudio read into protocol-sized messages.
      for (let offset = 0; offset < pcm.length; offset += 32000) this.socket.send(pcm.slice(offset, offset + 32000));
      this.sentAudioBytes += pcm.length;
      this.lastAudioAt = Date.now();
    })().catch((error) => {
      if (!this.cancelled) { this.onError(String(error)); this.cancel(); }
    }).finally(() => { this.pending = null; });
    return this.pending;
  }

  diagnostics(now = Date.now()): {
    sentAudioBytes: number;
    sentAudioSeconds: number;
    captionChunks: number;
    socketBufferedBytes: number;
    secondsSinceAudio: number | null;
    secondsSinceCaption: number | null;
  } {
    return {
      sentAudioBytes: this.sentAudioBytes,
      sentAudioSeconds: Math.round((this.sentAudioBytes / 2 / 16000) * 1000) / 1000,
      captionChunks: this.captionChunks,
      socketBufferedBytes: this.socket.bufferedAmount,
      secondsSinceAudio: this.lastAudioAt === null ? null : Math.round((now - this.lastAudioAt) / 100) / 10,
      secondsSinceCaption: this.lastCaptionAt === null ? null : Math.round((now - this.lastCaptionAt) / 100) / 10,
    };
  }

  async finish(): Promise<void> {
    try {
      await this.pending;
      await this.poll();
      if (this.cancelled) return;
      this.socket.send("end");
      await deadline(this.ended, 60000, "Voxtral did not finish in time; the full recording is retained");
      await deadline(this.translations, 30000, "Translation did not finish in time; the original transcript is retained");
    } catch (error) { if (!this.cancelled) this.onError(String(error)); }
    finally { this.cancel(); }
  }

  cancel(): void {
    if (this.cancelled) return;
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    this.draftVersion++;
    for (const caption of [...this.waiting, ...(this.draft ? [this.draft] : [])]) {
      if (!caption.translated && !caption.error) {
        caption.error = "Translation interrupted; the original transcript is retained";
        this.publish(caption);
      }
    }
    this.cancelled = true;
    this.waiting.clear();
    this.draftTexts.clear();
    this.abortReady();
    this.abortEnd();
    this.socket.close();
  }
}

/** Source compatibility for installations that still import the old name. */
export { VoxtralCaptions as VibeVoiceCaptions };
