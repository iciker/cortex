"""Resume-safe parallel downloader for the official Cortex Voxtral checkpoint."""

import argparse
import hashlib
import os
import shutil
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


def byte_ranges(total: int, workers: int) -> list[tuple[int, int]]:
    if total <= 0 or workers <= 0:
        raise ValueError("total and workers must be positive")
    chunk = (total + workers - 1) // workers
    return [(start, min(total - 1, start + chunk - 1)) for start in range(0, total, chunk)]


def remaining_range(start: int, end: int, downloaded: int) -> tuple[int, int] | None:
    expected = end - start + 1
    if downloaded < 0 or downloaded > expected:
        raise ValueError("partial segment has an unexpected size")
    if downloaded == expected:
        return None
    return start + downloaded, end


def _download_part(url: str, path: Path, start: int, end: int) -> Path:
    expected = end - start + 1
    if path.exists() and path.stat().st_size == expected:
        return path
    temporary = path.with_suffix(path.suffix + ".tmp")
    failures = 0
    while True:
        downloaded = temporary.stat().st_size if temporary.exists() else 0
        pending = remaining_range(start, end, downloaded)
        if pending is None:
            os.replace(temporary, path)
            return path
        request_start, request_end = pending
        request = urllib.request.Request(
            url,
            headers={
                "Range": f"bytes={request_start}-{request_end}",
                "User-Agent": "Cortex-Voxtral-Setup/1",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                if response.status != 206:
                    raise RuntimeError(
                        f"server ignored byte range {request_start}-{request_end}: HTTP {response.status}"
                    )
                content_range = response.headers.get("Content-Range", "")
                if not content_range.startswith(f"bytes {request_start}-{request_end}/"):
                    raise RuntimeError(
                        f"unexpected Content-Range for {request_start}-{request_end}: {content_range}"
                    )
                before = downloaded
                with temporary.open("ab") as output:
                    shutil.copyfileobj(response, output, length=1024 * 1024)
                downloaded = temporary.stat().st_size
                if downloaded <= before:
                    raise RuntimeError(f"model segment {start}-{end} made no progress")
                failures = 0
        except (OSError, RuntimeError) as error:
            failures += 1
            if failures >= 20:
                raise RuntimeError(
                    f"model segment {start}-{end} failed after {failures} retries"
                ) from error
            time.sleep(min(failures, 10))


def merge_parts(parts: list[Path], sizes: list[int], destination: Path, expected_sha256: str) -> None:
    if len(parts) != len(sizes) or any(path.stat().st_size != size for path, size in zip(parts, sizes)):
        raise ValueError("downloaded model part has an unexpected size")
    temporary = destination.with_suffix(destination.suffix + ".merging")
    digest = hashlib.sha256()
    with temporary.open("wb") as output:
        for part in parts:
            with part.open("rb") as source:
                while block := source.read(1024 * 1024):
                    output.write(block)
                    digest.update(block)
    if expected_sha256 and digest.hexdigest() != expected_sha256:
        temporary.unlink(missing_ok=True)
        raise ValueError("downloaded model failed SHA-256 verification")
    os.replace(temporary, destination)


def download(url: str, destination: Path, total: int, expected_sha256: str, workers: int) -> None:
    if destination.exists() and destination.stat().st_size == total:
        with destination.open("rb") as existing:
            digest = hashlib.file_digest(existing, "sha256").hexdigest()
        if digest == expected_sha256:
            print(f"Model already verified: {destination}")
            return
    part_dir = destination.parent / ".model-parts"
    part_dir.mkdir(parents=True, exist_ok=True)
    ranges = byte_ranges(total, workers)
    parts = [part_dir / f"{index:02d}.part" for index in range(len(ranges))]
    with ThreadPoolExecutor(max_workers=len(ranges)) as pool:
        futures = {
            pool.submit(_download_part, url, path, start, end): index
            for index, (path, (start, end)) in enumerate(zip(parts, ranges))
        }
        for completed, future in enumerate(as_completed(futures), start=1):
            future.result()
            print(f"Downloaded model segment {completed}/{len(parts)}", flush=True)
    merge_parts(parts, [end - start + 1 for start, end in ranges], destination, expected_sha256)
    for part in parts:
        part.unlink()
    part_dir.rmdir()
    print(f"Model verified: {destination}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()
    args.destination.parent.mkdir(parents=True, exist_ok=True)
    download(args.url, args.destination, args.size, args.sha256, args.workers)


if __name__ == "__main__":
    main()
