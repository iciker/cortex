import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("macOS microphone bundle permissions", () => {
  test("signs macOS builds with the audio-input entitlement", () => {
    const entitlements = readFileSync(new URL("./Entitlements.plist", import.meta.url), "utf8");
    expect(entitlements).toContain("com.apple.security.device.audio-input");
    expect(entitlements).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);

    for (const config of ["tauri.macos.conf.json", "tauri.macos.local.conf.json"]) {
      const json = JSON.parse(readFileSync(new URL(`./${config}`, import.meta.url), "utf8"));
      expect(json.bundle.macOS.entitlements).toBe("Entitlements.plist");
    }
  });

  test("declares why combined recordings need ScreenCaptureKit access", () => {
    const info = readFileSync(new URL("./Info.plist", import.meta.url), "utf8");
    expect(info).toContain("NSScreenCaptureUsageDescription");
    expect(info).toContain("system audio");
  });
});
