import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatBilingualTranscript, LiveCaptions, makeCaption, newestFirstCaptions, type Caption } from "./live-captions";

test("newest-first display order does not mutate chronological saved captions", () => {
  const first = makeCaption(1, "first", undefined, true);
  const second = makeCaption(2, "second", undefined, true);
  const chronological = [first, second];

  expect(newestFirstCaptions(chronological).map((caption) => caption.original)).toEqual(["second", "first"]);
  expect(chronological.map((caption) => caption.original)).toEqual(["first", "second"]);
});

test("saved transcripts include only authoritative final translations", () => {
  const translated = makeCaption(64, "What is going on here?", "Speaker 1", true);
  translated.translated = "这里发生了什么？";
  translated.translationFinal = true;
  const provisional = makeCaption(68, "A draft sentence.", "Speaker 1", true);
  provisional.translated = "临时译文";
  const unfinished = makeCaption(70, "Still speaking", "Speaker 1", false);
  unfinished.translated = "仍在说话";

  expect(formatBilingualTranscript([translated, provisional, unfinished], "zh-CN")).toBe(
    "[01:04] Speaker 1\n原文：What is going on here?\n译文：这里发生了什么？\n\n" +
    "[01:08] Speaker 1\n原文：A draft sentence.",
  );
});

test("captions preserve originals on translation failure, serialize requests and flush the tail", async () => {
  let release!: (text: string) => void;
  let reads = 0;
  const results: Caption[] = [];
  const session = new LiveCaptions(
    async () => ++reads <= 2 ? { audio: [reads], at: reads * 4 } : null,
    async (audio) => audio[0] === 1 ? new Promise<string>((r) => { release = r; }) : "tail",
    async () => { throw new Error("provider unavailable"); },
    (caption) => { results[caption.at / 4 - 1] = { ...caption }; },
    (error) => { throw new Error(error); },
  );
  const first = session.poll();
  await Promise.resolve();
  expect(session.poll()).toBe(first);
  const finished = session.finish();
  release("hello");
  await finished;
  expect(reads).toBe(2);
  expect(results.map((c) => c.original)).toEqual(["hello", "tail"]);
  expect(results.every((c) => c.error.includes("provider unavailable"))).toBe(true);
  expect(results.every((c) => !c.translationFinal)).toBe(true);
});

test("discarded sessions never publish late ASR or translation results", async () => {
  let release!: (text: string) => void;
  const output: Caption[] = [];
  const session = new LiveCaptions(
    async () => ({ audio: [1], at: 0 }),
    () => new Promise<string>((r) => { release = r; }),
    async () => "你好",
    (caption) => output.push(caption),
    () => {},
  );
  const pending = session.poll();
  await Promise.resolve();
  session.cancel();
  release("hello");
  await pending;
  expect(output).toEqual([]);
});

test("the recorder labels provisional and final translations and exposes final failures", () => {
  const recorder = readFileSync("src/views/Recorder.svelte", "utf8");
  expect(recorder).toContain('caption.translationFinal ? "Final translation" : "Draft translation"');
  expect(recorder).toContain("caption.error && caption.translated");
  expect(recorder).toContain("Final translation unavailable");
});

test("the live transcript keeps the newest caption at the top", () => {
  const recorder = readFileSync("src/views/Recorder.svelte", "utf8");
  expect(recorder).toContain("newestFirstCaptions(rec.captions)");
  expect(recorder).toContain("{#each newestCaptions as caption");
  expect(recorder).toContain("rtPinned = el.scrollTop < 24");
  expect(recorder).toContain("el.scrollTop = 0");
});
