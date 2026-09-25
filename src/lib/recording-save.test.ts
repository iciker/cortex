import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import * as api from "./api";

// Execute the actual save/retry methods without mounting an audio device or webview.
const source = readFileSync(new URL("./recorder.svelte.ts", import.meta.url), "utf8");
const methods = source.slice(source.indexOf("  async confirmSave()"), source.indexOf("  // ════════════════════ live bilingual captions"));
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`class Review { ${methods} }`);

test("failed transcript commit keeps the review; retry uses the saved audio only once", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const calls: string[] = [];
  const commits: unknown[] = [];
  let rejectCommit = true;
  let successes = 0;
  mockIPC((command, args) => {
    calls.push(command);
    if (command === "save_recording_raw") return { source: { id: "saved-audio" } };
    if (command === "commit_live_transcript") {
      commits.push(args);
      if (rejectCommit) throw new Error("disk full");
      return;
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  try {
    const app = { refresh: async () => {}, pushToast: () => { successes++; }, openSubject: () => {}, setTab: () => {} };
    const review = new Function("api", "app", `${compiled}; return new Review();`)(api, app);
    Object.assign(review, {
      reviewSubjectId: "subject", reviewName: "Lecture", reviewTopicId: "", reviewDuration: "1:00",
      reviewSourceLabel: "microphone", reviewPath: "", reviewSavedSourceId: "", reviewExt: "wav",
      reviewBytes: new Uint8Array([1, 2]), reviewTranscript: "Original words\n中文翻译",
      reviewUsesLiveTranscript: true, status: "review", stopCaptions() {},
    });
    await review.confirmSave();
    expect(review.status).toBe("review");
    expect(review.reviewTranscript).toBe("Original words\n中文翻译");
    expect(review.reviewSavedSourceId).toBe("saved-audio");
    expect(review.errorMsg).toContain("disk full");
    expect(successes).toBe(0);
    rejectCommit = false;
    await Promise.all([review.confirmSave(), review.confirmSave()]);
    expect(calls).toEqual(["save_recording_raw", "commit_live_transcript", "commit_live_transcript"]);
    expect(commits[0]).toEqual(commits[1]);
    expect(review.status).toBe("ready");
    expect(review.reviewTranscript).toBe("");
    expect(review.reviewSavedSourceId).toBe("");
    expect(successes).toBe(1);
  } finally {
    clearMocks();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
