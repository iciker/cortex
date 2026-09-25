import { expect, test } from "bun:test";
import { VibeVoiceCaptions, pcmFromWav, vibevoiceSocketUrl } from "./vibevoice";
import type { Caption } from "./live-captions";

function wav() {
  const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
  for (const [at, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) bytes.set(new TextEncoder().encode(text), at);
  view.setUint32(4, 40, true); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint16(34, 16, true); view.setUint32(40, 4, true);
  bytes.set([1, 2, 3, 4], 44);
  return Array.from(bytes);
}

test("VibeVoice URLs and PCM boundaries reject unsupported input", () => {
  expect(vibevoiceSocketUrl("https://example.com/asr/")).toBe("wss://example.com/asr/ws/cortex");
  expect(() => vibevoiceSocketUrl("file:///tmp/model")).toThrow();
  expect(() => vibevoiceSocketUrl("http://user:pass@localhost")).toThrow();
  expect(Array.from(pcmFromWav(wav()))).toEqual([1, 2, 3, 4]);
  expect(() => pcmFromWav(wav().slice(0, -1))).toThrow();
});

test("streaming sends audio while translation waits, preserves speakers and drains final text", async () => {
  let packets = 0, ended = false;
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) {
      if (typeof data === "string") {
        if (data === "end") {
          ended = true;
          ws.send(JSON.stringify({ type: "chunk", index: 2, at: 6, text: " Speaker 1:Goodbye." }));
          ws.send(JSON.stringify({ type: "done" }));
        } else { expect(JSON.parse(data).protocol).toBe("cortex-pcm-v1"); ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 })); }
      } else {
        packets++;
        ws.send(JSON.stringify({ type: "chunk", index: packets - 1, at: (packets - 1) * 3,
          text: packets === 1 ? "[Silence]" : " Speaker 0:Hello." }));
      }
    } },
  });
  const rows = new Map<number, Caption>();
  let release!: (text: string) => void, reads = 0;
  const blocked = new Promise<string>((resolve) => { release = resolve; });
  let translated = 0;
  const errors: string[] = [];
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "",
    async () => ++reads <= 2 ? { audio: wav(), at: reads } : null,
    async (_text, draft) => ++translated === 1 ? blocked : (draft ? "临时译文" : "译文"),
    (row) => rows.set(row.id, { ...row }), (error) => errors.push(error));
  try {
    await session.poll();
    await Bun.sleep(20);
    await session.poll();
    await Bun.sleep(20);
    expect(packets).toBe(2);
    expect(translated).toBe(1);
    const finished = session.finish();
    release("你好");
    await finished;
    expect(ended).toBe(true);
    expect(errors).toEqual([]);
    expect([...rows.values()].map((row) => row.speaker)).toEqual(["Speaker 0", "Speaker 1"]);
    expect([...rows.values()].map((row) => row.translated)).toEqual(["译文", "译文"]);
    expect([...rows.values()].every((row) => row.translationFinal)).toBe(true);
    expect(session.diagnostics().sentAudioBytes).toBe(8);
    expect(session.diagnostics().captionChunks).toBe(3);
  } finally { session.cancel(); server.stop(true); }
});

test("a growing clause gets a provisional translation that the final sentence replaces", async () => {
  let packets = 0;
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) {
      if (typeof data === "string") {
        if (data === "end") ws.send(JSON.stringify({ type: "done" }));
        else { JSON.parse(data); ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 })); }
      } else {
        packets++;
        ws.send(JSON.stringify({ type: "chunk", index: packets - 1, at: packets,
          text: packets === 1 ? " Speaker 0:What do " : "you think?" }));
      }
    } },
  });
  const calls: Array<{ text: string; draft: boolean; context: string }> = [];
  const rows = new Map<number, Caption>();
  let reads = 0;
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "",
    async () => ++reads <= 2 ? { audio: wav(), at: reads } : null,
    async (text, draft, context = "") => {
      calls.push({ text, draft, context });
      return draft ? "你觉得" : "你觉得怎么样？";
    },
    (row) => rows.set(row.id, { ...row }), () => {}, 0, 5);
  try {
    await session.poll();
    await Bun.sleep(20);
    expect(calls[0]).toEqual({ text: "What do ", draft: true, context: "" });
    expect([...rows.values()][0].translated).toBe("你觉得");
    expect([...rows.values()][0].final).toBe(false);
    expect([...rows.values()][0].translationFinal).toBe(false);
    await session.poll();
    await session.finish();
    expect(calls.at(-1)).toEqual({ text: "What do you think?", draft: false, context: "" });
    expect([...rows.values()][0].translated).toBe("你觉得怎么样？");
    expect([...rows.values()][0].final).toBe(true);
    expect([...rows.values()][0].translationFinal).toBe(true);
  } finally { session.cancel(); server.stop(true); }
});

test("a short completed sentence publishes a fast draft before its final translation", async () => {
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) {
      if (typeof data === "string") {
        if (data === "end") ws.send(JSON.stringify({ type: "done" }));
        else { JSON.parse(data); ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 })); }
      } else {
        ws.send(JSON.stringify({ type: "chunk", index: 0, at: 1, text: "Hello." }));
      }
    } },
  });
  const calls: Array<{ text: string; draft: boolean }> = [];
  const rows = new Map<number, Caption>();
  let read = false;
  let releaseFinal!: (text: string) => void;
  const final = new Promise<string>((resolve) => { releaseFinal = resolve; });
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "",
    async () => read ? null : (read = true, { audio: wav(), at: 0 }),
    async (text, draft) => {
      calls.push({ text, draft });
      return draft ? "你好（临时）" : final;
    },
    (row) => rows.set(row.id, { ...row }), () => {}, 0, 5);
  try {
    await session.poll();
    await Bun.sleep(20);
    expect(calls[0]).toEqual({ text: "Hello.", draft: true });
    expect([...rows.values()][0].translated).toBe("你好（临时）");
    expect([...rows.values()][0].translationFinal).toBe(false);
    const finished = session.finish();
    releaseFinal("你好。");
    await finished;
    expect([...rows.values()][0].translated).toBe("你好。");
    expect([...rows.values()][0].translationFinal).toBe(true);
  } finally { session.cancel(); server.stop(true); }
});

test("final translations carry the previous two completed sentences as context", async () => {
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) {
      if (typeof data === "string") {
        if (data === "end") ws.send(JSON.stringify({ type: "done" }));
        else { JSON.parse(data); ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 })); }
      } else {
        ws.send(JSON.stringify({ type: "chunk", index: 0, at: 1,
          text: "First sentence. Second sentence. Third sentence." }));
      }
    } },
  });
  const calls: Array<{ text: string; draft: boolean; context: string }> = [];
  let read = false;
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "",
    async () => read ? null : (read = true, { audio: wav(), at: 0 }),
    async (text, draft, context = "") => {
      calls.push({ text, draft, context });
      return `translated: ${text}`;
    },
    () => {}, () => {});
  try {
    await session.poll();
    await session.finish();
    expect(calls.filter((call) => !call.draft)).toEqual([
      { text: "First sentence.", draft: false, context: "" },
      { text: "Second sentence.", draft: false, context: "First sentence." },
      { text: "Third sentence.", draft: false, context: "First sentence. Second sentence." },
    ]);
  } finally { session.cancel(); server.stop(true); }
});

test("a failed final translation keeps and identifies the provisional translation", async () => {
  let packets = 0;
  const server = Bun.serve({ port: 0, fetch(req, srv) { if (srv.upgrade(req)) return; return new Response(null, { status: 400 }); },
    websocket: { message(ws, data) {
      if (typeof data === "string") {
        if (data === "end") ws.send(JSON.stringify({ type: "done" }));
        else { JSON.parse(data); ws.send(JSON.stringify({ type: "ready", sample_rate: 16000 })); }
      } else {
        packets++;
        ws.send(JSON.stringify({ type: "chunk", index: packets - 1, at: packets,
          text: packets === 1 ? "Hello " : "world." }));
      }
    } },
  });
  const rows = new Map<number, Caption>();
  let reads = 0;
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "",
    async () => ++reads <= 2 ? { audio: wav(), at: reads } : null,
    async (_text, draft) => {
      if (draft) return "临时译文";
      throw new Error("final model unavailable");
    },
    (row) => rows.set(row.id, { ...row }), () => {}, 0, 5);
  try {
    await session.poll();
    await Bun.sleep(20);
    await session.poll();
    await session.finish();
    const row = [...rows.values()][0];
    expect(row.translated).toBe("临时译文");
    expect(row.translationFinal).toBe(false);
    expect(row.final).toBe(true);
    expect(row.error).toContain("final model unavailable");
  } finally { session.cancel(); server.stop(true); }
});

test("unavailable streaming server reports failure and finish terminates", async () => {
  const server = Bun.serve({ port: 0, fetch() { return new Response("unavailable", { status: 503 }); } });
  const errors: string[] = [];
  const session = new VibeVoiceCaptions(`http://localhost:${server.port}`, "", async () => null,
    async () => "", () => {}, (error) => errors.push(error));
  try { await session.finish(); expect(errors.length).toBeGreaterThan(0); }
  finally { session.cancel(); server.stop(true); }
});
