import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceService } from '@/services/deviceService';
import { AudioRecording } from '@/types';
import { formatBytes, sha256Hex, targetFilename, uploadBlob } from '@/lib/shared';

// ---------------------------------------------------------------------------
// /sync — unattended "copy everything off the P1, verify, delete" page.
//
// Driven by the companion browser extension, which opens /sync?auto=1 after
// closing the HiNotes tab, then watches document.title for the verdict:
//   SYNC-RUNNING          in progress
//   SYNC-DONE …           every file copied+verified (or nothing to do)
//   SYNC-FAILED …         at least one file could not be copied+verified
//   SYNC-NEEDS-ATTENTION  can't proceed without a human (no device permission)
//
// Data-integrity contract (PROJECT.md phase 2, criterion 1): a file is
// deleted from the device only after the server's on-disk copy matches the
// exact bytes we hold, by size AND SHA-256. Any error → no delete.
// ---------------------------------------------------------------------------

type FileStatus =
  | { kind: 'pending' }
  | { kind: 'downloading'; pct: number }
  | { kind: 'uploading'; pct: number }
  | { kind: 'verifying' }
  | { kind: 'deleting' }
  | { kind: 'done'; serverName: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'skipped'; reason: string };

interface FileRow {
  rec: AudioRecording;
  status: FileStatus;
}

type Phase =
  | 'start'            // waiting for the user to press the button (manual visit)
  | 'connecting'
  | 'listing'
  | 'syncing'
  | 'done'
  | 'failed'
  | 'needs-attention';

const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_MS = 2000;

function statusLabel(s: FileStatus): string {
  switch (s.kind) {
    case 'pending': return 'waiting';
    case 'downloading': return `copying from device ${s.pct}%`;
    case 'uploading': return `uploading ${s.pct}%`;
    case 'verifying': return 'verifying copy';
    case 'deleting': return 'verified — removing from device';
    case 'done': return `done → ${s.serverName}`;
    case 'failed': return `FAILED: ${s.reason} (left on device)`;
    case 'skipped': return `skipped: ${s.reason} (left on device)`;
  }
}

export default function SyncPage() {
  const [phase, setPhase] = useState<Phase>('start');
  const [message, setMessage] = useState<string>('');
  const [rows, setRows] = useState<FileRow[]>([]);
  const startedRef = useRef(false);

  const setRow = useCallback((id: string, status: FileStatus) => {
    setRows((rs) => rs.map((r) => (r.rec.id === id ? { ...r, status } : r)));
  }, []);

  const runSync = useCallback(async () => {
    if (startedRef.current) return;
    startedRef.current = true;

    document.title = 'SYNC-RUNNING';
    setPhase('connecting');
    setMessage('Looking for the P1…');

    let connected = false;
    try {
      // -- Connect (with retries: the extension has just closed HiNotes and
      //    the USB claim can take a moment to actually release).
      const devices = await navigator.usb.getDevices();
      if (devices.length === 0) {
        document.title = 'SYNC-NEEDS-ATTENTION';
        setPhase('needs-attention');
        setMessage(
          'This browser has no saved permission for the P1 (or it is unplugged). ' +
          'Plug it in and click the button below once — the permission then sticks for future runs.',
        );
        return;
      }

      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= CONNECT_ATTEMPTS && !connected; attempt++) {
        try {
          await deviceService.connectDevice(devices[0]);
          connected = true;
        } catch (err) {
          lastErr = err;
          setMessage(`Device busy — retrying (${attempt}/${CONNECT_ATTEMPTS})…`);
          await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
        }
      }
      if (!connected) {
        document.title = 'SYNC-FAILED (could not connect)';
        setPhase('failed');
        setMessage(`Could not connect to the P1: ${(lastErr as Error)?.message ?? lastErr}`);
        return;
      }

      // -- List device recordings (oldest first, so an interrupted run has
      //    already secured the oldest files).
      setPhase('listing');
      setMessage('Reading the list of recordings…');
      const recordings = (await deviceService.getFileList())
        .sort((a, b) => a.dateCreated.getTime() - b.dateCreated.getTime());

      if (recordings.length === 0) {
        document.title = 'SYNC-DONE (0 copied)';
        setPhase('done');
        setMessage('Nothing on the device — all clean.');
        return;
      }

      setRows(recordings.map((rec) => ({ rec, status: { kind: 'pending' } })));
      setPhase('syncing');
      setMessage(`Copying ${recordings.length} recording(s)…`);

      // Existing server names — used to avoid silently overwriting a
      // different file that happens to share the target name.
      const taken = new Set<string>();
      try {
        const r = await fetch('/api/files');
        const data = await r.json();
        for (const f of data.files ?? []) taken.add(f.name);
      } catch {
        // If the listing fails the upload itself will still verify by hash;
        // collision-avoidance is just degraded, not unsafe.
      }

      let ok = 0;
      let failed = 0;
      let deviceGone = false;

      for (const rec of recordings) {
        if (deviceGone) {
          setRow(rec.id, { kind: 'skipped', reason: 'device connection lost' });
          failed++;
          continue;
        }
        try {
          // 1. Copy off the device.
          setRow(rec.id, { kind: 'downloading', pct: 0 });
          const blob = await deviceService.downloadFile(
            rec.fileName,
            rec.size,
            (pct) => setRow(rec.id, { kind: 'downloading', pct }),
            rec.fileVersion,
          );

          // 2. Pick a server name that can't clobber an existing file.
          let name = targetFilename(rec);
          if (taken.has(name)) {
            const dot = name.lastIndexOf('.');
            const stem = dot > 0 ? name.slice(0, dot) : name;
            const ext = dot > 0 ? name.slice(dot) : '';
            let i = 1;
            while (taken.has(`${stem}_${i}${ext}`)) i++;
            name = `${stem}_${i}${ext}`;
          }

          // 3. Upload.
          setRow(rec.id, { kind: 'uploading', pct: 0 });
          const uploaded = await uploadBlob(blob, name, (pct) => setRow(rec.id, { kind: 'uploading', pct }));
          taken.add(uploaded.name);

          // 4. Verify: server re-reads its on-disk copy; size and SHA-256
          //    must match the exact bytes we hold.
          setRow(rec.id, { kind: 'verifying' });
          const localHash = await sha256Hex(blob);
          const hr = await fetch(`/api/files/${encodeURIComponent(uploaded.name)}/hash`);
          if (!hr.ok) throw new Error(`hash check unavailable (HTTP ${hr.status})`);
          const remote = await hr.json();
          if (remote.size !== blob.size) {
            throw new Error(`size mismatch (sent ${blob.size}, server has ${remote.size})`);
          }
          if (remote.sha256 !== localHash) {
            throw new Error('checksum mismatch — server copy is not identical');
          }

          // 5. Only now: delete from the device.
          setRow(rec.id, { kind: 'deleting' });
          await deviceService.deleteFile(rec.fileName);

          setRow(rec.id, { kind: 'done', serverName: uploaded.name });
          ok++;
        } catch (err) {
          failed++;
          setRow(rec.id, { kind: 'failed', reason: (err as Error)?.message ?? String(err) });
          if (!deviceService.isConnected()) deviceGone = true;
        }
      }

      if (failed === 0) {
        document.title = `SYNC-DONE (${ok} copied)`;
        setPhase('done');
        setMessage(`All ${ok} recording(s) copied, verified, and removed from the P1.`);
      } else {
        document.title = `SYNC-FAILED (${failed} of ${ok + failed})`;
        setPhase('failed');
        setMessage(
          `${ok} recording(s) copied and removed; ${failed} failed and were LEFT ON THE DEVICE. ` +
          'Nothing was deleted without a verified copy.',
        );
      }
    } catch (err) {
      document.title = 'SYNC-FAILED (error)';
      setPhase('failed');
      setMessage(`Sync error: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      if (connected) {
        await deviceService.disconnectDevice().catch(() => {});
      }
    }
  }, [setRow]);

  // One-time permission grant for a browser that has never seen the P1.
  const grantAndRun = useCallback(async () => {
    try {
      await deviceService.requestDevice(); // needs the click (user gesture)
      startedRef.current = false;
      setPhase('start');
      await runSync();
    } catch (err) {
      setMessage((err as Error)?.message ?? String(err));
    }
  }, [runSync]);

  useEffect(() => {
    document.title = 'OpenHiNotes Sync';
    const auto = new URLSearchParams(window.location.search).get('auto') === '1';
    if (auto) void runSync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const badge =
    phase === 'done' ? { text: 'Done', cls: 'success' } :
    phase === 'failed' ? { text: 'Failed', cls: 'error' } :
    phase === 'needs-attention' ? { text: 'Needs attention', cls: 'error' } :
    phase === 'start' ? { text: 'Ready', cls: 'idle' } :
    { text: 'Working…', cls: 'running' };

  return (
    <div className="app" style={{ maxWidth: 900, margin: '0 auto', padding: 16 }}>
      <header className="header">
        <div>
          <h1>P1 Sync</h1>
          <div className="muted">Copy everything → verify → delete from device</div>
        </div>
        <span className={`status-pill ${badge.cls}`} style={{ fontSize: 16 }}>{badge.text}</span>
      </header>

      {message && (
        <section className="panel" style={{ fontSize: 16 }}>
          {message}
        </section>
      )}

      {phase === 'start' && (
        <section className="panel">
          <button style={{ fontSize: 18, padding: '12px 24px' }} onClick={() => void runSync()}>
            Start sync
          </button>
        </section>
      )}

      {phase === 'needs-attention' && (
        <section className="panel">
          <button style={{ fontSize: 18, padding: '12px 24px' }} onClick={() => void grantAndRun()}>
            Connect to P1 (one-time permission)
          </button>
        </section>
      )}

      {rows.length > 0 && (
        <section className="panel">
          <table className="recordings">
            <thead>
              <tr>
                <th>Recording</th>
                <th className="right">Size</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ rec, status }) => (
                <tr key={rec.id}>
                  <td className="filename mono" title={rec.fileName}>{rec.fileName}</td>
                  <td className="right mono">{formatBytes(rec.size)}</td>
                  <td className={status.kind === 'failed' || status.kind === 'skipped' ? 'mono' : undefined}
                      style={status.kind === 'failed' || status.kind === 'skipped' ? { color: 'var(--danger)' } : undefined}>
                    {statusLabel(status)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
