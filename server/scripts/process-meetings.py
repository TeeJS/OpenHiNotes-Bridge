#!/usr/bin/env python3
"""Diarizer batch driver run from inside the OpenHiNotes-Bridge container.

Triggered by the bridge's POST /api/process (which spawns whatever
HIDOCK_PROCESS_CMD points at). Reads every *.wav under HIDOCK_STORAGE_PATH,
starts the meeting-diarizer container via the mounted docker socket, POSTs
each file to it, writes results under DIARIZER_OUTPUT_DIR, archives originals,
and stops the diarizer when done. All status goes to stderr so the bridge
captures it for the UI.
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib import error, request
from urllib.parse import urlsplit, urlunsplit

DEFAULT_URL = os.environ.get("DIARIZER_URL", "http://192.168.1.25:10301/transcribe")
DEFAULT_INPUT_DIR = os.environ.get("HIDOCK_STORAGE_PATH", "/data")
DEFAULT_OUTPUT_DIR = os.environ.get("DIARIZER_OUTPUT_DIR", "/output")
DEFAULT_THRESHOLD = float(os.environ.get("DIARIZER_THRESHOLD", "0.35"))
DEFAULT_CONTAINER = os.environ.get("MEETING_DIARIZER_CONTAINER", "meeting-diarizer")
DEFAULT_READY_TIMEOUT = int(os.environ.get("DIARIZER_READY_TIMEOUT", "300"))
DEFAULT_SKIP_POWER = os.environ.get("DIARIZER_SKIP_POWER_MGMT", "").lower() in ("1", "true", "yes")

TIMEOUT = 3600

MONTH_ABBR = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04",
    "May": "05", "Jun": "06", "Jul": "07", "Aug": "08",
    "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
}


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_recording_filename(stem: str):
    """Match the YYYYMonDD-HHMMSS prefix and return (year, month_num).

    Anything after the 16-char prefix is ignored, so files renamed with a
    trailing suffix (e.g. ``2026Jun12-160000-MeetingName``) still route
    correctly. Returns None if the prefix doesn't match — the caller logs and
    skips, preserving the original "fail loud, don't silently misroute" rule.
    """
    if len(stem) < 16:
        return None
    year, mon_abbr, day, sep, time_part = stem[:4], stem[4:7], stem[7:9], stem[9], stem[10:16]
    if not year.isdigit() or not day.isdigit() or not time_part.isdigit():
        return None
    if sep != "-" or mon_abbr not in MONTH_ABBR:
        return None
    return year, MONTH_ABBR[mon_abbr]


def find_json_for_wav(wav_path: Path):
    wav_stem = wav_path.stem
    for candidate in wav_path.parent.iterdir():
        if candidate.is_file() and candidate.suffix.lower() == ".json":
            json_stem = candidate.stem
            if json_stem == wav_stem:
                return candidate
            json_stem_replaced = json_stem.replace(' - ', '_-_').replace(' -_', '_').replace(' ', '_')
            if json_stem_replaced == wav_stem:
                return candidate
    return None


def build_attendees(metadata: dict) -> list:
    """Build de-duplicated attendee list from meeting metadata.

    Names are passed through to the server as-is — no normalization. The
    server matches them exactly against enrolled speaker names and logs
    unrecognized names as a warning, so any drift is visible in the bridge UI.
    """
    seen = set()
    ordered = []

    def add(name):
        if not name:
            return
        n = str(name).strip()
        if n and n not in seen:
            seen.add(n)
            ordered.append(n)

    add(metadata.get("organizer", ""))
    for n in metadata.get("required_attendees", []) or []:
        add(n)
    for n in metadata.get("optional_attendees", []) or []:
        add(n)

    return ordered


def post_audio(audio_path: Path, url: str, threshold: float, attendees=None) -> dict:
    boundary = "----OpenHiNotesBoundary"
    filename = audio_path.name

    with open(audio_path, "rb") as f:
        audio_bytes = f.read()

    log(f"  Sending file to diarizer: {filename}")
    log(f"  File size: {len(audio_bytes) / 1024 / 1024:.1f} MB")
    log(f"  Service URL: {url}")
    log(f"  Threshold: {threshold}")
    if attendees:
        log(f"  Attendees passed ({len(attendees)}): {', '.join(attendees)}")
    else:
        log("  Attendees passed: (none — no offset bias)")

    parts = []
    parts.append(
        (f"--{boundary}\r\n"
         f'Content-Disposition: form-data; name="audio"; filename="{filename}"\r\n'
         f"Content-Type: audio/wav\r\n\r\n").encode()
    )
    parts.append(audio_bytes)
    parts.append(
        (f"\r\n--{boundary}\r\n"
         f'Content-Disposition: form-data; name="threshold"\r\n\r\n').encode()
    )
    parts.append(str(threshold).encode())
    if attendees:
        parts.append(
            (f"\r\n--{boundary}\r\n"
             f'Content-Disposition: form-data; name="attendees"\r\n\r\n').encode()
        )
        parts.append(",".join(attendees).encode("utf-8"))
    parts.append(f"\r\n--{boundary}--\r\n".encode())

    body = b"".join(parts)

    req = request.Request(
        url,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
        method="POST",
    )

    with request.urlopen(req, timeout=TIMEOUT) as resp:
        raw = resp.read().decode("utf-8")

    return json.loads(raw)


def sanitize_subject(subject: str) -> str:
    bad = '/\\:*?"<>|'
    for c in bad:
        subject = subject.replace(c, "-")
    subject = "-".join(subject.split())
    while "--" in subject:
        subject = subject.replace("--", "-")
    return subject.strip("-")


def load_metadata(json_path):
    if not json_path:
        return {}
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log(f"  Warning: could not read JSON metadata: {e}")
        return {}


def print_speaker_summary(segments: list, metadata: dict) -> None:
    speaker_counts = Counter(
        str(seg.get("speaker") or "UNKNOWN").strip()
        for seg in segments
        if str(seg.get("text") or "").strip()
    )

    log("  Diarization result:")
    log(f"    Total transcript segments: {sum(speaker_counts.values())}")

    if speaker_counts:
        for speaker, count in speaker_counts.most_common():
            log(f"    {speaker}: {count} segment(s)")
    else:
        log("    No speaker-labeled segments returned.")

    if metadata:
        log("  Metadata:")
        log(f"    Subject: {metadata.get('subject', '')}")
        log(f"    Organizer: {metadata.get('organizer', '')}")
        log(f"    Required attendees: {', '.join(metadata.get('required_attendees', []))}")
        log(f"    Optional attendees: {', '.join(metadata.get('optional_attendees', []))}")


def has_transcript_text(segments: list) -> bool:
    return any(str(seg.get("text") or "").strip() for seg in segments)


def process_file(wav_path: Path, json_path, input_dir: Path, output_dir: Path,
                 threshold: float, url: str) -> None:
    log("")
    log(f"Processing: {wav_path.name}")

    parsed = parse_recording_filename(wav_path.stem)
    if parsed is None:
        log(f"  Skipping: filename does not match YYYYMonDD-HHMMSS: {wav_path.name}")
        return
    year, month = parsed

    archive_dir = input_dir / ".archive" / f"{month}-{year[2:4]}"
    metadata = load_metadata(json_path)

    is_recurring = bool(metadata.get("is_recurring", False))
    subject = metadata.get("subject", "")
    safe_subject = sanitize_subject(subject) if subject else ""

    if is_recurring and safe_subject:
        outdir = output_dir / year / safe_subject
        log("  Meeting type: recurring")
    else:
        outdir = output_dir / year / month
        log("  Meeting type: one-off or unknown")

    details_dir = outdir / "details"

    log(f"  Input WAV: {wav_path}")
    log(f"  Companion JSON: {json_path if json_path else 'not found'}")
    log(f"  Output details folder: {details_dir}")
    log(f"  Archive folder: {archive_dir}")

    details_dir.mkdir(parents=True, exist_ok=True)
    archive_dir.mkdir(parents=True, exist_ok=True)

    wav_copy = details_dir / wav_path.name
    shutil.copy2(wav_path, wav_copy)
    log(f"  Copied WAV to output: {wav_copy}")

    if json_path:
        json_copy = details_dir / json_path.name
        shutil.copy2(json_path, json_copy)
        log(f"  Copied JSON to output: {json_copy}")

    attendees = build_attendees(metadata)

    try:
        result = post_audio(wav_copy, url, threshold, attendees=attendees)
    except Exception as e:
        log(f"  Transcription failed: {e}")
        log("  Source files were NOT archived.")
        return

    segments = result.get("segments", [])

    if not has_transcript_text(segments):
        log(f"  Empty transcript in diarizer response. Source files were NOT archived: {wav_path.name}")
        return

    response_file = details_dir / f"{wav_path.stem}-diarizer-response.json"
    if response_file.exists():
        mtime = datetime.fromtimestamp(response_file.stat().st_mtime)
        timestamp = mtime.strftime("%Y%m%d-%H%M%S")
        backup_path = response_file.parent / f"{response_file.name}.{timestamp}.bak"
        response_file.rename(backup_path)
        log(f"  Backed up existing response: {backup_path.name}")
    with open(response_file, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)
    log(f"  Saved diarizer JSON: {response_file}")

    print_speaker_summary(segments, metadata)

    wav_archive = archive_dir / wav_path.name
    shutil.move(str(wav_path), str(wav_archive))
    log(f"  Archived source WAV: {wav_archive}")

    if json_path:
        json_archive = archive_dir / json_path.name
        shutil.move(str(json_path), str(json_archive))
        log(f"  Archived source JSON: {json_archive}")
    else:
        log("  No source JSON found to archive.")

    log("  Done.")


def diarizer_base_url(url: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, "/health", "", ""))


def run_docker(args: list) -> None:
    """Run `docker <args...>` via the mounted /var/run/docker.sock.

    Fails fast if the CLI is missing or the socket isn't mounted, so the
    misconfiguration shows up in the bridge UI immediately rather than as a
    confusing readiness timeout.
    """
    full = ["docker", *args]
    log(f"  $ {' '.join(full)}")
    result = subprocess.run(full, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"docker command failed (exit {result.returncode}): {' '.join(args)} | "
            f"stderr: {result.stderr.strip()}"
        )
    out = result.stdout.strip()
    if out:
        log(f"    {out}")


def wait_until_ready(health_url: str, timeout: int) -> bool:
    """Poll the diarizer until its HTTP server answers.

    Any HTTP response — including an error status — means uvicorn is up and
    its models have finished loading, so the batch can proceed.
    """
    deadline = time.monotonic() + timeout
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            with request.urlopen(request.Request(health_url, method="GET"), timeout=15):
                log(f"  Diarizer is ready (after {attempt} check(s)).")
                return True
        except error.HTTPError:
            log(f"  Diarizer is ready (server responded after {attempt} check(s)).")
            return True
        except (error.URLError, socket.timeout, OSError):
            log(f"  Waiting for diarizer to come up... (check {attempt})")
            time.sleep(5)
    return False


def start_diarizer(container: str, health_url: str, ready_timeout: int) -> None:
    log(f"Starting diarizer container '{container}' ...")
    run_docker(["start", container])
    if not wait_until_ready(health_url, ready_timeout):
        raise RuntimeError(
            f"Diarizer did not become ready within {ready_timeout}s of starting."
        )


def stop_diarizer(container: str) -> None:
    log(f"Stopping diarizer container '{container}' ...")
    try:
        run_docker(["stop", container])
        log("  Diarizer stopped — GPU memory released.")
    except Exception as e:
        log(f"  WARNING: could not stop diarizer container: {e}")


def run_batch(wav_files, input_dir, output_dir, threshold, url) -> None:
    for wav in wav_files:
        json_path = find_json_for_wav(wav)
        process_file(wav, json_path, input_dir, output_dir, threshold, url)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Diarizer batch driver — runs inside OpenHiNotes-Bridge container.",
    )
    parser.add_argument("--input-dir", default=DEFAULT_INPUT_DIR)
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
    parser.add_argument("--threshold", type=float, default=DEFAULT_THRESHOLD)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--diarizer-container", default=DEFAULT_CONTAINER)
    parser.add_argument("--ready-timeout", type=int, default=DEFAULT_READY_TIMEOUT)
    parser.add_argument("--no-power-mgmt", action="store_true",
                        default=DEFAULT_SKIP_POWER,
                        help="Skip starting/stopping the diarizer container.")

    args = parser.parse_args()

    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()

    log(f"Input directory: {input_dir}")
    log(f"Output directory: {output_dir}")
    log(f"Diarizer URL: {args.url}")
    log(f"Threshold: {args.threshold}")

    if not input_dir.exists():
        log(f"Error: input directory does not exist: {input_dir}")
        sys.exit(1)

    if not output_dir.exists():
        log(f"Error: output directory does not exist: {output_dir}")
        sys.exit(1)

    wav_files = sorted(p for p in input_dir.glob("*.wav") if p.is_file())

    log(f"WAV files found: {len(wav_files)}")

    if not wav_files:
        log("No WAV files found.")
        return

    if args.no_power_mgmt:
        log("Power management disabled — assuming diarizer container is already running.")
        run_batch(wav_files, input_dir, output_dir, args.threshold, args.url)
        return

    health_url = diarizer_base_url(args.url)
    try:
        start_diarizer(args.diarizer_container, health_url, args.ready_timeout)
        run_batch(wav_files, input_dir, output_dir, args.threshold, args.url)
    finally:
        stop_diarizer(args.diarizer_container)


if __name__ == "__main__":
    main()
