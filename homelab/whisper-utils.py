"""Compatibility copy of whisper-asr-webservice's utility module.

The upstream loader feeds uploads to FFmpeg over a non-seekable stdin pipe.
That produces an empty waveform for M4A/MP4 files whose index is at the end of
the file. Cortex records M4A on macOS, so decode uploads through a temporary,
seekable file instead. The result writers remain API-compatible with upstream.
"""

import json
import os
import tempfile
from dataclasses import asdict
from typing import BinaryIO, TextIO

import ffmpeg
import numpy as np
from faster_whisper.utils import format_timestamp

from app.config import CONFIG


class ResultWriter:
    extension: str

    def __init__(self, output_dir: str):
        self.output_dir = output_dir

    def __call__(self, result: dict, audio_path: str):
        audio_basename = os.path.basename(audio_path)
        output_path = os.path.join(self.output_dir, audio_basename + "." + self.extension)
        with open(output_path, "w", encoding="utf-8") as output_file:
            self.write_result(result, file=output_file)

    def write_result(self, result: dict, file: TextIO):
        raise NotImplementedError


class WriteTXT(ResultWriter):
    extension = "txt"

    def write_result(self, result: dict, file: TextIO):
        for segment in result["segments"]:
            print(segment.text.strip(), file=file, flush=True)


class WriteVTT(ResultWriter):
    extension = "vtt"

    def write_result(self, result: dict, file: TextIO):
        print("WEBVTT\n", file=file)
        for segment in result["segments"]:
            print(
                f"{format_timestamp(segment.start)} --> {format_timestamp(segment.end)}\n"
                f"{segment.text.strip().replace('-->', '->')}\n",
                file=file,
                flush=True,
            )


class WriteSRT(ResultWriter):
    extension = "srt"

    def write_result(self, result: dict, file: TextIO):
        for index, segment in enumerate(result["segments"], start=1):
            print(
                f"{index}\n"
                f"{format_timestamp(segment.start, always_include_hours=True, decimal_marker=',')} --> "
                f"{format_timestamp(segment.end, always_include_hours=True, decimal_marker=',')}\n"
                f"{segment.text.strip().replace('-->', '->')}\n",
                file=file,
                flush=True,
            )


class WriteTSV(ResultWriter):
    extension = "tsv"

    def write_result(self, result: dict, file: TextIO):
        print("start", "end", "text", sep="\t", file=file)
        for segment in result["segments"]:
            print(round(1000 * segment.start), file=file, end="\t")
            print(round(1000 * segment.end), file=file, end="\t")
            print(segment.text.strip().replace("\t", " "), file=file, flush=True)


class WriteJSON(ResultWriter):
    extension = "json"

    def write_result(self, result: dict, file: TextIO):
        if "segments" in result:
            result["segments"] = [asdict(segment) for segment in result["segments"]]
        json.dump(result, file)


def load_audio(file: BinaryIO, encode=True, sr: int = CONFIG.SAMPLE_RATE):
    """Return a 16 kHz mono float32 waveform from an uploaded audio stream."""
    if not encode:
        raw_audio = file.read()
        return np.frombuffer(raw_audio, np.int16).flatten().astype(np.float32) / 32768.0

    upload = file.read()
    if not upload:
        raise RuntimeError("Failed to load audio: the uploaded file is empty")

    temporary_path = None
    try:
        with tempfile.NamedTemporaryFile(prefix="cortex-whisper-", suffix=".audio", delete=False) as temporary:
            temporary.write(upload)
            temporary_path = temporary.name

        out, _ = (
            ffmpeg.input(temporary_path, threads=0)
            .output("-", format="s16le", acodec="pcm_s16le", ac=1, ar=sr)
            .run(cmd="ffmpeg", capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as error:
        detail = error.stderr.decode(errors="replace") if error.stderr else str(error)
        raise RuntimeError(f"Failed to load audio: {detail}") from error
    finally:
        if temporary_path is not None:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass

    if not out:
        raise RuntimeError("Failed to load audio: FFmpeg decoded an empty waveform")
    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0
