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
import re
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
# Optional explicit work list. JSON array of filenames (relative to the input
# dir), set by the bridge when the user clicks "Process selected". Unset/empty
# means "process every *.wav", preserving the original all-files behavior.
DEFAULT_FILES_RAW = os.environ.get("HIDOCK_FILES", "")

TIMEOUT = 3600
JSON_TIME_TOLERANCE_SECONDS = 7 * 60

MONTH_ABBR = {
    "Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04",
    "May": "05", "Jun": "06", "Jul": "07", "Aug": "08",
    "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12",
}
def iso_stamp(dt: datetime, with_seconds: bool = True) -> str:
    """Format a datetime as ``YYYY-MM-DD_HH-MM-SS`` to match what the bridge
    writes on push. Used by surfaces a human (or downstream tool) sorts:
    task-list manifests, heading dates."""
    return dt.strftime("%Y-%m-%d_%H-%M-%S" if with_seconds else "%Y-%m-%d")


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def parse_files_env(raw: str):
    """Parse the optional HIDOCK_FILES env var: a JSON array of filenames.

    Returns a list of names, or None if unset/empty/malformed. A malformed
    value falls back to None (process all) rather than aborting, but logs a
    warning so the misconfiguration is visible in the bridge UI.
    """
    if not raw or not raw.strip():
        return None
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        log("WARNING: HIDOCK_FILES is not valid JSON — ignoring it and processing all files.")
        return None
    if not isinstance(data, list):
        log("WARNING: HIDOCK_FILES is not a JSON array — ignoring it and processing all files.")
        return None
    names = [str(x).strip() for x in data if str(x).strip()]
    return names or None


def select_wav_files(names, input_dir: Path):
    """Resolve a list of requested filenames to validated WAV paths in input_dir.

    Each name is reduced to its basename (defense in depth — the bridge already
    validates, but the script must never walk outside its input dir) and kept
    only if it exists, is a regular file, and ends in .wav. Anything skipped is
    logged so the omission is visible in the run output.
    """
    selected = []
    for name in names:
        base = os.path.basename(name)
        if base != name or not base:
            log(f"  Skipping requested file (unsafe or empty name): {name!r}")
            continue
        if not base.lower().endswith(".wav"):
            log(f"  Skipping requested file (not a .wav): {base}")
            continue
        candidate = input_dir / base
        if not candidate.is_file():
            log(f"  Skipping requested file (not found in input dir): {base}")
            continue
        selected.append(candidate)
    return sorted(selected)


# HiDock-native stems:  2026Jun19-222322[-anything]   or   2026Jun19[-anything]
_HIDOCK_PREFIX_RE = re.compile(
    r'^(?P<y>\d{4})(?P<mon>[A-Z][a-z]{2})(?P<d>\d{2})'
    r'(?:-(?P<hh>\d{2})(?P<mm>\d{2})(?P<ss>\d{2}))?'
)
# ISO stems written by the bridge UI on push:
#   2026-06-19_22-23-22[-anything]   or   2026-06-19[-anything]
# Tolerant of either `_` or `-` separating date from time, since either
# is a reasonable choice and one-character drift shouldn't lose a pairing.
_ISO_PREFIX_RE = re.compile(
    r'^(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})'
    r'(?:[_-](?P<hh>\d{2})-(?P<mm>\d{2})-(?P<ss>\d{2}))?'
)


def _match_date_prefix(stem: str):
    """Return the regex match for whichever known date-prefix layout the
    stem starts with, or None. Used by both parse_date_time (which needs
    the captured groups) and wav_suffix_after_prefix (which needs the
    end position so it can correctly slice past either prefix style)."""
    m = _HIDOCK_PREFIX_RE.match(stem)
    if m is not None:
        return m
    return _ISO_PREFIX_RE.match(stem)


def parse_date_time(stem: str):
    """Extract (date_iso, seconds_since_midnight_or_None) from a filename stem.

    Accepts two prefix layouts so HiDock-native filenames and the ISO names
    the bridge writes on push can pair against each other transparently:

      HiDock:  YYYYMonDD[-HHMMSS][-anything]    e.g. 2026Jun19-222322-Rec00
      ISO:     YYYY-MM-DD[_HH-MM-SS][-anything] e.g. 2026-06-19_22-23-22

    Everything after the date/time prefix is ignored — the goal is just to
    recover a date (and an optional time) for fuzzy pairing. Returns None
    if neither prefix layout matches.
    """
    m = _match_date_prefix(stem)
    if m is None:
        return None

    groups = m.groupdict()
    if "mon" in groups and groups["mon"] is not None:
        month_num = MONTH_ABBR.get(groups["mon"])
        if month_num is None:
            return None
    else:
        month_num = groups["m"]
    date_iso = f"{groups['y']}-{month_num}-{groups['d']}"

    time_seconds = None
    if groups.get("hh") is not None:
        hh, mm, ss = int(groups["hh"]), int(groups["mm"]), int(groups["ss"])
        if 0 <= hh < 24 and 0 <= mm < 60 and 0 <= ss < 60:
            time_seconds = hh * 3600 + mm * 60 + ss
    return date_iso, time_seconds


def parse_recording_filename(stem: str):
    """For WAV routing: returns (year, month_num) or None."""
    parsed = parse_date_time(stem)
    if parsed is None:
        return None
    year, month_num, _ = parsed[0].split("-")
    return year, month_num


def wav_suffix_after_prefix(stem: str) -> str:
    """Return the part of a WAV stem after the date/time prefix.

    HiDock:  ``2026Jun20-122844-Rec00`` -> ``Rec00``
    ISO:     ``2026-06-19_22-23-22-Rec00`` -> ``Rec00``  (post-bridge legacy)
    ISO:     ``2026-06-19_22-23-22`` -> ``''``           (bridge default)

    Returns ``''`` if the stem doesn't carry a date/time prefix at all, or
    if there's nothing past the prefix. Used to keep ``-RecNN`` style
    disambiguators when renaming a WAV to match its companion JSON's stem.
    """
    m = _match_date_prefix(stem)
    if m is None:
        return ''
    end = m.end()
    # Accept either `-` or `_` as the separator between prefix and suffix;
    # HiDock always uses `-`, ISO names mostly do too but a date-only ISO
    # stem like `2026-06-19_meeting subject` uses `_` after the date.
    if end < len(stem) and stem[end] in ('-', '_'):
        return stem[end + 1:]
    return ''


_DEDUP_NORMALIZE_RE = re.compile(r'\s+')


def _normalize_for_dedup(s: str) -> str:
    """Lowercase + treat ``_`` and ``-`` as spaces + collapse whitespace.
    Lets ``PTS_AI_data_on_Rosie`` substring-match against
    ``…-PTS AI data on Rosie`` so the rename doesn't duplicate the subject.
    """
    return _DEDUP_NORMALIZE_RE.sub(' ', s.lower().replace('_', ' ').replace('-', ' ')).strip()


def rename_wav_to_match_json(wav_path: Path, json_path: Path) -> Path:
    """Rename WAV in place so its stem matches the JSON's, return new path.

    If the WAV stem was ``2026Jun20-122844-Rec00`` and JSON stem is
    ``2026Jun20-123000-discuss the script``, the WAV becomes
    ``2026Jun20-123000-discuss the script-Rec00.wav``. With no suffix on the
    WAV (just date+time), the result drops the trailing hyphen and matches
    the JSON stem exactly.

    If the WAV's suffix is already substantively present in the JSON stem
    (e.g. WAV suffix ``PTS_AI_data_on_Rosie`` and JSON contains
    ``PTS AI data on Rosie``), the suffix is dropped to avoid a doubled
    name like ``…-PTS AI data on Rosie-PTS_AI_data_on_Rosie.wav``. The
    HiDock-native ``Rec00`` style suffixes don't trigger this — Outlook
    subjects never contain a literal ``Rec00`` substring.

    Collisions get a numeric ``-2``, ``-3``, … suffix so two WAVs sharing
    one JSON never overwrite each other.
    """
    if wav_path.stem == json_path.stem:
        return wav_path

    suffix = wav_suffix_after_prefix(wav_path.stem)
    if suffix and _normalize_for_dedup(suffix) in _normalize_for_dedup(json_path.stem):
        # Subject already represented in the JSON stem — drop it.
        suffix = ''
    base = f"{json_path.stem}-{suffix}" if suffix else json_path.stem
    new_path = wav_path.with_name(f"{base}{wav_path.suffix}")

    if new_path.exists() and new_path.resolve() != wav_path.resolve():
        for n in range(2, 100):
            candidate = wav_path.with_name(f"{base}-{n}{wav_path.suffix}")
            if not candidate.exists():
                new_path = candidate
                break
        else:
            log(f"  WARNING: could not find a free rename target for {wav_path.name}; skipping rename")
            return wav_path

    wav_path.rename(new_path)
    log(f"  Renamed WAV to match JSON stem: {new_path.name}")
    return new_path


def find_json_for_wav(wav_path: Path):
    """Pair a WAV to its Outlook metadata JSON by date (+ time if both have it).

    HiDock WAVs are named ``YYYYMonDD-HHMMSS-Rec00.wav``; Outlook metadata
    JSONs are named ``YYYYMonDD-<subject>.json`` (or sometimes with a time
    too). The match rule is: same date, and — if both files carry a time —
    within ±7 minutes. Everything after the date/time prefix is ignored.

    If multiple JSONs match, prefer the one with a time over a date-only
    match, then the smallest time delta, then alphabetical (stable).
    """
    wav_parsed = parse_date_time(wav_path.stem)
    if wav_parsed is None:
        return None
    wav_date, wav_time = wav_parsed

    candidates = []
    for candidate in wav_path.parent.iterdir():
        if not candidate.is_file() or candidate.suffix.lower() != ".json":
            continue
        j_parsed = parse_date_time(candidate.stem)
        if j_parsed is None:
            continue
        j_date, j_time = j_parsed
        if j_date != wav_date:
            continue
        if wav_time is not None and j_time is not None:
            diff = abs(wav_time - j_time)
            if diff > JSON_TIME_TOLERANCE_SECONDS:
                continue
            has_time = True
        else:
            diff = 0
            has_time = False
        # Sort key: (date-only is worse than timed match, then smaller diff, then name)
        candidates.append(((0 if has_time else 1), diff, candidate.name, candidate))

    if not candidates:
        return None
    candidates.sort()
    return candidates[0][3]


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
                 threshold: float, url: str, archive_json: bool = True,
                 processed: list = None) -> None:
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

    if json_path and archive_json:
        json_archive = archive_dir / json_path.name
        shutil.move(str(json_path), str(json_archive))
        log(f"  Archived source JSON: {json_archive}")
    elif json_path and not archive_json:
        log(f"  JSON already archived by a previous WAV this batch: {json_path.name}")
    else:
        log("  No source JSON found to archive.")

    if processed is not None:
        processed.append({
            "wav_stem": wav_path.stem,
            "response_file": response_file,
            "metadata_file": (details_dir / json_path.name) if json_path else None,
            "details_dir": details_dir,
            "subject": metadata.get("subject", ""),
            "organizer": metadata.get("organizer", ""),
            "is_recurring": is_recurring,
        })

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


def write_manifest(processed: list, output_dir: Path, run_started: datetime) -> Path:
    """Drop a markdown checklist of the run's outputs into <output>/task-list/.

    Designed to be dragged into a Claude cowork chat: the file tells the
    assistant exactly which diarizer responses to clean up and gives both
    the response JSON and the meeting metadata JSON for each meeting.

    Paths are written relative to the meetings root (the `output_dir` the
    script ran with) using forward slashes, so the consumer can prepend
    whatever absolute prefix they're using — `/output` inside the bridge
    container, `/mnt/user/data/media/meetings` on Unraid,
    `\\\\192.168.1.25\\data\\media\\meetings` over SMB, or a mapped drive
    letter — without the script having to know which.
    """
    if not processed:
        return None

    task_list_dir = output_dir / "task-list"
    task_list_dir.mkdir(parents=True, exist_ok=True)

    stamp = iso_stamp(run_started)
    manifest_path = task_list_dir / f"{stamp}.md"
    if manifest_path.exists():
        # Two runs in the same second — unlikely but cheap to guard against.
        for n in range(2, 100):
            candidate = task_list_dir / f"{stamp}-{n}.md"
            if not candidate.exists():
                manifest_path = candidate
                break

    def rel(p: Path) -> str:
        return p.relative_to(output_dir).as_posix()

    lines = []
    lines.append(f"# Diarizer batch — {run_started.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")
    lines.append(f"{len(processed)} meeting(s) processed. Paths below are relative to the meetings root ({output_dir.as_posix()} inside this container). For each item, run the `transcript-cleanup-agent` skill on the diarizer response JSON.")
    lines.append("")
    lines.append("## Meetings")
    lines.append("")
    for p in processed:
        subject = p["subject"] or p["wav_stem"]
        organizer = p.get("organizer") or ""
        recurring = " (recurring)" if p.get("is_recurring") else ""
        header = f"- [ ] **{subject}**{recurring}"
        if organizer:
            header += f" — {organizer}"
        lines.append(header)
        lines.append(f"    - Diarizer response: `{rel(p['response_file'])}`")
        if p["metadata_file"] is not None:
            lines.append(f"    - Meeting metadata: `{rel(p['metadata_file'])}`")
    lines.append("")

    manifest_path.write_text("\n".join(lines), encoding="utf-8")
    return manifest_path


def run_batch(wav_files, input_dir, output_dir, threshold, url, run_started: datetime) -> None:
    # Track JSONs already paired this batch so a JSON shared by multiple WAVs
    # (HiDock's Rec00, Rec01, … for one meeting) gets attached to every WAV
    # but is only moved to .archive/ once.
    seen_jsons = set()
    processed = []
    for wav in wav_files:
        json_path = find_json_for_wav(wav)
        archive_json = json_path is not None and json_path not in seen_jsons
        if json_path is not None:
            seen_jsons.add(json_path)
            # Rename the WAV in /data so all downstream artifacts
            # (details/ copies, -diarizer-response.json, archive) share a
            # stem with the meeting JSON. Lets tools that pair by exact
            # stem match upstream/downstream of this script.
            wav = rename_wav_to_match_json(wav, json_path)
        process_file(wav, json_path, input_dir, output_dir, threshold, url,
                     archive_json=archive_json, processed=processed)

    if processed:
        manifest = write_manifest(processed, output_dir, run_started)
        if manifest is not None:
            log("")
            log(f"Manifest written: {manifest}")
            log(f"  ({len(processed)} meeting(s) ready for transcript cleanup)")


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
    parser.add_argument("--files", nargs="*", default=None,
                        help="Process only these WAV filenames (basename, in the "
                             "input dir) instead of every *.wav. Overrides the "
                             "HIDOCK_FILES env var. Omit to process all.")

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

    # An explicit work list (CLI --files, else the HIDOCK_FILES env var) means
    # "process only these"; otherwise fall back to processing every *.wav.
    requested = args.files if args.files is not None else parse_files_env(DEFAULT_FILES_RAW)
    if requested is not None:
        log(f"Explicit file list requested ({len(requested)}): {', '.join(requested)}")
        wav_files = select_wav_files(requested, input_dir)
        log(f"WAV files selected: {len(wav_files)} of {len(requested)} requested")
        if not wav_files:
            log("None of the requested files were usable WAVs. Nothing to do.")
            return
    else:
        wav_files = sorted(p for p in input_dir.glob("*.wav") if p.is_file())
        log(f"WAV files found: {len(wav_files)}")
        if not wav_files:
            log("No WAV files found.")
            return

    run_started = datetime.now()

    if args.no_power_mgmt:
        log("Power management disabled — assuming diarizer container is already running.")
        run_batch(wav_files, input_dir, output_dir, args.threshold, args.url, run_started)
        return

    health_url = diarizer_base_url(args.url)
    try:
        start_diarizer(args.diarizer_container, health_url, args.ready_timeout)
        run_batch(wav_files, input_dir, output_dir, args.threshold, args.url, run_started)
    finally:
        stop_diarizer(args.diarizer_container)


if __name__ == "__main__":
    main()
