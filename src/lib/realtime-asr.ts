export type LiveAsrProvider = "whisper" | "voxtral";

/** Keep existing installs working while persisting the new provider name. */
export function normalizeLiveAsrProvider(value: string | null | undefined): LiveAsrProvider {
  return value === "voxtral" || value === "vibevoice" ? "voxtral" : "whisper";
}

export function realtimeAsrDisplayName(provider: string): string {
  return normalizeLiveAsrProvider(provider) === "voxtral" ? "Voxtral Realtime 4B" : "Whisper";
}
