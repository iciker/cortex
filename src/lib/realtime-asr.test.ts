import { expect, test } from "bun:test";
import { normalizeLiveAsrProvider, realtimeAsrDisplayName } from "./realtime-asr";

test("legacy VibeVoice settings migrate to Voxtral Realtime", () => {
  expect(normalizeLiveAsrProvider("vibevoice")).toBe("voxtral");
  expect(normalizeLiveAsrProvider("voxtral")).toBe("voxtral");
  expect(normalizeLiveAsrProvider("whisper")).toBe("whisper");
  expect(normalizeLiveAsrProvider("unknown")).toBe("whisper");
});

test("the live caption backend is named for the model users selected", () => {
  expect(realtimeAsrDisplayName("voxtral")).toBe("Voxtral Realtime 4B");
  expect(realtimeAsrDisplayName("whisper")).toBe("Whisper");
});
