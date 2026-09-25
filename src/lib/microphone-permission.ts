export type MicrophonePermissionPreflight = PermissionState | "unavailable";

interface MediaDevicesLike {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MicrophonePermissionEnvironment {
  mediaDevices?: MediaDevicesLike;
}

function defaultEnvironment(): MicrophonePermissionEnvironment {
  if (typeof navigator === "undefined") return {};
  return {
    mediaDevices: navigator.mediaDevices,
  };
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }
  return "";
}

/**
 * Request a real audio stream so the operating system can show and register its
 * microphone permission prompt. Every acquired track is stopped immediately.
 */
export async function preflightMicrophonePermission(
  environment: MicrophonePermissionEnvironment = defaultEnvironment(),
): Promise<MicrophonePermissionPreflight> {
  const mediaDevices = environment.mediaDevices;
  if (!mediaDevices?.getUserMedia) return "unavailable";

  try {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return "granted";
  } catch (error) {
    const name = errorName(error);
    return name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError"
      ? "denied"
      : "unavailable";
  }
}
