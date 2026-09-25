import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("realtime-only transcription", () => {
  test("makes Voxtral captions the no-Whisper path in settings", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");

    expect(settings).toContain('type TranscriptionMode = "realtime" | "local" | "cloud" | "homelab"');
    expect(settings).toContain('setTranscriptionMode("realtime")');
    expect(settings).toContain('transcription_mode: transcriptionMode');
    expect(settings).toContain('liveAsrProvider === "voxtral") transcriptionMode = "realtime"');
    expect(settings).toContain("Whisper is never started, downloaded or called");
    expect(settings).toContain('caption_draft: { provider: "lmstudio", model: "qwen3.5-4b-mlx"');
    expect(settings).toContain('caption_final: { provider: "lmstudio", model: "qwen3.8-27b-mlx", budget: "512"');
  });

  test("configures both local model services and routes caption models independently", () => {
    const settings = readFileSync("src/views/Settings.svelte", "utf8");

    expect(settings).toContain('id: "caption_draft", label: "Live caption draft"');
    expect(settings).toContain('id: "caption_final", label: "Final caption"');
    expect(settings).toContain("Local model services");
    expect(settings).toContain("Ollama URL");
    expect(settings).toContain("LM Studio URL");
    expect(settings).toContain('verifyLocalProvider("ollama")');
    expect(settings).toContain('verifyLocalProvider("lmstudio")');

    const keyMeta = settings.slice(
      settings.indexOf("const keyMeta = ["),
      settings.indexOf("] as const;", settings.indexOf("const keyMeta = [")),
    );
    expect(keyMeta).not.toContain('id: "lmstudio_url"');
    expect(keyMeta).not.toContain('id: "lmstudio_api_key"');
  });

  test("guards every backend audio path before Whisper can run", () => {
    const commands = readFileSync("src-tauri/src/commands.rs", "utf8");

    expect(commands).toContain('fn realtime_only(state: &AppState) -> bool');
    expect(commands).toContain('if realtime_only(&state)');
    expect(commands).toContain('if live_transcript.is_none() && realtime_only(&state)');
    expect(commands).toContain("Whisper is disabled in Realtime only mode");
    expect(commands).toContain("audio saved · Whisper disabled · no realtime transcript");
  });

  test("keeps the homelab Whisper service opt-in", () => {
    const compose = readFileSync("homelab/docker-compose.yml", "utf8");

    expect(compose).toContain('profiles: ["whisper"]');
    expect(compose).toContain("docker compose --profile whisper up -d");
  });
});
