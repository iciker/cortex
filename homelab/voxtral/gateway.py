"""Authenticated Cortex PCM gateway for MLX Audio's Voxtral Realtime server."""

import asyncio
import base64
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from websockets.asyncio.client import connect


MODEL = os.environ.get(
    "VOXTRAL_MODEL",
    "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
)
UPSTREAM = os.environ.get("VOXTRAL_UPSTREAM_URL", "ws://127.0.0.1:7871/v1/realtime")
TOKEN = os.environ.get("VOXTRAL_TOKEN", "")
ORIGINS = {
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
}

app = FastAPI()
busy = False


def upstream_url(address: str, model: str) -> str:
    parsed = urlsplit(address.strip())
    if parsed.scheme not in {"ws", "wss"} or not parsed.hostname:
        raise ValueError("VOXTRAL_UPSTREAM_URL must be a ws:// or wss:// URL")
    if parsed.username or parsed.password or parsed.fragment:
        raise ValueError("Voxtral upstream URL must not contain credentials or a fragment")
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["model"] = model
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def session_update(*, turn_detection: bool = True) -> dict:
    return {
        "type": "session.update",
        "session": {
            "audio": {
                "input": {
                    "format": {"type": "audio/pcm", "rate": 16000},
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 700,
                    } if turn_detection else None,
                }
            }
        },
    }


def append_event(raw: bytes) -> dict:
    return {
        "type": "input_audio_buffer.append",
        "audio": base64.b64encode(raw).decode("ascii"),
    }


@dataclass
class StreamStats:
    started_at: float
    audio_packets: int = 0
    audio_bytes: int = 0
    caption_chunks: int = 0
    last_audio_at: float | None = None
    last_caption_at: float | None = None

    def record_audio(self, size: int, *, now: float | None = None) -> None:
        self.audio_packets += 1
        self.audio_bytes += size
        self.last_audio_at = time.monotonic() if now is None else now

    def record_caption(self, *, now: float | None = None) -> None:
        self.caption_chunks += 1
        self.last_caption_at = time.monotonic() if now is None else now

    def snapshot(self, *, now: float | None = None) -> dict:
        current = time.monotonic() if now is None else now
        return {
            "elapsed_seconds": round(max(0.0, current - self.started_at), 1),
            "audio_packets": self.audio_packets,
            "audio_bytes": self.audio_bytes,
            "audio_seconds": round(self.audio_bytes / 2 / 16000, 3),
            "caption_chunks": self.caption_chunks,
            "seconds_since_audio": None if self.last_audio_at is None else round(max(0.0, current - self.last_audio_at), 1),
            "seconds_since_caption": None if self.last_caption_at is None else round(max(0.0, current - self.last_caption_at), 1),
        }


@dataclass
class EventBridge:
    stats: StreamStats | None = None
    clock: Callable[[], float] = time.monotonic
    index: int = 0
    session_updates: int = 0
    committed_turns: int = 0
    completed_turns: int = 0

    def translate(self, event: dict, elapsed: float) -> dict | None:
        kind = event.get("type")
        if kind == "session.updated":
            self.session_updates += 1
            return None
        if kind == "input_audio_buffer.committed":
            self.committed_turns += 1
            return None
        if kind == "conversation.item.input_audio_transcription.delta":
            text = event.get("delta")
            if not isinstance(text, str) or not text:
                return None
            if self.stats:
                self.stats.record_caption(now=self.clock())
            message = {
                "type": "chunk",
                "index": self.index,
                "at": max(0.0, float(elapsed)),
                "text": text,
            }
            self.index += 1
            return message
        if kind == "conversation.item.input_audio_transcription.completed":
            # A completion now marks one VAD-delimited speech turn, not the
            # entire Cortex recording. The gateway sends the sole client-level
            # `done` only after Cortex explicitly ends the recording.
            self.completed_turns += 1
            return None
        if kind == "error":
            error = event.get("error")
            message = error.get("message") if isinstance(error, dict) else error
            return {"type": "error", "error": str(message or "Voxtral realtime transcription failed")}
        return None


@app.get("/healthz")
def health() -> dict:
    return {
        "status": "ok",
        "model": MODEL,
        "protocol": "cortex-pcm-v1",
        "upstream": UPSTREAM,
        "busy": busy,
    }


@app.websocket("/ws/cortex")
async def cortex_stream(ws: WebSocket) -> None:
    global busy
    origin = ws.headers.get("origin")
    if origin and origin not in ORIGINS:
        await ws.close(code=1008)
        return
    await ws.accept()
    claimed = False
    upstream = None
    pump = None
    reporter = None
    stats = StreamStats(started_at=time.monotonic())
    client = ws.client.host if ws.client else "unknown"
    try:
        hello = await asyncio.wait_for(ws.receive_json(), timeout=10)
        if TOKEN and not hmac.compare_digest(str(hello.get("token", "")), TOKEN):
            raise ValueError("Invalid Voxtral access token")
        if hello.get("protocol") != "cortex-pcm-v1":
            raise ValueError("Unsupported streaming protocol")
        if busy:
            raise ValueError("Voxtral is serving another recording; try again later")
        busy = claimed = True

        upstream = await connect(upstream_url(UPSTREAM, MODEL), max_size=2**20)
        first = json.loads(await asyncio.wait_for(upstream.recv(), timeout=120))
        if first.get("type") == "error":
            mapped = EventBridge().translate(first, 0)
            raise RuntimeError(mapped["error"] if mapped else "Voxtral failed to start")
        if first.get("type") != "session.created":
            raise RuntimeError("Voxtral returned an unexpected handshake")
        await upstream.send(json.dumps(session_update()))

        while True:
            configured = json.loads(await asyncio.wait_for(upstream.recv(), timeout=30))
            if configured.get("type") == "session.updated":
                break
            if configured.get("type") == "error":
                mapped = EventBridge().translate(configured, 0)
                raise RuntimeError(mapped["error"] if mapped else "Voxtral setup failed")

        await ws.send_json({"type": "ready", "sample_rate": 16000})
        bridge = EventBridge(stats=stats)
        received_samples = 0
        progress = asyncio.Event()
        upstream_error: str | None = None

        async def wait_for_progress(predicate, timeout: float, message: str) -> None:
            async def wait() -> None:
                while not predicate():
                    if upstream_error:
                        raise RuntimeError(upstream_error)
                    progress.clear()
                    if predicate():
                        break
                    await progress.wait()

            try:
                await asyncio.wait_for(wait(), timeout=timeout)
            except TimeoutError as error:
                raise TimeoutError(message) from error

        async def pump_results() -> None:
            nonlocal upstream_error
            async for payload in upstream:
                event = json.loads(payload)
                mapped = bridge.translate(event, received_samples / 16000)
                progress.set()
                if mapped:
                    await ws.send_json(mapped)
                    if mapped["type"] == "error":
                        upstream_error = mapped["error"]
                        progress.set()
                        return

        async def report_health() -> None:
            while True:
                await asyncio.sleep(10)
                print(
                    f"[voxtral-gateway] client={client} health="
                    f"{json.dumps(stats.snapshot(), sort_keys=True)}",
                    flush=True,
                )

        pump = asyncio.create_task(pump_results())
        reporter = asyncio.create_task(report_health())
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()
            if message.get("text") == "end":
                # Drain every VAD turn before the one final manual commit. The
                # session.updated acknowledgement is an ordering barrier: all
                # earlier auto-commit events have already crossed the upstream
                # socket when it arrives, so the following counters belong to
                # this final commit rather than a racing silence boundary.
                update_target = bridge.session_updates + 1
                await upstream.send(json.dumps(session_update(turn_detection=False)))
                await wait_for_progress(
                    lambda: bridge.session_updates >= update_target,
                    timeout=30,
                    message="Voxtral did not acknowledge the final session update",
                )
                commit_target = bridge.committed_turns + 1
                await upstream.send(json.dumps({"type": "input_audio_buffer.commit"}))
                await wait_for_progress(
                    lambda: bridge.committed_turns >= commit_target
                    and bridge.completed_turns >= commit_target,
                    timeout=60,
                    message="Voxtral did not finish the final speech turn",
                )
                await ws.send_json({"type": "done"})
                break
            raw = message.get("bytes")
            if raw is None or len(raw) % 2 or len(raw) > 320000:
                raise ValueError("Expected at most ten seconds of mono 16 kHz PCM16")
            received_samples += len(raw) // 2
            stats.record_audio(len(raw))
            await upstream.send(json.dumps(append_event(raw)))
    except WebSocketDisconnect:
        pass
    except Exception as error:
        try:
            await ws.send_json({"type": "error", "error": str(error)})
        except Exception:
            pass
    finally:
        if reporter:
            reporter.cancel()
            await asyncio.gather(reporter, return_exceptions=True)
        if pump:
            pump.cancel()
            await asyncio.gather(pump, return_exceptions=True)
        if upstream:
            await upstream.close()
        if claimed:
            busy = False
        print(
            f"[voxtral-gateway] client={client} final="
            f"{json.dumps(stats.snapshot(), sort_keys=True)}",
            flush=True,
        )
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("VOXTRAL_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "::1", "localhost"} and len(TOKEN) < 24:
        raise SystemExit("LAN binding requires VOXTRAL_TOKEN with at least 24 characters")
    uvicorn.run(app, host=host, port=int(os.environ.get("VOXTRAL_PORT", "7870")), access_log=False)
