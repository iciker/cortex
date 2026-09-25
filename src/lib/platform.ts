// Mobile vs desktop platform detection for the shell branch (see docs/MOBILE_PORT.md §3).
//
// Detection uses the webview user-agent — Tauri's mobile webview reports the OS in
// its UA — so it needs NO extra Tauri plugin (zero backend change for the shell pass).
// When the real mobile build is wired up this should move to `@tauri-apps/plugin-os`
// `platform()` for robustness; until then UA + a dev force-flag is enough.
//
// Dev preview: the mobile shell normally renders only on a phone. To preview it on the
// desktop webview, append `?mobile` to the URL or run in devtools:
//     localStorage.setItem("cortex_force_mobile", "1"); location.reload();
// Turn it off with `setForceMobile(false)` (exposed on window for convenience below).

function ua(): string {
  return typeof navigator !== "undefined" ? navigator.userAgent : "";
}

function navigatorPlatform(): string {
  return typeof navigator !== "undefined" ? navigator.platform : "";
}

export function detectMacOS(userAgent: string, platform: string): boolean {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return false;
  return /Macintosh|Mac OS X/i.test(userAgent) || /^Mac/i.test(platform);
}

function forcedMobile(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (new URLSearchParams(window.location.search).has("mobile")) return true;
    return window.localStorage.getItem("cortex_force_mobile") === "1";
  } catch {
    return false;
  }
}

export const isIOS = /iPad|iPhone|iPod/i.test(ua());
export const isAndroid = /Android/i.test(ua());
// Tauri's WKWebView can expose a minimal user agent, while navigator.platform
// still reports MacIntel. Check both so macOS-only controls render in the app.
export const isMacOS = detectMacOS(ua(), navigatorPlatform());
/** True on a phone/tablet build (or when the dev force-flag is set). */
export const isMobile = forcedMobile() || isIOS || isAndroid;

/** Toggle the dev preview flag then reload. Also reachable as window.setForceMobile. */
export function setForceMobile(on: boolean): void {
  try {
    if (on) window.localStorage.setItem("cortex_force_mobile", "1");
    else window.localStorage.removeItem("cortex_force_mobile");
    window.location.reload();
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  (window as unknown as { setForceMobile?: typeof setForceMobile }).setForceMobile = setForceMobile;
}
