# Voxtral realtime captions — TDD evidence

## Red

- `bun test src/lib/realtime-asr.test.ts` failed because the provider migration module did not exist.
- `python -m unittest discover -s homelab/voxtral` failed because the gateway did not exist.
- The resumable-download test failed before `remaining_range` was implemented.

## Green

- `bun test`: 38 passed, 0 failed.
- Voxtral gateway/download tests: 9 passed, 0 failed.
- `bun run check`, `cargo check`, `bun run i18n:audit`, and `git diff --check` passed.
- The 3,133,798,126-byte model matched SHA-256 `6f59b425d8a1ceb2de795454558be63937cf75b59f9c9bc77accd85aaf32af05`.

## Real audio

The production gateway streamed a 7.67-second, mono 16 kHz English sample at
real-time speed. With 240 ms model delay and 250 ms client chunks, the first
caption arrived after 0.829 seconds and the final transcript matched the sample:

> Today we are studying English pronunciation. Each syllable has one vowel sound. Please listen carefully and write down three examples.

This checks ASR latency and completeness on one clean sample. It does not prove
accuracy for noisy lectures, accents, simultaneous speakers, or translation-model latency.

## 2026-09-22 — draft-first translation and newest-first display

User journeys:

- A completed short sentence shows a fast provisional translation before the final model replaces it.
- The newest live caption stays at the top while saved/exported transcripts remain chronological.

Red evidence:

- `bun test src/lib/vibevoice.test.ts src/lib/live-captions.test.ts` ran the new cases and failed `2` tests: short sentences called the final model first, and `Recorder.svelte` rendered captions oldest-first while pinning the scroll position to the bottom.

Green evidence:

- `bun test`: `54` passed, `0` failed.
- `bun run check`: `0` errors and `0` warnings.
- `bun run build`: production Vite build completed.
- `bun run i18n:audit`: `0 untranslated static strings across 58 Svelte files`.
- `git diff --check`: passed.
- `bun test --coverage src/lib/vibevoice.test.ts src/lib/live-captions.test.ts`: `13` passed with `97.37%` function and `100%` line coverage across the two changed caption modules.

The tests guarantee draft-before-final ordering for short completed sentences,
replacement by the final translation, newest-first display, and chronological
source-array preservation. They do not benchmark the selected LM Studio models
or replace an installed-app recording test.

## 2026-09-23 — reliable Intel-client capture and stream diagnostics

User journeys:

- A lower-power laptop captures realtime microphone audio outside the WebView
  main thread so rendering and translation work cannot drop input frames.
- Stopping a recording flushes the last partial PCM packet before ending the
  Voxtral session.
- Operators can distinguish client/gateway audio delivery from a model that has
  stopped emitting caption deltas.
- Voxtral starts with the vendor-recommended 480 ms accuracy/latency balance.

Red evidence:

- `bun test src/lib/caption-audio.test.ts` failed because the AudioWorklet
  capture module did not exist.
- `python3 -m unittest homelab/voxtral/test_run_script.py` failed because
  `run.sh` still defaulted to 240 ms.
- `.local/voxtral/venv/bin/python -m unittest homelab/voxtral/test_gateway.py`
  failed because `StreamStats` did not exist.
- `bun test src/lib/vibevoice.test.ts` failed because the client exposed no
  transport diagnostics.

Green evidence:

- `bun test`: `57` passed, `0` failed.
- Voxtral Python discovery: `13` passed, `0` failed.
- `bun run check`: `0` errors and `0` warnings.
- `bun run build`: production Vite build completed and copied
  `caption-audio-worklet.js` byte-for-byte into `dist/`.
- `git diff --check` and `bash -n homelab/voxtral/run.sh`: passed.
- Targeted coverage: `caption-audio.ts` reached `81.82%` function and `97.01%`
  line coverage; `vibevoice.ts` reached `94.87%` function and `100%` line
  coverage.

The tests guarantee continuous 48 kHz to 16 kHz resampling, 100 ms PCM packet
boundaries, final-packet flushing, the 480 ms default, and independent audio and
caption counters at the client and gateway. They do not replace a 30–60 minute
installed Intel-macOS recording with real microphone hardware and the remote
Mac Studio model service.
