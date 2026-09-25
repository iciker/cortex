import { describe, expect, test } from "bun:test";
import { describeMicrophoneFailure } from "./recorder-errors";

describe("microphone error guidance", () => {
  test("turns a denied macOS request into actionable permission guidance", () => {
    expect(describeMicrophoneFailure({ name: "NotAllowedError" }, true)).toEqual({
      message: "Microphone permission is off. Allow Cortex in System Settings → Privacy & Security → Microphone, then try again.",
      canOpenSettings: true,
    });
  });

  test("distinguishes a missing device from a busy device", () => {
    expect(describeMicrophoneFailure({ name: "NotFoundError" }, false)).toEqual({
      message: "No microphone was found. Connect or enable an input device, then try again.",
      canOpenSettings: false,
    });
    expect(describeMicrophoneFailure({ name: "NotReadableError" }, false)).toEqual({
      message: "The microphone is unavailable or is being used by another app. Close other recording apps, then try again.",
      canOpenSettings: false,
    });
  });

  test("does not expose raw browser exception text for unknown failures", () => {
    expect(describeMicrophoneFailure(new Error("private implementation detail"), true)).toEqual({
      message: "Cortex couldn't start the microphone. Check your input device and system privacy settings, then try again.",
      canOpenSettings: true,
    });
  });
});
