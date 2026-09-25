export interface MicrophoneFailure {
  message: string;
  canOpenSettings: boolean;
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/** Convert browser-specific capture failures into stable, actionable UI copy. */
export function describeMicrophoneFailure(error: unknown, isMacOS: boolean): MicrophoneFailure {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "SecurityError":
    case "PermissionDeniedError":
      return {
        message: isMacOS
          ? "Microphone permission is off. Allow Cortex in System Settings → Privacy & Security → Microphone, then try again."
          : "Microphone permission is off. Allow Cortex in your system privacy settings, then try again.",
        canOpenSettings: isMacOS,
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return {
        message: "No microphone was found. Connect or enable an input device, then try again.",
        canOpenSettings: false,
      };
    case "NotReadableError":
    case "TrackStartError":
      return {
        message: "The microphone is unavailable or is being used by another app. Close other recording apps, then try again.",
        canOpenSettings: false,
      };
    default:
      return {
        message: "Cortex couldn't start the microphone. Check your input device and system privacy settings, then try again.",
        canOpenSettings: isMacOS,
      };
  }
}
