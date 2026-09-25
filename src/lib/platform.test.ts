import { describe, expect, test } from "bun:test";
import { detectMacOS } from "./platform";

describe("macOS platform detection", () => {
  test("recognizes a full macOS user agent", () => {
    expect(detectMacOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "")).toBe(true);
  });

  test("recognizes Tauri WKWebView from navigator.platform", () => {
    expect(detectMacOS("Mozilla/5.0", "MacIntel")).toBe(true);
  });

  test("does not treat iOS or Windows as macOS", () => {
    expect(detectMacOS("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)", "MacIntel")).toBe(false);
    expect(detectMacOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32")).toBe(false);
  });
});
