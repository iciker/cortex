import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  CAPTION_AUDIO_PROCESSOR,
  CAPTION_AUDIO_WORKLET_URL,
  prepareCaptionAudioCapture,
  startCaptionAudioCapture,
} from "./caption-audio";

test("caption audio runs in an AudioWorklet and flushes its final PCM block", async () => {
  const modules: string[] = [];
  const pcm: Int16Array[] = [];
  let sourceConnection: unknown;
  let nodeDisconnected = false;
  let gainDisconnected = false;

  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage(message: unknown) {
      if ((message as { type?: string }).type === "flush") {
        queueMicrotask(() => this.onmessage?.({ data: { type: "flushed" } } as MessageEvent));
      }
    },
  };
  const node = {
    port,
    connect(target: unknown) { return target; },
    disconnect() { nodeDisconnected = true; },
  };
  const gain = {
    gain: { value: 1 },
    connect(target: unknown) { return target; },
    disconnect() { gainDisconnected = true; },
  };
  const context = {
    audioWorklet: { async addModule(url: string) { modules.push(url); } },
    createGain() { return gain; },
    destination: {},
  };
  const source = { connect(target: unknown) { sourceConnection = target; } };

  await prepareCaptionAudioCapture(context as never);
  const capture = await startCaptionAudioCapture(
    context as never,
    source as never,
    (block) => pcm.push(block),
    () => node as never,
  );
  const buffer = new Int16Array([1, -2, 3]).buffer;
  port.onmessage?.({ data: { type: "pcm", pcm: buffer } } as MessageEvent);
  await capture.flush();
  capture.close();

  expect(modules).toEqual([CAPTION_AUDIO_WORKLET_URL]);
  expect(CAPTION_AUDIO_PROCESSOR).toBe("cortex-caption-capture");
  expect(sourceConnection).toBe(node);
  expect(gain.gain.value).toBe(0);
  expect(pcm.map((block) => Array.from(block))).toEqual([[1, -2, 3]]);
  expect(nodeDisconnected).toBe(true);
  expect(gainDisconnected).toBe(true);
});

test("the recorder no longer captures live captions on ScriptProcessorNode", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const recorder = readFileSync(`${here}/recorder.svelte.ts`, "utf8");
  expect(recorder).toContain("startCaptionAudioCapture");
  expect(recorder).not.toContain("this.captionProc = this.audioCtx.createScriptProcessor");
});

test("the worklet continuously resamples 48 kHz input into 100 ms 16 kHz PCM packets", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const workletSource = readFileSync(`${here}/../../public/caption-audio-worklet.js`, "utf8");
  let Processor: new () => {
    port: { onmessage: ((event: MessageEvent) => void) | null };
    process(inputs: Float32Array[][]): boolean;
  };
  const messages: Array<{ type: string; pcm?: ArrayBuffer }> = [];
  class FakeAudioWorkletProcessor {
    port = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(message: { type: string; pcm?: ArrayBuffer }) { messages.push(message); },
    };
  }
  vm.runInNewContext(workletSource, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    Int16Array,
    Math,
    sampleRate: 48000,
    registerProcessor(_name: string, implementation: typeof Processor) { Processor = implementation; },
  });
  const processor = new Processor!();
  for (let offset = 0; offset < 48000; offset += 128) {
    const length = Math.min(128, 48000 - offset);
    processor.process([[new Float32Array(length).fill(0.25)]]);
  }
  processor.port.onmessage?.({ data: { type: "flush" } } as MessageEvent);

  const packets = messages.filter((message) => message.type === "pcm")
    .map((message) => new Int16Array(message.pcm!));
  expect(packets.slice(0, -1).every((packet) => packet.length === 1600)).toBe(true);
  expect(packets.reduce((total, packet) => total + packet.length, 0)).toBe(16000);
  expect(packets[0][0]).toBeCloseTo(8192, -1);
  expect(messages.at(-1)?.type).toBe("flushed");
});
