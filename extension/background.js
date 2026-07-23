// OpenHiNotes P1 Sync — MV3 service worker.
//
// One run = close HiNotes tab(s) (frees the USB claim) → open the bridge's
// /sync?auto=1 page (which copies, verifies, deletes) → watch its
// document.title for the verdict → close it → ALWAYS reopen HiNotes.
//
// Reliability model (PROJECT.md phase 2, criterion 2 — HiNotes must come
// back): run state lives in chrome.storage.session, so even if this service
// worker is killed mid-run, the 30-second alarm picks the run back up and
// still restores HiNotes. A watchdog caps a stuck run; every exit path goes
// through finishRun(), whose HiNotes-restore step is unconditional.

const BRIDGE_ORIGIN = 'https://notes.schmitzplex.com';
const SYNC_URL = `${BRIDGE_ORIGIN}/sync?auto=1`;
const HINOTES_URL = 'https://hinotes.hidock.com/';

// Tabs that may hold the P1's USB claim and must be closed before syncing.
// The OpenHiNotes SPA auto-reconnects on load, so it can hold the claim too;
// it is closed but NOT restored afterwards (restoring it would re-grab the
// device and kill the P1's audio again). Only HiNotes gets restored.
const CLAIM_HOLDER_PATTERNS = [
  '*://hinotes.hidock.com/*',
  `${BRIDGE_ORIGIN}/`,
  `${BRIDGE_ORIGIN}/index.html`,
];

const POLL_ALARM = 'openhinotes-poll';
const POLL_MINUTES = 0.5;          // server flag poll + in-run heartbeat
const TICK_MS = 2000;              // in-memory monitor cadence
const CLAIM_RELEASE_WAIT_MS = 1500;
const WATCHDOG_MS = 45 * 60 * 1000;      // hard cap on a run
const ATTENTION_GRACE_MS = 2 * 60 * 1000; // how long NEEDS-ATTENTION may wait

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getRun() {
  const { run } = await chrome.storage.session.get('run');
  return run ?? null;
}
async function setRun(run) {
  if (run === null) await chrome.storage.session.remove('run');
  else await chrome.storage.session.set({ run });
}

function setBadge(text, color) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function ensureAlarm() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.action.onClicked.addListener(async () => {
  if (await getRun()) return; // already running
  await startRun('button');
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  const run = await getRun();
  if (run) {
    // Heartbeat: keeps a run moving even if the worker was restarted and
    // the in-memory monitor loop is gone.
    await checkRun();
    return;
  }
  // Idle: poll the bridge for a panel-initiated sync request.
  try {
    const r = await fetch(`${BRIDGE_ORIGIN}/api/sync-request`);
    if (!r.ok) return;
    const data = await r.json();
    if (!data.pending) return;
    await fetch(`${BRIDGE_ORIGIN}/api/sync-request`, { method: 'DELETE' }); // claim it
    await startRun('panel');
  } catch {
    // bridge unreachable — try again next alarm
  }
});

async function startRun(trigger) {
  setBadge('RUN', '#f0c674');
  let syncTabId = null;
  try {
    // 1. Close anything that might hold the USB claim.
    const holders = await chrome.tabs.query({ url: CLAIM_HOLDER_PATTERNS });
    await Promise.all(holders.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
    await sleep(CLAIM_RELEASE_WAIT_MS);

    // 2. Open the sync page (foreground, so Chrome doesn't throttle it).
    const tab = await chrome.tabs.create({ url: SYNC_URL, active: true });
    syncTabId = tab.id;
    await setRun({ syncTabId, startedAt: Date.now(), attentionSince: null, trigger });
  } catch (err) {
    console.error('startRun failed', err);
    await setRun({ syncTabId, startedAt: Date.now(), attentionSince: null, trigger });
    await finishRun('error');
    return;
  }

  // 3. Monitor. checkRun() is also invoked by the alarm, so a worker restart
  //    only slows the cadence to 30 s — it never orphans the run.
  while (await getRun()) {
    await sleep(TICK_MS);
    await checkRun();
  }
}

// Inspect the sync tab and finish the run when it reaches a verdict.
async function checkRun() {
  const run = await getRun();
  if (!run) return;

  if (Date.now() - run.startedAt > WATCHDOG_MS) {
    await finishRun('timeout');
    return;
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(run.syncTabId);
  } catch {
    await finishRun('tab-closed'); // someone closed it — restore HiNotes anyway
    return;
  }

  const title = tab.title ?? '';
  if (title.startsWith('SYNC-DONE')) {
    await finishRun('ok');
  } else if (title.startsWith('SYNC-FAILED')) {
    await finishRun('failed');
  } else if (title.startsWith('SYNC-NEEDS-ATTENTION')) {
    if (!run.attentionSince) {
      await setRun({ ...run, attentionSince: Date.now() });
    } else if (Date.now() - run.attentionSince > ATTENTION_GRACE_MS) {
      await finishRun('needs-attention');
    }
  } else if (run.attentionSince) {
    await setRun({ ...run, attentionSince: null }); // user clicked through
  }
}

async function finishRun(result) {
  const run = await getRun();
  await setRun(null); // stop the monitor loop first — finish exactly once

  // Close the sync tab whenever it might still hold the USB claim (a hung/
  // timed-out page would otherwise block HiNotes from reconnecting). On
  // 'failed'/'needs-attention' the sync page has already released the device
  // itself, so the tab stays open — its red rows say what was left on the P1.
  if (run?.syncTabId != null && result !== 'failed' && result !== 'needs-attention') {
    try { await chrome.tabs.remove(run.syncTabId); } catch { /* already gone */ }
  }

  // UNCONDITIONAL: bring HiNotes back so the P1 resumes meeting duty.
  try {
    await chrome.tabs.create({ url: HINOTES_URL, active: result === 'ok' ? false : true });
  } catch (err) {
    console.error('failed to reopen HiNotes', err);
    try { await chrome.tabs.create({ url: HINOTES_URL }); } catch { /* give up */ }
  }

  if (result === 'ok') setBadge('OK', '#5fd38d');
  else setBadge('ERR', '#ff6a6a');
}
