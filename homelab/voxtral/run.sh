#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime="$task_root/.local/voxtral"
python="$runtime/venv/bin/python"
model="${VOXTRAL_MODEL:-$runtime/model}"
upstream_port="${VOXTRAL_UPSTREAM_PORT:-7871}"
gateway_host="${VOXTRAL_HOST:-0.0.0.0}"
gateway_port="${VOXTRAL_PORT:-7870}"
token_file="${VOXTRAL_TOKEN_FILE:-$runtime/token}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: homelab/voxtral/run.sh

Starts Voxtral Realtime 4B and the authenticated Cortex gateway.
The default gateway listens on the LAN at port 7870 and reads its token from:
  .local/voxtral/token

Optional environment variables:
  VOXTRAL_HOST=127.0.0.1       Bind only to this Mac instead of the LAN
  VOXTRAL_PORT=7870            Cortex gateway port
  VOXTRAL_UPSTREAM_PORT=7871   Local MLX Audio port
  VOXTRAL_DELAY_MS=480         Realtime transcription delay (balanced default)
  VOXTRAL_TOKEN=...            Override the saved gateway token
  VOXTRAL_TOKEN_FILE=...       Use another token file
  VOXTRAL_MODEL=...            Use another local model path or model id
EOF
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "Unknown option: $1 (run with --help for usage)." >&2
  exit 2
fi

if [[ ! -x "$python" ]]; then
  echo 'Voxtral runtime is missing. Run homelab/voxtral/setup.sh first.' >&2
  exit 1
fi
if [[ "$model" == "$runtime/model" && ! -f "$model/model.safetensors" ]]; then
  echo 'Voxtral model is missing. Run homelab/voxtral/setup.sh first.' >&2
  exit 1
fi

token="${VOXTRAL_TOKEN:-}"
if [[ -z "$token" && -f "$token_file" ]]; then
  IFS= read -r token < "$token_file"
fi
if [[ -z "$token" ]]; then
  mkdir -p "$(dirname "$token_file")"
  token="$($python -c 'import secrets; print(secrets.token_urlsafe(36))')"
  umask 077
  printf '%s\n' "$token" > "$token_file"
  echo "Created a new Cortex gateway token in $token_file"
fi
if [[ "$gateway_host" != "127.0.0.1" && "$gateway_host" != "::1" && "$gateway_host" != "localhost" && ${#token} -lt 24 ]]; then
  echo 'LAN access requires a gateway token containing at least 24 characters.' >&2
  exit 1
fi

export HF_HOME="${HF_HOME:-$runtime/hf-cache}"
export VOXTRAL_MODEL="$model"
export VOXTRAL_UPSTREAM_URL="ws://127.0.0.1:${upstream_port}/v1/realtime"
export VOXTRAL_HOST="$gateway_host"
export VOXTRAL_PORT="$gateway_port"
export VOXTRAL_TOKEN="$token"

lan_ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
if [[ "$gateway_host" == "0.0.0.0" && -n "$lan_ip" ]]; then
  echo "Cortex gateway: http://${lan_ip}:${gateway_port}"
else
  echo "Cortex gateway: http://${gateway_host}:${gateway_port}"
fi
echo "Gateway token file: $token_file"
echo "Stop Voxtral with Ctrl+C."

"$python" -m mlx_audio.server \
  --host 127.0.0.1 \
  --port "$upstream_port" \
  --realtime-model "$model" \
  --realtime-transcription-delay-ms "${VOXTRAL_DELAY_MS:-480}" &
upstream_pid=$!
trap 'kill "$upstream_pid" 2>/dev/null || true; wait "$upstream_pid" 2>/dev/null || true' EXIT INT TERM

"$python" -u "$task_root/homelab/voxtral/gateway.py"
