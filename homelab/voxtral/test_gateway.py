import base64
import os
import unittest

os.environ.setdefault("VOXTRAL_UPSTREAM_URL", "ws://127.0.0.1:7871/v1/realtime")

from gateway import EventBridge, StreamStats, append_event, session_update, upstream_url


class VoxtralProtocolTests(unittest.TestCase):
    def test_stream_stats_distinguish_audio_delivery_from_caption_delivery(self):
        stats = StreamStats(started_at=100.0)
        stats.record_audio(3200, now=101.0)
        bridge = EventBridge(stats=stats, clock=lambda: 101.0)
        bridge.translate({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "Hello",
        }, elapsed=0.1)

        snapshot = stats.snapshot(now=106.0)
        self.assertEqual(snapshot["audio_packets"], 1)
        self.assertEqual(snapshot["audio_bytes"], 3200)
        self.assertEqual(snapshot["audio_seconds"], 0.1)
        self.assertEqual(snapshot["caption_chunks"], 1)
        self.assertEqual(snapshot["seconds_since_audio"], 5.0)
        self.assertEqual(snapshot["seconds_since_caption"], 5.0)

    def test_upstream_url_adds_the_selected_model_without_accepting_credentials(self):
        url = upstream_url(
            "ws://127.0.0.1:7871/v1/realtime",
            "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit",
        )
        self.assertIn("model=mlx-community%2FVoxtral-Mini-4B-Realtime-2602-4bit", url)
        with self.assertRaises(ValueError):
            upstream_url("ws://user:secret@127.0.0.1:7871/v1/realtime", "model")

    def test_session_declares_16khz_pcm_and_server_vad_turn_boundaries(self):
        message = session_update()
        audio = message["session"]["audio"]["input"]
        self.assertEqual(audio["format"], {"type": "audio/pcm", "rate": 16000})
        self.assertEqual(audio["turn_detection"], {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 300,
            "silence_duration_ms": 700,
        })

    def test_session_can_disable_turn_detection_for_the_final_flush(self):
        message = session_update(turn_detection=False)
        self.assertIsNone(message["session"]["audio"]["input"]["turn_detection"])

    def test_pcm_is_encoded_for_the_openai_realtime_wire_format(self):
        raw = b"\x01\x02\x03\x04"
        self.assertEqual(append_event(raw), {
            "type": "input_audio_buffer.append",
            "audio": base64.b64encode(raw).decode("ascii"),
        })

    def test_incremental_tokens_map_to_ordered_cortex_chunks(self):
        bridge = EventBridge()
        self.assertEqual(bridge.translate({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": "Hello",
        }, elapsed=0.48), {"type": "chunk", "index": 0, "at": 0.48, "text": "Hello"})
        self.assertEqual(bridge.translate({
            "type": "conversation.item.input_audio_transcription.delta",
            "delta": " world",
        }, elapsed=0.96), {"type": "chunk", "index": 1, "at": 0.96, "text": " world"})
        self.assertIsNone(bridge.translate({"type": "session.updated"}, elapsed=1.0))

    def test_intermediate_turn_completion_keeps_the_cortex_session_open(self):
        bridge = EventBridge()
        self.assertIsNone(bridge.translate({
            "type": "input_audio_buffer.committed",
        }, elapsed=1.0))
        self.assertIsNone(bridge.translate({
            "type": "conversation.item.input_audio_transcription.completed",
        }, elapsed=1.1))
        self.assertEqual(bridge.committed_turns, 1)
        self.assertEqual(bridge.completed_turns, 1)
        self.assertEqual(bridge.session_updates, 0)

        self.assertIsNone(bridge.translate({"type": "session.updated"}, elapsed=1.2))
        self.assertEqual(bridge.session_updates, 1)

    def test_upstream_errors_are_exposed_without_leaking_structures(self):
        bridge = EventBridge()
        self.assertEqual(bridge.translate({
            "type": "error", "error": {"message": "model failed"},
        }, elapsed=0), {"type": "error", "error": "model failed"})


if __name__ == "__main__":
    unittest.main()
