export const CAPTION_AUDIO_PROCESSOR = "cortex-caption-capture";
export const CAPTION_AUDIO_WORKLET_URL = "/caption-audio-worklet.js";

export interface CaptionAudioCapture {
  flush(): Promise<void>;
  close(): void;
}

const preparedContexts = new WeakMap<BaseAudioContext, Promise<void>>();

/** Load the worklet before the UI enters recording state, preserving the first word. */
export function prepareCaptionAudioCapture(context: AudioContext): Promise<void> {
  if (!context.audioWorklet) return Promise.reject(new Error("Live captions require AudioWorklet support"));
  const existing = preparedContexts.get(context);
  if (existing) return existing;
  const pending = context.audioWorklet.addModule(CAPTION_AUDIO_WORKLET_URL).catch((error) => {
    preparedContexts.delete(context);
    throw error;
  });
  preparedContexts.set(context, pending);
  return pending;
}

type WorkletNodeFactory = (
  context: BaseAudioContext,
  name: string,
  options: AudioWorkletNodeOptions,
) => AudioWorkletNode;

/**
 * Capture continuous 16 kHz PCM on the Web Audio render thread.
 *
 * The worklet owns resampling so main-thread stalls can delay delivery without
 * dropping microphone frames. Its output is routed through a muted gain node to
 * keep WebKit's audio graph alive without playing the microphone back.
 */
export async function startCaptionAudioCapture(
  context: AudioContext,
  source: AudioNode,
  onPcm: (pcm: Int16Array) => void,
  makeNode: WorkletNodeFactory = (ctx, name, options) => new AudioWorkletNode(ctx, name, options),
): Promise<CaptionAudioCapture> {
  await prepareCaptionAudioCapture(context);
  const node = makeNode(context, CAPTION_AUDIO_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: "explicit",
  });
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute).connect(context.destination);

  let closed = false;
  let flushWaiters: Array<() => void> = [];
  node.port.onmessage = (event: MessageEvent) => {
    const message = event.data as { type?: string; pcm?: ArrayBuffer } | undefined;
    if (message?.type === "pcm" && message.pcm instanceof ArrayBuffer) {
      const pcm = new Int16Array(message.pcm);
      if (pcm.length && !closed) onPcm(pcm);
    } else if (message?.type === "flushed") {
      const waiters = flushWaiters;
      flushWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };

  return {
    async flush() {
      if (closed) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 500);
        flushWaiters.push(finish);
        node.port.postMessage({ type: "flush" });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      node.port.onmessage = null;
      const waiters = flushWaiters;
      flushWaiters = [];
      for (const resolve of waiters) resolve();
      try { source.disconnect(node); } catch { /* already detached */ }
      try { node.disconnect(); } catch { /* already detached */ }
      try { mute.disconnect(); } catch { /* already detached */ }
    },
  };
}
