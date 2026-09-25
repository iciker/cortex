export type RecordingInputs = {
  microphone: boolean;
  systemAudio: boolean;
};

export function recordingInputs(
  microphoneValue: string | null | undefined,
  systemAudioValue: string | null | undefined,
  macOS: boolean,
): RecordingInputs {
  return {
    microphone: microphoneValue !== "false",
    systemAudio: macOS && systemAudioValue === "true",
  };
}

export function hasRecordingInput(inputs: RecordingInputs): boolean {
  return inputs.microphone || inputs.systemAudio;
}
