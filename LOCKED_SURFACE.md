# Functional lock (do not break when changing UI)

This extension separates **UI** (`popup.html` / `popup.css` / copy) from **integration + compare logic** (`background.js`, `content.js`). Cosmetic changes must **not** change the contracts below.

## Background service worker (`background.js`)

- **`COMPARE_START`** — full compare pipeline (page QA, scroll capture, diff, merge issues, optional Sheet/CSV, per-issue screenshots). Payload: `{ type, pageTabId, figmaUrl?, compareViewportWidth?, compareWidths?, compareAllTabs?, multiTabMax? }`. Pass **`figmaUrl`** as the current Phase 1 field value so the worker can re-sync the frame if it changed vs `figmaCompare_figmaBootstrapFrameKey`. `compareWidths` (array of px, max 8) runs one pass per width; otherwise `compareViewportWidth` or storage / Figma export width is used. Each run fetches a **fresh** frame export PNG and **fresh** `/files/.../nodes` typography from the Figma API. **`figmaCompare_figmaSnapshotDataUrl` is not used for compare** (optional manual upload only).
- **`COMPARE_STATUS`** — read job blob from `chrome.storage.local` key `figmaCompare_compareJob`.
- **`FIGMA_BOOTSTRAP_DESIGN`** — Figma API: downloads export once to read **width/height**, saves **frame id + typography JSON** to storage; **does not** persist the raster to `figmaCompare_figmaSnapshotDataUrl` (upload fallback may still use that key). Payload: `{ type, figmaUrl, figmaToken? }`. Response includes `detectedExportWidth` when available.
- **`UPLOAD_HIGHLIGHT_LINK`** — publish a highlight `dataUrl` via configured hosts.

Do **not** rename these `type` strings without updating **every** `chrome.runtime.sendMessage` caller and the listener branches.

## Content script (`content.js`)

Message types consumed **outside** the overlay switch:

- `COLLECT_PAGE_QA` — returns `{ ok, data }` with `sections`, samples, `rectDoc`, etc.
- `GET_PAGE_SCROLL_METRICS` — `scrollHeight`, `scrollWidth`, `innerWidth`, `innerHeight`.
- `SCROLL_PAGE_Y` — scroll for stitched capture.

Overlay messages (`GET_STATE`, `SET_STATE`, `TOGGLE_OVERLAY`, `NUDGE`, …) are for the on-page overlay only; do not remove them if commands/overlay remain in manifest.

## Popup (`popup.js`)

Must keep working flows:

- Phase 1 save: token storage + `FIGMA_BOOTSTRAP_DESIGN` when needed + `saveWizard` keys.
- Phase 2: `COMPARE_START` with `pageTabId` (optional `compareViewportWidth` / `compareWidths` from viewport controls).
- Phase 3: table + `Download CSV` + optional `qaDoneModal` (UI only; must not block compare).

## Manifest (`manifest.json`)

- **`permissions` / `host_permissions`**: shrinking these breaks capture, injection, or downloads.
- Adding **`icons`** or `action.default_icon` is safe; it does not change runtime logic.

## Storage keys

Changing `chrome.storage.local` key strings requires a **migration** or users lose cache/tokens. Prefer additive keys only.
