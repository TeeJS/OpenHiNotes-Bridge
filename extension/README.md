# OpenHiNotes P1 Sync — Chrome extension

Runs on the **meeting PC** (the machine the HiDock P1 plugs into). One click —
or a "Sync P1" press on the touch panel — does the whole hand-off:

1. Closes the HiNotes tab(s) and any connected OpenHiNotes tab, which frees
   the P1's USB claim.
2. Opens `https://notes.schmitzplex.com/sync?auto=1`, which copies every
   recording to the server, **verifies each copy by size + SHA-256, and only
   then deletes it from the P1**. Anything that fails verification stays on
   the device and is shown in red.
3. Closes the sync page and **always** reopens HiNotes — success, failure, or
   hang (45-minute watchdog) — so the P1 goes back to being the meeting
   mic/speaker and auto-record resumes.

The toolbar badge shows the result: `OK` (green) or `ERR` (red). On `ERR`,
nothing was deleted from the P1 without a verified server copy; the sync tab
is left open (when safe) so you can read which files were affected.

It also polls `https://notes.schmitzplex.com/api/sync-request` every 30
seconds, so the **Sync P1** button on `panel.html` can trigger the same flow
remotely. Panel requests expire after 10 minutes if this PC isn't around to
pick them up.

## Install (once, on the meeting PC)

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `extension/` folder.
4. Optional: click the puzzle-piece icon in the toolbar and pin
   "OpenHiNotes P1 Sync" so the one-click button is always visible.

First run only: if the browser has never been granted access to the P1, the
sync page will stop and show a **Connect to P1** button — click it once and
pick the device. The permission sticks for all future runs.

## Configuration

The bridge and HiNotes URLs are constants at the top of `background.js`
(`BRIDGE_ORIGIN`, `HINOTES_URL`). Edit and hit the reload arrow on
`chrome://extensions` if they ever change.
