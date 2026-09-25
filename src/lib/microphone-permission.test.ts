import { describe, expect, test } from "bun:test";
import { preflightMicrophonePermission } from "./microphone-permission";

describe("microphone permission preflight", () => {
  test("requests access and immediately releases the microphone", async () => {
    let stopped = false;
    let requests = 0;
    const result = await preflightMicrophonePermission({
      mediaDevices: {
        getUserMedia: async () => {
          requests += 1;
          return { getTracks: () => [{ stop: () => (stopped = true) }] } as unknown as MediaStream;
        },
      },
    });

    expect(result).toBe("granted");
    expect(requests).toBe(1);
    expect(stopped).toBe(true);
  });

  test("returns denied when the operating system rejects the request", async () => {
    let requests = 0;
    const result = await preflightMicrophonePermission({
      mediaDevices: {
        getUserMedia: async () => {
          requests += 1;
          throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        },
      },
    });

    expect(result).toBe("denied");
    expect(requests).toBe(1);
  });

  test("returns unavailable when media capture is not exposed", async () => {
    expect(await preflightMicrophonePermission({})).toBe("unavailable");
  });
});
