export type Caption = {
  id: number;
  speaker?: string;
  at: number;
  original: string;
  translated: string;
  error: string;
  final: boolean;
  translationFinal: boolean;
};

let captionId = 0;
export function makeCaption(at: number, original = "", speaker?: string, final = false): Caption {
  return {
    id: ++captionId,
    at,
    original,
    translated: "",
    error: "",
    speaker,
    final,
    translationFinal: false,
  };
}

export function newestFirstCaptions(captions: readonly Caption[]): Caption[] {
  return [...captions].reverse();
}

export function formatBilingualTranscript(captions: Caption[], target: string): string {
  const originalLabel = target === "zh-CN" ? "原文" : "Original";
  const translationLabel = target === "zh-CN" ? "译文" : "Translation";
  return captions
    .filter((item) => item.final && item.original.trim())
    .map((item) => {
      const at = `${Math.floor(item.at / 60).toString().padStart(2, "0")}:${Math.floor(item.at % 60).toString().padStart(2, "0")}`;
      const speaker = item.speaker ? ` ${item.speaker}` : "";
      const translation = item.translationFinal && item.translated.trim()
        ? `\n${translationLabel}：${item.translated.trim()}`
        : "";
      return `[${at}]${speaker}\n${originalLabel}：${item.original.trim()}${translation}`;
    })
    .join("\n\n");
}

export type CaptionAudio = { audio: number[]; at: number };

// ponytail: one ASR/translation pair at a time; use a streaming ASR transport
// when the configured services cannot keep up with four-second windows.
export class LiveCaptions {
  private cancelled = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readAudio: () => Promise<CaptionAudio | null>,
    private transcribe: (audio: number[]) => Promise<string>,
    private translate: (text: string) => Promise<string>,
    private onCaption: (caption: Caption) => void,
    private onError: (error: string) => void,
  ) {}

  poll(): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.consume().finally(() => { this.pending = null; });
    return this.pending;
  }

  private async consume(): Promise<void> {
    try {
      const chunk = await this.readAudio();
      if (!chunk || this.cancelled) return;
      const original = (await this.transcribe(chunk.audio)).trim();
      if (!original || this.cancelled) return;
      const caption = makeCaption(chunk.at, original, undefined, true);
      this.onCaption(caption);
      try {
        caption.translated = (await this.translate(original)).trim();
        caption.translationFinal = !!caption.translated;
      } catch (error) {
        caption.error = String(error);
      }
      if (!this.cancelled) this.onCaption(caption);
    } catch (error) {
      if (!this.cancelled) this.onError(String(error));
    }
  }

  async finish(): Promise<void> {
    await this.pending;
    // The recorder freezes capture before finishing, leaving at most one
    // remaining window. The reader reports overflow instead of hiding a gap.
    await this.poll();
  }

  cancel(): void { this.cancelled = true; }
}
