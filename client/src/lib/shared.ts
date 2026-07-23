import { AudioRecording } from '@/types';

export function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export async function uploadBlob(
  blob: Blob,
  filename: string,
  onProgress?: (pct: number) => void,
): Promise<{ name: string; size: number; mtime: string }> {
  // Use XHR for upload-progress support (fetch lacks request-progress).
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', blob, filename);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable && onProgress) {
        onProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.response);
      } else {
        const msg = xhr.response?.error ?? `HTTP ${xhr.status}`;
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(form);
  });
}

// Recognize the date-prefix layouts that the WebUSB driver's parseFilenameDate
// also accepts — if the device filename starts with one of these, we trust
// rec.dateCreated and emit an ISO stem; otherwise we keep the original stem
// so we never replace a meaningful name with a "now"-stamped guess.
const DEVICE_DATE_PREFIX = new RegExp(
  '^(?:' +
    String.raw`\d{14}` +                                          // 20260619222322...
    '|' +
    String.raw`\d{4}[A-Za-z]{3}\d{1,2}-\d{6}` +                   // 2026Jun19-222322...
    '|' +
    String.raw`\d{4}[-_]?\d{2}[-_]?\d{2}[-_]\d{2}\d{2}(?:\d{2})?` + // HDA_20260619_222322 / 2026-06-19_2223...
  ')',
);

export function targetFilename(rec: AudioRecording): string {
  // Server stores as .wav since the device's raw PCM gets a WAV header
  // wrapped onto it by deviceService.downloadFile. (If the source was MPEG
  // the bytes are still MPEG inside; .wav is the safe pipeline-default
  // extension. The Blob's own MIME type stays correct for inline playback.)
  //
  // Rename: prefer YYYY-MM-DD_HH-MM-SS.wav so files sort/pair cleanly with
  // companion meeting JSONs downstream. The HiDock's per-session -RecNN
  // counter is intentionally dropped — second-resolution timestamps are
  // already collision-proof for human-cadence recording.
  if (DEVICE_DATE_PREFIX.test(rec.fileName)) {
    const d = rec.dateCreated;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${stamp}.wav`;
  }
  // Filename doesn't look like a HiDock-style date prefix — fall back to
  // the original stem so we don't replace something meaningful with a
  // wall-clock guess (parseFilenameDate returns `new Date()` on failure).
  const base = rec.fileName.replace(/\.(hda|wav|mp3|mpeg)$/i, '');
  return `${base}.wav`;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
