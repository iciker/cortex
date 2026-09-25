# Voxtral Realtime for Cortex

This Apple-Silicon service runs the 4-bit Voxtral Realtime 4B checkpoint with
MLX Audio. A small authenticated gateway keeps Cortex's LAN connection token
out of URLs while the model server remains bound to localhost.

```bash
homelab/voxtral/setup.sh
homelab/voxtral/run.sh
```

`run.sh` binds the authenticated gateway to the LAN, creates
`.local/voxtral/token` when needed, and prints the Cortex server address. Copy
the token without printing it on screen with:

```bash
pbcopy < .local/voxtral/token
```

Configure the laptop with the printed `http://<mac-studio-lan-ip>:7870`
address and that token. Run `homelab/voxtral/run.sh --help` for local-only
binding, alternate ports, and other overrides.
The default transcription delay is 480 ms, the model vendor's recommended
accuracy/latency balance. Set `VOXTRAL_DELAY_MS=240` for the lowest latency or
`960` when more context and accuracy matter more than first-caption latency.

LM Studio remains the text translation endpoint. It does not currently expose
its internal Voxtral voice model through a public realtime audio API.
