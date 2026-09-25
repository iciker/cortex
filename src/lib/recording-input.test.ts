import { describe, expect, test } from "bun:test";
import { hasRecordingInput, recordingInputs } from "./recording-input";

describe("recording input preference", () => {
  test("defaults to microphone on and system audio off", () => {
    expect(recordingInputs(undefined, undefined, true)).toEqual({
      microphone: true,
      systemAudio: false,
    });
  });

  test("supports microphone-only, system-only and combined selections", () => {
    expect(recordingInputs("true", "false", true)).toEqual({ microphone: true, systemAudio: false });
    expect(recordingInputs("false", "true", true)).toEqual({ microphone: false, systemAudio: true });
    expect(recordingInputs("true", "true", true)).toEqual({ microphone: true, systemAudio: true });
  });

  test("ignores an unavailable system-audio selection off macOS", () => {
    expect(recordingInputs("false", "true", false)).toEqual({ microphone: false, systemAudio: false });
  });

  test("detects when no input source is selected", () => {
    expect(hasRecordingInput({ microphone: false, systemAudio: false })).toBe(false);
    expect(hasRecordingInput({ microphone: true, systemAudio: false })).toBe(true);
    expect(hasRecordingInput({ microphone: false, systemAudio: true })).toBe(true);
  });
});
