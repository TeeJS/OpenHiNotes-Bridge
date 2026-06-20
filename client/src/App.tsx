import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDeviceConnection } from '@/hooks/useDeviceConnection';
import { AudioRecording } from '@/types';

interface ServerConfig {
  storage: string;
  processConfigured: boolean;
  maxUploadBytes: number;
}

interface ServerFile {
  name: string;
  size: number;
  mtime: string;
}

interface JobState {
  id: string;
  status: 'idle' | 'running' | 'success' | 'error';
  command: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  pid: number | null;
}

type RowState = {
  // 0-100 while transferring from device to browser
  downloadPct?: number;
  // 0-100 while uploading from browser to server
  uploadPct?: number;
  // text for last-action result (e.g. "uploaded", "deleted")
  note?: string;
  // is this row being deleted right now?
  deleting?: boolean;
  // currently-playing blob URL (revoked when changed)
  playUrl?: string;
};

const WEBUSB_AVAILABLE = typeof navigator !== 'undefined' && 'usb' in navigator;

function formatBytes(n: number): string {
  if (!n) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x: number) => x.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function formatDate(d: Date): string {
  if (!d || isNaN(d.getTime())) return '—';
  const pad = (x: number) => x.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const AUTO_DELETE_KEY = 'openhinotes_bridge_auto_delete';
const THRESHOLD_KEY = 'openhinotes_bridge_threshold';
const THRESHOLD_DEFAULT = 0.35;
const THRESHOLD_MIN = 0.1;
const THRESHOLD_MAX = 0.9;

async function uploadBlob(
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

function targetFilename(rec: AudioRecording): string {
  // Server stores as .wav since the device's .hda raw PCM gets a WAV header
  // wrapped onto it by deviceService.downloadFile. Strip any .hda extension
  // and add .wav. If the source was already MPEG it gets .mp3.
  // We don't actually know the format until download, but .wav is the safe
  // default — the server is just a passthrough storage anyway and the
  // browser-side blob carries the right MIME via the Blob type.
  const base = rec.fileName.replace(/\.(hda|wav|mp3|mpeg)$/i, '');
  return `${base}.wav`;
}

export default function App() {
  const {
    device,
    recordings,
    error,
    isLoading,
    connectDevice,
    disconnectDevice,
    refreshRecordings,
    downloadRecording,
    deleteRecording,
    deleteFileSilently,
    syncTime,
    clearError,
  } = useDeviceConnection();

  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverFiles, setServerFiles] = useState<ServerFile[]>([]);
  const [job, setJob] = useState<JobState | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null);
  const [autoDelete, setAutoDelete] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_DELETE_KEY) === 'true',
  );
  const [threshold, setThresholdState] = useState<string>(() => {
    if (typeof localStorage === 'undefined') return String(THRESHOLD_DEFAULT);
    const saved = localStorage.getItem(THRESHOLD_KEY);
    return saved ?? String(THRESHOLD_DEFAULT);
  });
  const jobPollRef = useRef<number | null>(null);

  const toggleAutoDelete = useCallback((next: boolean) => {
    setAutoDelete(next);
    try {
      if (next) localStorage.setItem(AUTO_DELETE_KEY, 'true');
      else localStorage.removeItem(AUTO_DELETE_KEY);
    } catch {
      // localStorage unavailable (private mode etc.); not fatal
    }
  }, []);

  const setThreshold = useCallback((next: string) => {
    setThresholdState(next);
    try { localStorage.setItem(THRESHOLD_KEY, next); } catch { /* not fatal */ }
  }, []);

  const thresholdNum = Number(threshold);
  const thresholdValid =
    threshold !== '' && Number.isFinite(thresholdNum) &&
    thresholdNum >= THRESHOLD_MIN && thresholdNum <= THRESHOLD_MAX;

  // Load server config + file list on mount
  useEffect(() => {
    fetch('/api/config').then((r) => r.json()).then(setServerConfig).catch(() => {});
    refreshServerFiles();
  }, []);

  // Auto-refresh recordings when device connects
  useEffect(() => {
    if (device?.connected && recordings.length === 0) {
      refreshRecordings();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.connected]);

  // Poll job status while running
  useEffect(() => {
    if (job?.status !== 'running') {
      if (jobPollRef.current !== null) {
        window.clearInterval(jobPollRef.current);
        jobPollRef.current = null;
      }
      return;
    }
    jobPollRef.current = window.setInterval(async () => {
      try {
        const r = await fetch('/api/status');
        const data = await r.json();
        setJob(data.job);
        if (data.job?.status !== 'running') {
          refreshServerFiles();
        }
      } catch {
        // ignore transient
      }
    }, 1000);
    return () => {
      if (jobPollRef.current !== null) window.clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    };
  }, [job?.status]);

  const refreshServerFiles = useCallback(async () => {
    try {
      const r = await fetch('/api/files');
      const data = await r.json();
      setServerFiles(data.files ?? []);
    } catch {
      // ignore
    }
  }, []);

  const setRow = useCallback((id: string, patch: RowState) => {
    setRowState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));
  }, []);

  const handlePlay = useCallback(async (rec: AudioRecording) => {
    setRow(rec.id, { note: undefined });
    const blob = await downloadRecording(
      rec.fileName,
      rec.size,
      (pct) => setRow(rec.id, { downloadPct: pct }),
      rec.fileVersion,
    );
    if (!blob) return;
    setRow(rec.id, { downloadPct: undefined });
    // Revoke previous url
    const prev = rowState[rec.id]?.playUrl;
    if (prev) URL.revokeObjectURL(prev);
    const url = URL.createObjectURL(blob);
    setRow(rec.id, { playUrl: url });
  }, [downloadRecording, rowState, setRow]);

  const handleDownloadToBrowser = useCallback(async (rec: AudioRecording) => {
    setRow(rec.id, { note: undefined });
    const blob = await downloadRecording(
      rec.fileName,
      rec.size,
      (pct) => setRow(rec.id, { downloadPct: pct }),
      rec.fileVersion,
    );
    setRow(rec.id, { downloadPct: undefined });
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = targetFilename(rec);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
    setRow(rec.id, { note: 'downloaded' });
  }, [downloadRecording, setRow]);

  // Returns true iff the file was successfully removed from the device.
  // Caller is responsible for refreshing the device file list afterwards
  // (single-row Push refreshes inside the click handler; bulk Push waits
  // until the loop is done so we don't pay for a GET_FILE_LIST per row).
  const handlePushToServer = useCallback(async (rec: AudioRecording): Promise<boolean> => {
    setRow(rec.id, { note: undefined });
    const blob = await downloadRecording(
      rec.fileName,
      rec.size,
      (pct) => setRow(rec.id, { downloadPct: pct }),
      rec.fileVersion,
    );
    setRow(rec.id, { downloadPct: undefined });
    if (!blob) return false;

    let serverFile: { name: string; size: number; mtime: string };
    try {
      setRow(rec.id, { uploadPct: 0 });
      serverFile = await uploadBlob(blob, targetFilename(rec), (pct) => setRow(rec.id, { uploadPct: pct }));
    } catch (err) {
      setRow(rec.id, { uploadPct: undefined, note: `upload failed: ${(err as Error).message}` });
      return false;
    }
    setRow(rec.id, { uploadPct: undefined });
    refreshServerFiles();

    // Verify (medium): server-reported on-disk size == client blob size.
    if (serverFile.size !== blob.size) {
      setRow(rec.id, {
        note: `size mismatch (sent ${blob.size}, server ${serverFile.size}) — left on device`,
      });
      return false;
    }

    if (!autoDelete) {
      setRow(rec.id, { note: `pushed (${formatBytes(serverFile.size)})` });
      return false;
    }

    // Verified — remove from device. Use the silent variant so a bulk push
    // doesn't fire GET_FILE_LIST after every single row; caller refreshes.
    try {
      await deleteFileSilently(rec.fileName);
      setRow(rec.id, { note: 'pushed, deleted from device' });
      return true;
    } catch (err) {
      setRow(rec.id, {
        note: `pushed; device delete failed: ${(err as Error).message}`,
      });
      return false;
    }
  }, [downloadRecording, setRow, refreshServerFiles, autoDelete, deleteFileSilently]);

  // Single-row Push button click: push the file, and if we deleted from
  // device, refresh the device list so the row disappears.
  const handlePushRowClick = useCallback(async (rec: AudioRecording) => {
    const deleted = await handlePushToServer(rec);
    if (deleted) {
      setSelected((s) => {
        if (!s.has(rec.id)) return s;
        const next = new Set(s);
        next.delete(rec.id);
        return next;
      });
      await refreshRecordings();
    }
  }, [handlePushToServer, refreshRecordings]);

  const handleDeleteFromDevice = useCallback(async (rec: AudioRecording) => {
    setRow(rec.id, { deleting: true });
    await deleteRecording(rec.fileName);
    setSelected((s) => {
      const next = new Set(s);
      next.delete(rec.id);
      return next;
    });
    setRow(rec.id, { deleting: false });
    setConfirmDeleteName(null);
  }, [deleteRecording, setRow]);

  const handlePushSelected = useCallback(async () => {
    const targets = recordings.filter((r) => selected.has(r.id));
    if (targets.length === 0) return;
    setBulkBusy(true);
    const deletedIds = new Set<string>();
    for (const rec of targets) {
      // eslint-disable-next-line no-await-in-loop
      const deleted = await handlePushToServer(rec);
      if (deleted) deletedIds.add(rec.id);
    }
    setBulkBusy(false);
    if (deletedIds.size > 0) {
      // Clear deleted rows from selection, then a single refresh covers
      // all device deletions instead of one GET_FILE_LIST per row.
      setSelected((s) => {
        const next = new Set(s);
        for (const id of deletedIds) next.delete(id);
        return next;
      });
      await refreshRecordings();
    }
  }, [recordings, selected, handlePushToServer, refreshRecordings]);

  const handleRunProcess = useCallback(async () => {
    try {
      const r = await fetch('/api/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threshold: thresholdNum }),
      });
      const data = await r.json();
      if (!r.ok) {
        setJob({
          id: 'error', status: 'error', command: '',
          startedAt: null, completedAt: new Date().toISOString(),
          exitCode: null, stdout: '', stderr: data.error ?? 'failed to start', pid: null,
        });
        return;
      }
      setJob(data.job);
    } catch (err) {
      setJob({
        id: 'error', status: 'error', command: '',
        startedAt: null, completedAt: new Date().toISOString(),
        exitCode: null, stdout: '', stderr: (err as Error).message, pid: null,
      });
    }
  }, [thresholdNum]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((s) => {
      if (s.size === recordings.length) return new Set();
      return new Set(recordings.map((r) => r.id));
    });
  }, [recordings]);

  const totalSelectedBytes = useMemo(
    () => recordings.filter((r) => selected.has(r.id)).reduce((a, r) => a + r.size, 0),
    [recordings, selected],
  );

  const storageSummary = device?.storageInfo
    ? `${formatBytes(device.storageInfo.usedSpace)} / ${formatBytes(device.storageInfo.totalSpace)} used  ·  ${device.storageInfo.fileCount} files`
    : null;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>OpenHiNotes Bridge</h1>
          <div className="muted">HiDock P1 · WebUSB · single-container</div>
        </div>
        <div className="device-info">
          {device?.connected ? (
            <>
              <div><strong>{device.name}</strong></div>
              <div>SN {device.serialNumber} · fw {device.firmwareVersion}</div>
              {storageSummary && <div>{storageSummary}</div>}
            </>
          ) : (
            <div className="muted">No device connected</div>
          )}
        </div>
      </header>

      {!WEBUSB_AVAILABLE && (
        <div className="banner error">
          This browser does not support WebUSB. Use Chrome, Edge, or another
          Chromium-based browser over HTTPS (or http://localhost).
        </div>
      )}

      {error && (
        <div className="banner error">
          {error} <button className="ghost" onClick={clearError} style={{ marginLeft: 8 }}>dismiss</button>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          {!device?.connected ? (
            <button onClick={connectDevice} disabled={!WEBUSB_AVAILABLE || isLoading}>
              {isLoading ? 'Connecting…' : 'Connect device'}
            </button>
          ) : (
            <>
              <button onClick={refreshRecordings} disabled={isLoading}>
                {isLoading ? 'Refreshing…' : 'Refresh list'}
              </button>
              <button className="secondary" onClick={syncTime} disabled={isLoading}>
                Sync device clock
              </button>
              <button className="secondary" onClick={disconnectDevice}>Disconnect</button>
              <label
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                title="After upload, verify the server's on-disk size matches the bytes we sent; if so, delete the file from the device. Setting persists across reloads."
              >
                <input
                  type="checkbox"
                  checked={autoDelete}
                  onChange={(e) => toggleAutoDelete(e.target.checked)}
                />
                <span className="label-dim">Delete from device after successful push</span>
              </label>
              <div className="spacer" />
              <span className="label-dim">
                {selected.size} selected · {formatBytes(totalSelectedBytes)}
              </span>
              <button
                onClick={handlePushSelected}
                disabled={selected.size === 0 || bulkBusy}
              >
                {bulkBusy ? 'Pushing…' : autoDelete ? 'Push & remove selected' : 'Push selected to server'}
              </button>
            </>
          )}
        </div>
      </section>

      {device?.connected && (
        <section className="panel">
          {recordings.length === 0 ? (
            <div className="muted">No recordings on device. Click "Refresh list".</div>
          ) : (
            <div className="table-wrap">
              <table className="recordings">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        checked={selected.size === recordings.length && recordings.length > 0}
                        ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < recordings.length; }}
                        onChange={toggleSelectAll}
                      />
                    </th>
                    <th>Filename</th>
                    <th>Date</th>
                    <th className="right">Size</th>
                    <th className="right">Duration</th>
                    <th>Progress</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recordings.map((rec) => {
                    const rs = rowState[rec.id] ?? {};
                    return (
                      <tr key={rec.id}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(rec.id)}
                            onChange={() => toggleSelected(rec.id)}
                          />
                        </td>
                        <td className="filename" title={rec.fileName}>{rec.fileName}</td>
                        <td className="mono">{formatDate(rec.dateCreated)}</td>
                        <td className="right mono">{formatBytes(rec.size)}</td>
                        <td className="right mono">{formatDuration(rec.duration)}</td>
                        <td>
                          {rs.downloadPct !== undefined && (
                            <>
                              <span className="progress"><div style={{ width: `${rs.downloadPct}%` }} /></span>
                              <span className="muted" style={{ marginLeft: 6 }}>dl {rs.downloadPct}%</span>
                            </>
                          )}
                          {rs.uploadPct !== undefined && (
                            <>
                              <span className="progress"><div style={{ width: `${rs.uploadPct}%` }} /></span>
                              <span className="muted" style={{ marginLeft: 6 }}>up {rs.uploadPct}%</span>
                            </>
                          )}
                          {rs.note && rs.downloadPct === undefined && rs.uploadPct === undefined && (
                            <span className="muted">{rs.note}</span>
                          )}
                          {rs.playUrl && (
                            <audio src={rs.playUrl} controls preload="metadata" />
                          )}
                        </td>
                        <td className="actions">
                          <button className="secondary" onClick={() => handlePlay(rec)}>Play</button>
                          <button className="secondary" onClick={() => handleDownloadToBrowser(rec)}>Download</button>
                          <button
                            onClick={() => handlePushRowClick(rec)}
                            title={autoDelete ? 'Download from device → upload → verify → delete from device' : 'Download from device → upload to server'}
                          >
                            {autoDelete ? 'Push & remove' : 'Push'}
                          </button>
                          {confirmDeleteName === rec.fileName ? (
                            <>
                              <button className="danger" onClick={() => handleDeleteFromDevice(rec)} disabled={rs.deleting}>
                                {rs.deleting ? 'Deleting…' : 'Confirm delete'}
                              </button>
                              <button className="ghost" onClick={() => setConfirmDeleteName(null)}>Cancel</button>
                            </>
                          ) : (
                            <button className="ghost" onClick={() => setConfirmDeleteName(rec.fileName)}>Delete</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="panel process-panel">
        <div className="toolbar">
          <strong>Server-side processing</strong>
          <div className="spacer" />
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Threshold
            <input
              type="number"
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
              disabled={job?.status === 'running'}
              style={{ width: 70 }}
              title={`Speaker-match similarity cutoff (${THRESHOLD_MIN}–${THRESHOLD_MAX}). Default ${THRESHOLD_DEFAULT}.`}
            />
          </label>
          {job && (
            <span className={`status-pill ${job.status}`}>
              {job.status}{job.exitCode !== null ? ` · exit ${job.exitCode}` : ''}
            </span>
          )}
          <button
            onClick={handleRunProcess}
            disabled={!serverConfig?.processConfigured || job?.status === 'running' || !thresholdValid}
            title={
              !serverConfig?.processConfigured
                ? 'HIDOCK_PROCESS_CMD is not set on the server'
                : !thresholdValid
                  ? `Threshold must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}`
                  : `Run the configured HIDOCK_PROCESS_CMD (threshold=${thresholdNum})`
            }
          >
            {job?.status === 'running' ? 'Running…' : 'Run process'}
          </button>
        </div>
        {!serverConfig?.processConfigured && (
          <div className="banner info" style={{ marginTop: 10 }}>
            <code>HIDOCK_PROCESS_CMD</code> is not set on the server. Set it to a
            shell command (run from <code>{serverConfig?.storage}</code>) and restart
            the container.
          </div>
        )}
        {job && (job.stdout || job.stderr || job.status !== 'idle') && (
          <div style={{ marginTop: 10 }}>
            <div className="muted" style={{ marginBottom: 4 }}>
              {job.startedAt && <>started {new Date(job.startedAt).toLocaleString()} · </>}
              {job.completedAt && <>finished {new Date(job.completedAt).toLocaleString()} · </>}
              {job.command && <>cmd: <code className="mono">{job.command}</code></>}
            </div>
            {job.stdout && (
              <>
                <div className="muted">stdout</div>
                <pre>{job.stdout}</pre>
              </>
            )}
            {job.stderr && (
              <>
                <div className="muted">stderr</div>
                <pre>{job.stderr}</pre>
              </>
            )}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="toolbar">
          <strong>Files on server</strong>
          <span className="muted">{serverConfig?.storage}</span>
          <div className="spacer" />
          <button className="secondary" onClick={refreshServerFiles}>Refresh</button>
        </div>
        {serverFiles.length === 0 ? (
          <div className="muted" style={{ marginTop: 10 }}>No files yet.</div>
        ) : (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="recordings">
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Modified</th>
                  <th className="right">Size</th>
                </tr>
              </thead>
              <tbody>
                {serverFiles.map((f) => (
                  <tr key={f.name}>
                    <td className="filename mono">{f.name}</td>
                    <td className="mono">{new Date(f.mtime).toLocaleString()}</td>
                    <td className="right mono">{formatBytes(f.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="muted" style={{ fontSize: 12, padding: '8px 0' }}>
        <a href="https://github.com/TeeJS/OpenHiNotes-Bridge" target="_blank" rel="noreferrer">
          OpenHiNotes-Bridge
        </a> · WebUSB requires HTTPS or http://localhost
      </footer>
    </div>
  );
}
