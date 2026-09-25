import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("recording input settings", () => {
  test("offers an opt-in system-audio switch and persists it", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");

    const integrationsStart = settings.indexOf("<!-- ===== INTEGRATIONS ===== -->");
    const audioStart = settings.indexOf("<!-- ===== AUDIO ===== -->");
    const calendarStart = settings.indexOf("<!-- ===== GOOGLE CALENDAR ===== -->");
    const recordingInput = settings.indexOf('<h3 class="set-group-t">Recording input</h3>');

    expect(settings).toContain('api.setSetting("record_system_audio"');
    expect(settings).toContain('api.setSetting("record_microphone"');
    expect(settings).toContain('s.record_microphone !== "false"');
    expect(settings).toContain('s.record_system_audio === "true"');
    expect(settings).toContain('api.runtimePlatform()');
    expect(settings).toContain("Microphone input");
    expect(settings).toContain("System audio input");
    expect(settings).toContain('aria-label="microphone input"');
    expect(settings).toContain('aria-label="system audio input"');
    expect(recordingInput).toBeGreaterThan(audioStart);
    expect(recordingInput).toBeLessThan(calendarStart);
    expect(recordingInput < integrationsStart || recordingInput > audioStart).toBe(true);
  });

  test("the recorder reads the preference before choosing its capture engine", () => {
    const recorder = readFileSync("src/lib/recorder.svelte.ts", "utf8");

    expect(recorder).toContain('api.getSetting("record_microphone")');
    expect(recorder).toContain('api.getSetting("record_system_audio")');
    expect(recorder).toContain('api.runtimePlatform()');
    expect(recorder).toContain("recordingInputs");
    expect(recorder).toContain("hasRecordingInput");
    expect(recorder).toContain("this.startNative(inputs.microphone, inputs.systemAudio)");
  });

  test("passes independent microphone and system-audio flags to native macOS capture", () => {
    const api = readFileSync("src/lib/api.ts", "utf8");
    const nativeRecorder = readFileSync("src-tauri/src/recorder.rs", "utf8");

    expect(api).toContain("nativeRecStart = (includeMicrophone");
    expect(api).toContain("{ includeMicrophone, includeSystemAudio }");
    expect(nativeRecorder).toContain("pub fn start(include_microphone: bool)");
    expect(nativeRecorder).toContain(".with_captures_microphone(include_microphone)");
    expect(nativeRecorder).toContain("if include_microphone {");
  });
});
