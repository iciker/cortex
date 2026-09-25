#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
runtime="$task_root/.local/voxtral"
model="mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit"
model_dir="$runtime/model"
mkdir -p "$runtime"
uv venv --python 3.12 "$runtime/venv"
uv pip install --python "$runtime/venv/bin/python" -r "$task_root/homelab/voxtral/requirements.txt"
VOXTRAL_MODEL="$model" MODEL_DIR="$model_dir" HF_HOME="$runtime/hf-cache" HF_HUB_DISABLE_XET=1 \
  "$runtime/venv/bin/python" -c \
  'import os; from huggingface_hub import snapshot_download; snapshot_download(os.environ["VOXTRAL_MODEL"], local_dir=os.environ["MODEL_DIR"], allow_patterns=["config.json", "model.safetensors.index.json", "tekken.json", "README.md"], max_workers=4)'
"$runtime/venv/bin/python" "$task_root/homelab/voxtral/download_model.py" \
  "https://huggingface.co/$model/resolve/main/model.safetensors" \
  "$model_dir/model.safetensors" \
  --size 3133798126 \
  --sha256 6f59b425d8a1ceb2de795454558be63937cf75b59f9c9bc77accd85aaf32af05 \
  --workers "${VOXTRAL_DOWNLOAD_WORKERS:-24}"
echo "Voxtral runtime and model are ready."
