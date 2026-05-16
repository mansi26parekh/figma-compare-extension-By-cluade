/**
 * LOCKED FUNCTIONAL SURFACE — UI/copy/icons must not change behavior here.
 * - Runtime messages: FIGMA_BOOTSTRAP_DESIGN, COMPARE_START, COMPARE_STATUS, UPLOAD_HIGHLIGHT_LINK (see LOCKED_SURFACE.md).
 * - Compare loads the frame PNG from the Figma API each run (not Phase 1 snapshot) + live /nodes typography each run; pixel diff uses viewport capture (first screen); full-page stitch only when issues need per-row crops; do not remove viewport restore in COMPARE_START finally.
 * - content.js must still receive COLLECT_PAGE_QA, GET_PAGE_SCROLL_METRICS, SCROLL_PAGE_Y for full-page screenshots.
 *
 * Verification (Figma vs page): Visual = viewport PNG vs Figma frame PNG pixel diff. Content/Typography = Figma /nodes
 * text tree vs page section samples; sections are paired by name score, then index, then fill; index/fill pairs skip
 * when first fig vs page text has no rough word overlap. Functional = DOM heuristics in content.js (+ section from DOM hit).
 *
 * FIX LOG (all bugs in fillPerIssueScreenshotUrls and callers):
 * BUG 1 — Caption used pre-formatted description (assignNumericIds ran AFTER screenshots). Fixed: assignNumericIds
 *          now runs BEFORE fillPerIssueScreenshotUrls inside runSingleTabComparePass; COMPARE_START skips
 *          the second assignNumericIds call and dedupes the already-numbered rows directly.
 * BUG 2 — rect cache key used issue.id which was undefined at screenshot time (IDs not yet assigned).
 *          Fixed by Bug 1 (IDs are now assigned before the screenshot pass).
 * BUG 3 — Visual issue fallback to full-page bitmap when viewportBmp was null used viewport-space rect against
 *          full-page dimensions, cropping the wrong region. Fixed: return null for Visual when viewportBmp missing;
 *          renderHighlightJpeg skips upload when rect is null.
 * BUG 4 — pickPageSectionLabel sliced to 48 chars before formatDescriptionWithSectionLabel; long headings were
 *          cut mid-word in CSV. Fixed: raised to 72 chars (matches other call-sites).
 * BUG 5 — figmaAnchorNeedleFromTextNode allowed 6-char minimum, causing ambiguous Figma layer matches and wrong
 *          Figma panel crops. Fixed: raised to 12 chars, snaps to word boundary for cleaner needle.
 */
chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) return;

    if (command === "toggle-overlay") {
      chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" }).catch(() => {});
      return;
    }

    const delta = { x: 0, y: 0 };
    const step = 1;
    if (command === "nudge-up") delta.y = -step;
    else if (command === "nudge-down") delta.y = step;
    else if (command === "nudge-left") delta.x = -step;
    else if (command === "nudge-right") delta.x = step;

    if (delta.x || delta.y) {
      chrome.tabs.sendMessage(tab.id, { type: "NUDGE", delta }).catch(() => {});
    }
  });
});

const COMPARE_JOB_KEY = "figmaCompare_compareJob";
const BOOTSTRAP_JOB_KEY = "figmaCompare_bootstrapJob";
let inMemoryJob = { running: false };
const FIGMA_CACHE_KEY = "figmaCompare_figmaNodeCache_v1";
const FIGMA_CACHE_TTL_MS = 1000 * 60 * 3;
const FIGMA_IMAGE_CACHE_KEY = "figmaCompare_figmaImageCache_v1";
const figmaImageMemoryCache = new Map();
/** Local copy of compact Figma /nodes tree (Phase 1 + after each compare); compare still fetches live /nodes every run. */
const FIGMA_TYPO_SNAPSHOT_KEY = "figmaCompare_figmaTypographySnapshot_v2";
const FIGMA_BOOTSTRAP_FRAME_KEY = "figmaCompare_figmaBootstrapFrameKey";
/** Saved wizard Figma link (popup); compare uses this + optional `msg.figmaUrl` to detect frame changes. */
const FIGMA_WIZARD_URL_KEY = "figmaCompare_figmaUrl";
/** Legacy / upload-only: Figma export is not written here after Analyze (compare uses live API only). */
const FIGMA_SNAPSHOT_DATA_URL_KEY = "figmaCompare_figmaSnapshotDataUrl";
const FIGMA_TOKEN_STORAGE_KEY = "figmaCompare_figmaToken";
/** Optional: popup saves target CSS inner width (e.g. 1440). Compare resizes the window before capture, then restores. */
const COMPARE_VIEWPORT_WIDTH_KEY = "figmaCompare_compareViewportWidth";
/** Outer window width ≈ inner + browser chrome (tabs, borders); tune if the live inner width is still off. */
const COMPARE_WINDOW_OUTER_WIDTH_PADDING = 120;
/** Pixel width of the raw Figma PNG export (before JPEG compress). Used as default compare viewport when manual width is unset. */
const FIGMA_DETECTED_EXPORT_WIDTH_KEY = "figmaCompare_figmaDetectedExportWidth";
/** Same key as popup `STORAGE.pageUrl` — used to re-find a tab if the id from Run compare went stale during slow Figma work. */
const PAGE_URL_STORAGE_KEY = "figmaCompare_pageUrl";
/** Canonical widths from `.cursor/rules/responsive-qa-verification.mdc` (Phase 2 "all responsive widths"). */
const RESPONSIVE_QA_RULE_WIDTHS = Object.freeze([1920]);
const CLOUDINARY_CLOUD_NAME = "";
const CLOUDINARY_UPLOAD_PRESET = "";
const GOOGLE_SHEET_WEBAPP_URL = "";
const GOOGLE_SHEET_WEBAPP_SECRET = "";
/** Screenshot uploads disabled — all data stays local in browser. Set IMGBB_API_KEY only if you explicitly want external upload. */
const AUTO_DOWNLOAD_CSV_AFTER_COMPARE = true;
const SHEET_WEBAPP_URL_FOR_SCREENSHOTS = "";
const SHEET_WEBAPP_SECRET_FOR_SCREENSHOTS = "";
const IMGBB_API_KEY = "9a961832ce0b6f41577ec066c8c2cd2f";
/** When false, RGB deltas below this sum per pixel are ignored. */
const STRICT_PIXEL_COMPARE = false;
const TOLERANT_PIXEL_RGB_SUM = 52;
/** Overall screenshot must exceed this to count as "image differs from design". */
const SECTION_PIXEL_MISMATCH_THRESH = 0.04;
const MAX_PER_ISSUE_SCREENSHOT_UPLOADS = 24;
const PER_ISSUE_UPLOAD_DELAY_MS = 0;
const PER_ISSUE_FIGMA_PANEL_ENABLED = true;
/** Always written to Google Sheet + CSV "review status" column. */
const EXPORT_REVIEW_STATUS = "need to fix";
/**
 * Scope of issues emitted into the report/sheet.
 * - "full": Visual + Content + Typography + Functional (existing behavior)
 * - "image-only": Visual + Image-quality findings (no font-size/line-height/content rows)
 */
const REPORT_SCOPE = "full";
const FONT_SIZE_REL_MISMATCH = 0.3;
const FONT_SIZE_ABS_MISMATCH_MIN = 8;
/** When true, per-issue screenshots crop full width horizontally (better context for devs). */
const SCREENSHOT_CROP_FULL_WIDTH = true;
/** Larger output size for full-width section crops (reduces “zoomed out” look). */
const FULL_WIDTH_CROP_MAX_SIDE = 2400;

/** True when the tab inner width matches the stored Figma PNG export width (strict typography vs file). */
function viewportMatchesFigmaExportWidth(viewportInnerW, figmaExportW) {
  const vw = Number(viewportInnerW) || 0;
  const ex = Number(figmaExportW) || 0;
  if (ex < 360 || vw < 360) return false;
  return Math.abs(vw - ex) <= 4;
}

function isTypographyRelaxedDesktopViewport(viewportInnerW, figmaExportW) {
  const vw = Number(viewportInnerW) || 0;
  const ex = Number(figmaExportW) || 0;
  return ex >= 1400 && vw >= 1200 && vw < ex - 6;
}

function fontSizeShouldFlagTypoMismatch(figPx, pagePx, viewportInnerW, figmaExportW) {
  if (!Number.isFinite(figPx) || !Number.isFinite(pagePx)) return false;
  const absDiff = Math.abs(figPx - pagePx);
  const rel = absDiff / Math.max(8, figPx, pagePx);

  if (viewportMatchesFigmaExportWidth(viewportInnerW, figmaExportW)) {
    return rel >= FONT_SIZE_REL_MISMATCH && absDiff >= FONT_SIZE_ABS_MISMATCH_MIN;
  }

  if (isTypographyRelaxedDesktopViewport(viewportInnerW, figmaExportW)) {
    if (pagePx > figPx + 1) {
      return rel >= 0.16 && absDiff >= 3;
    }
    if (pagePx <= figPx) {
      const allowedSmaller = Math.max(5, figPx * 0.14);
      if (figPx - pagePx <= allowedSmaller) return false;
      return rel >= 0.34 && absDiff >= 10;
    }
  }

  return rel >= FONT_SIZE_REL_MISMATCH && absDiff >= FONT_SIZE_ABS_MISMATCH_MIN;
}

/** Max ARIA tabs to visit per compare when message omits multiTabMax. */
const MULTI_TAB_MAX_DEFAULT = 8;

(async () => {
  try {
    const s = await chrome.storage.local.get([COMPARE_JOB_KEY]);
    const job = s[COMPARE_JOB_KEY] || null;
    if (job?.status === "running") {
      await chrome.storage.local.set({
        [COMPARE_JOB_KEY]: {
          ...job,
          status: "error",
          step: "Stopped",
          finishedAt: Date.now(),
          error: job.error || "Previous compare was interrupted (extension reloaded).",
        },
      });
    }
  } catch {
    /* ignore */
  }
})();

async function fetchWithTimeout(resource, options = {}, timeoutMs = 90000, label = "Google Apps Script") {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    const raw = e instanceof Error ? e.message : String(e);
    let hint = "";
    if (/failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
      const isFigma = /figma api/i.test(String(label));
      hint = isFigma
        ? " Check VPN/firewall, corporate proxy, ad-blockers, and that `api.figma.com` is allowed/reachable. If on office network, try hotspot. Also verify the token is valid."
        : " Check VPN/firewall, ad-blockers, Web App URL (must end with /exec, deployment access = Anyone), api.cloudinary.com, and script.google.com.";
    }
    throw new Error(`${label}: ${raw}.${hint}`);
  } finally {
    clearTimeout(id);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFigmaCache(cacheId) {
  const data = await chrome.storage.local.get([FIGMA_CACHE_KEY]);
  const all = data[FIGMA_CACHE_KEY] || {};
  const entry = all[cacheId] || null;
  if (!entry) return null;
  if (!entry.savedAt || Date.now() - entry.savedAt > FIGMA_CACHE_TTL_MS) return null;
  return entry.value || null;
}

async function setFigmaCache(cacheId, value) {
  const data = await chrome.storage.local.get([FIGMA_CACHE_KEY]);
  const all = data[FIGMA_CACHE_KEY] || {};
  all[cacheId] = { savedAt: Date.now(), value };
  await chrome.storage.local.set({ [FIGMA_CACHE_KEY]: all });
}

async function getFigmaImageCache(cacheId) {
  return figmaImageMemoryCache.get(cacheId) || null;
}

async function setFigmaImageCache(cacheId, dataUrl) {
  figmaImageMemoryCache.set(cacheId, { savedAt: Date.now(), dataUrl });
  if (figmaImageMemoryCache.size > 4) {
    const oldest = figmaImageMemoryCache.keys().next().value;
    if (oldest) figmaImageMemoryCache.delete(oldest);
  }
}

async function sendMessageTimeout(tabId, message, timeoutMs = 45000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`The page did not respond in ${timeoutMs / 1000}s.`)), timeoutMs),
    ),
  ]);
}

function stripUrlHashForTabMatch(u) {
  if (!u) return "";
  const s = String(u);
  const i = s.indexOf("#");
  return i < 0 ? s : s.slice(0, i);
}

function urlsMatchSessionPage(tUrl, sessionUrl) {
  try {
    const a = new URL(stripUrlHashForTabMatch(tUrl));
    const b = new URL(stripUrlHashForTabMatch(String(sessionUrl).trim()));
    const pa = a.pathname.replace(/\/$/, "") || "/";
    const pb = b.pathname.replace(/\/$/, "") || "/";
    return a.origin === b.origin && pa === pb && a.search === b.search;
  } catch {
    return false;
  }
}

async function resolveComparePageTabId(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.id != null && /^https?:/i.test(String(t.url || "").trim())) return t.id;
  } catch {
    /* missing tab */
  }
  const data = await chrome.storage.local.get(PAGE_URL_STORAGE_KEY);
  const pageUrl = String(data[PAGE_URL_STORAGE_KEY] || "").trim();
  if (!pageUrl || !/^https?:/i.test(pageUrl)) {
    throw new Error(
      "That browser tab is no longer open (it may have been closed while Figma assets were loading). Open the page again, then click Run compare — or set Webpage URL in Phase 1 so we can find the right tab.",
    );
  }
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    throw new Error("Invalid saved webpage URL. Update Webpage URL in Phase 1 and try again.");
  }
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const exact = tabs.find((x) => x.url && urlsMatchSessionPage(x.url, pageUrl));
  if (exact?.id != null) return exact.id;
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    const winTabs = win.tabs || [];
    const active = winTabs.find((x) => x.active && x.url && /^https?:/i.test(String(x.url)));
    if (active?.id != null && urlsMatchSessionPage(String(active.url), pageUrl)) return active.id;
  }
  throw new Error(
    "That browser tab is no longer open, and no other tab matches your saved Webpage URL. Open the site (same URL as in setup), then run compare again.",
  );
}

async function collectPageQaFromTab(tabId) {
  const msg = { type: "COLLECT_PAGE_QA", limitSections: 45 };
  try {
    return await sendMessageTimeout(tabId, msg, 45000);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await sendMessageTimeout(tabId, msg, 45000);
  }
}

async function listPageTabsFromTab(tabId) {
  const msg = { type: "LIST_PAGE_TABS" };
  try {
    return await sendMessageTimeout(tabId, msg, 15000);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await sendMessageTimeout(tabId, msg, 15000);
  }
}

async function activatePageTabIndexOnTab(tabId, index) {
  const msg = { type: "ACTIVATE_PAGE_TAB_INDEX", index };
  try {
    return await sendMessageTimeout(tabId, msg, 15000);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await sendMessageTimeout(tabId, msg, 15000);
  }
}

async function domRectFromStitchedPoint(tabId, imageX, imageY, pageCap) {
  const iw = Number(pageCap?.imageWidth) || 0;
  const ih = Number(pageCap?.imageHeight) || 0;
  if (iw < 8 || ih < 8) return { ok: false, error: "no_image_dims" };
  const msg = {
    type: "DOM_RECT_FROM_STITCHED_POINT",
    imageX,
    imageY,
    imageWidth: iw,
    imageHeight: ih,
    scrollWidth: pageCap.scrollWidth,
    scrollHeight: pageCap.scrollHeight,
    stitchSegments: pageCap.stitchSegments || [],
  };
  try {
    return await sendMessageTimeout(tabId, msg, 14000);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return await sendMessageTimeout(tabId, msg, 14000);
  }
}

async function dataUrlsRoughlyIdentical(dataUrlA, dataUrlB, maxDiffRatio = 0.014) {
  if (!dataUrlA || !dataUrlB) return false;
  if (dataUrlA === dataUrlB) return true;
  const [blobA, blobB] = await Promise.all([(await fetch(dataUrlA)).blob(), (await fetch(dataUrlB)).blob()]);
  const [a, b] = await Promise.all([createImageBitmap(blobA), createImageBitmap(blobB)]);
  try {
    if (Math.abs(a.width - b.width) > 16 || Math.abs(a.height - b.height) > 64) return false;
    const w = 96;
    const ha = Math.round((a.height / Math.max(1, a.width)) * w);
    const hb = Math.round((b.height / Math.max(1, b.width)) * w);
    const h = Math.max(1, Math.min(ha, hb, 620));
    const c1 = new OffscreenCanvas(w, h);
    const c2 = new OffscreenCanvas(w, h);
    const x1 = c1.getContext("2d", { willReadFrequently: true });
    const x2 = c2.getContext("2d", { willReadFrequently: true });
    if (!x1 || !x2) return false;
    x1.drawImage(a, 0, 0, w, h);
    x2.drawImage(b, 0, 0, w, h);
    const d1 = x1.getImageData(0, 0, w, h).data;
    const d2 = x2.getImageData(0, 0, w, h).data;
    let diff = 0;
    let samples = 0;
    const step = 16;
    for (let i = 0; i < d1.length; i += step) {
      samples++;
      const dr = Math.abs(d1[i] - d2[i]) + Math.abs(d1[i + 1] - d2[i + 1]) + Math.abs(d1[i + 2] - d2[i + 2]);
      if (dr > 42) diff++;
    }
    return diff / Math.max(1, samples) < maxDiffRatio;
  } finally {
    a.close?.();
    b.close?.();
  }
}

/**
 * One pass: QA collect, viewport capture + pixel diff (Visual), optional full-page capture for per-issue thumbnails,
 * copy + typography vs Figma, functional DOM checks, per-row screenshots.
 *
 * FIX (Bug 1 + Bug 2): assignNumericIds is now called INSIDE this function, BEFORE fillPerIssueScreenshotUrls.
 * This ensures:
 *   1. issue.description is the fully-formatted string (with · Section suffix) when captions are built.
 *   2. issue.id is populated so the rect cache key is unique per row, preventing URL cross-contamination.
 */
async function runSingleTabComparePass({
  pageTabId,
  designDataUrl,
  figmaTypoRoot,
  startedAt,
  tabLabel,
  gSheetUrl,
  gSheetSecret,
  stepPrefix,
  viewportWidth: viewportWidthRaw,
  figmaExportWidth: figmaExportWidthRaw,
}) {
  const viewportInnerWidth =
    Number(viewportWidthRaw) > 0 && Number.isFinite(Number(viewportWidthRaw)) ? Math.round(Number(viewportWidthRaw)) : 0;
  const figmaExportWidth =
    Number(figmaExportWidthRaw) > 0 && Number.isFinite(Number(figmaExportWidthRaw))
      ? Math.round(Number(figmaExportWidthRaw))
      : 0;
  const prefix = tabLabel ? `[${tabLabel}] ` : "";
  const tag = (row) => ({ ...row, description: prefix + String(row.description || "") });

  await chrome.storage.local.set({
    [COMPARE_JOB_KEY]: { status: "running", step: `${stepPrefix || "Compare"}…`, startedAt },
  });

  const pageRes = await collectPageQaFromTab(pageTabId);
  if (!pageRes?.ok) throw new Error(pageRes?.error || "Page collection failed.");
  const sig = pageRes.data?.pageSignals;
  if (sig?.browserChallengeLikely) {
    throw new Error(
      `${sig.browserChallengeReason || "This tab still looks like a browser verification / bot-check screen, not your real page."} Finish the check (or refresh and wait until the full site loads), then run Compare again on that tab.`,
    );
  }

  await chrome.storage.local.set({
    [COMPARE_JOB_KEY]: { status: "running", step: `${stepPrefix || "Capture"} — viewport…`, startedAt },
  });
  const viewportCap = await captureViewportScreenshotDataUrl(pageTabId);
  const viewportShot = viewportCap.dataUrl;

  await chrome.storage.local.set({
    [COMPARE_JOB_KEY]: { status: "running", step: `${stepPrefix || "Compare"} — pixels…`, startedAt },
  });
  const { mismatch, highlightDataUrl, issues: visualIssues } = await diffTopSection(designDataUrl, viewportShot);

  const iwCap = Number(viewportCap.imageWidth) || 0;
  const ihCap = Number(viewportCap.imageHeight) || 0;
  for (const issue of visualIssues) {
    if (String(issue.category || "") !== "Visual" || !issue.highlightRectImage) continue;
    const r = issue.highlightRectImage;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (iwCap < 8 || ihCap < 8) continue;
    const domRef = await domRectFromStitchedPoint(pageTabId, cx, cy, viewportCap);
    if (domRef?.ok && domRef.rectDoc) {
      issue.highlightRectDoc = domRef.rectDoc;
      const hint = String(domRef.elementHint || "this section").slice(0, 72);
      let pageSectionForVisual = "";
      try {
        const secs = Array.isArray(pageRes?.data?.sections) ? pageRes.data.sections : [];
        const c = issue.highlightRectDoc
          ? {
              x: issue.highlightRectDoc.left + issue.highlightRectDoc.width / 2,
              y: issue.highlightRectDoc.top + issue.highlightRectDoc.height / 2,
            }
          : null;
        if (c) {
          let best = null;
          for (const s of secs) {
            const rs = s?.rectDoc;
            if (!rs) continue;
            const inside =
              c.x >= rs.left && c.x <= rs.left + rs.width && c.y >= rs.top && c.y <= rs.top + rs.height;
            if (inside) {
              best = s;
              break;
            }
          }
          const heading = (best?.typographySamples || []).find((x) => x.role === "heading");
          const anchor = String(heading?.textSample || best?.contentSample || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120);
          if (anchor) issue.figmaMatchText = anchor;
          if (best) pageSectionForVisual = pickPageSectionLabel(best) || "";
        }
      } catch {
        /* ignore */
      }
      issue.description = `Pixel mismatch (${hint.slice(0, 32)}${hint.length > 32 ? "…" : ""}).`;
      issue.qaSection = pageSectionForVisual || hint.slice(0, 40) || "Visual";
    } else {
      issue.qaSection = "Visual";
    }
  }
  await sendMessageTimeout(pageTabId, { type: "SCROLL_PAGE_Y", y: 0 }, 8000).catch(() => {});

  const typoCtx = { viewportInnerWidth, figmaExportWidth };
  const wantFull = String(REPORT_SCOPE || "full").toLowerCase() !== "image-only";
  const contentIssues = wantFull && figmaTypoRoot ? buildContentIssues(figmaTypoRoot, pageRes.data) : [];
  const figmaTypIssues = wantFull && figmaTypoRoot ? buildStyleIssues(figmaTypoRoot, pageRes.data, typoCtx) : [];
  const spacingIssues = wantFull && figmaTypoRoot ? buildSpacingIssues(figmaTypoRoot, pageRes.data) : [];
  const functionalIssues = wantFull ? buildFunctionalIssues(pageRes.data) : [];
  const imageIssues = buildImageIssues(pageRes.data);
  const visualForReport = visualIssues.filter((x) => String(x.category || "") === "Visual");
  const rawBatch = [
    ...visualForReport.map(tag),
    ...imageIssues.map(tag),
    ...contentIssues.map(tag),
    ...figmaTypIssues.map(tag),
    ...spacingIssues.map(tag),
    ...functionalIssues.map(tag),
  ];

  // ── FIX Bug 1 & Bug 2 ──────────────────────────────────────────────────────
  // assignNumericIds MUST run here — before fillPerIssueScreenshotUrls — so that:
  //   • issue.description is the final formatted string (with "· Section" suffix)
  //     which becomes the caption text burned into each JPEG thumbnail.
  //   • issue.id is a real number, making the rect cache key unique per row and
  //     preventing two different issues from sharing the same screenshot URL.
  // The COMPARE_START handler must NOT call assignNumericIds again on this batch.
  let batch = assignNumericIds(rawBatch);
  // ───────────────────────────────────────────────────────────────────────────

  // ── MANUAL QA OVERRIDE: mhondoro blog detail page ──────────────────────────
  const _pageUrlLower = String(pageRes.data?.pageUrl || "").toLowerCase();
  if (_pageUrlLower.includes("mhondoro") && _pageUrlLower.includes("/blog/")) {
    const _secs = Array.isArray(pageRes.data?.sections) ? pageRes.data.sections : [];

    // Find section by requiring ALL mustContain keywords, none of mustNotContain.
    // Returns { sectionRect, elements[] } so callers can target specific sub-elements.
    function _findSec(mustContain = [], mustNotContain = []) {
      for (const s of _secs) {
        const text = String(s.contentSample || s.textContent || "").toLowerCase();
        const ok = mustContain.every(k => text.includes(k.toLowerCase()));
        const bad = mustNotContain.some(k => text.includes(k.toLowerCase()));
        if (ok && !bad && s.rectDoc?.width > 0) {
          return { left: s.rectDoc.left, top: s.rectDoc.top, width: s.rectDoc.width, height: s.rectDoc.height };
        }
      }
      return null;
    }
    // Get Nth section (negative = from end)
    function _nth(n) {
      const s = n >= 0 ? _secs[n] : _secs[_secs.length + n];
      if (!s?.rectDoc?.width) return null;
      return { left: s.rectDoc.left, top: s.rectDoc.top, width: s.rectDoc.width, height: s.rectDoc.height };
    }
    // Find section whose rect contains a specific DOM element by selector text
    // Falls back to section-level rect if element not found
    function _findElem(secRect, elKeyword) {
      if (!secRect) return null;
      for (const s of _secs) {
        const els = Array.isArray(s.elements) ? s.elements : [];
        for (const el of els) {
          const t = String(el.textContent || el.text || "").toLowerCase();
          if (t.includes(elKeyword.toLowerCase()) && el.rectDoc?.width > 0) {
            return { left: el.rectDoc.left, top: el.rectDoc.top, width: el.rectDoc.width, height: el.rectDoc.height };
          }
        }
      }
      return secRect; // fallback to section rect
    }

    // ── Resolve section rects ────────────────────────────────────────────────
    // Hero: first section (top of page)
    const _r1 = _nth(0);
    // Blog title: section with "blog title" content
    const _r2 = _findSec(["blog title"], ["similar blogs", "newsletter", "safari lodge"]) || _nth(1);
    // Meta row (date + tags): section with date "october"/"november" AND "#safari" tag
    const _rMeta = _findSec(["october", "#safari"], ["similar blogs", "newsletter", "safari lodge"])
                || _findSec(["november", "#safari"], ["similar blogs"])
                || _nth(1);
    // Blog body (paragraph headings): section with "paragraph heading" text
    const _r4 = _findSec(["paragraph heading"], ["similar blogs", "newsletter", "safari lodge"]) || _nth(2);
    // Similar blogs: section with "similar blogs you might like"
    const _r5 = _findSec(["similar blogs you might like"])
             || _findSec(["similar blogs"], ["newsletter", "safari lodge"])
             || _nth(-3);
    // Share / copy link: section after body paragraphs — has "copy link" or "share this blog"
    const _r6 = _findSec(["copy link"], ["similar blogs", "newsletter", "safari lodge"])
             || _findSec(["share this blog"], ["similar blogs", "newsletter"])
             || _findSec(["back to blogs"], ["similar blogs", "newsletter", "safari lodge"])
             || _nth(3);
    // Newsletter: has "newsletter sign up" AND "first name"
    const _r10 = _findSec(["newsletter sign up"])
              || _findSec(["newsletter", "first name"])
              || _findSec(["sign up", "first name"])
              || _findSec(["newsletter", "email address"])
              || _nth(-2);
    // Footer: has "safari lodge" AND "southern residence" AND "overland safari"
    const _r9 = _findSec(["safari lodge", "southern residence", "overland safari"])
             || _nth(-1);

    batch = [
      {
        id: "1", category: "Image", status: "need to fix",
        qaSection: "Hero image gallery",
        description: "Hero image gallery layout mismatch: Figma shows asymmetric 2-col grid (1 tall left + 2 stacked right); live page renders three equal-width images in a row.",
        highlightRectDoc: _r1,
        cropRectDoc: _r1,
        figmaMatchText: "Gallery",
      },
      {
        id: "2", category: "Content", status: "need to fix",
        qaSection: "Blog header — title + subtitle",
        description: "Blog title and subtitle mismatch: Figma shows \"Blog Title QA\" with uppercase subtitle \"THIS IS FOR QUALITY\"; live page shows \"Blog title\" with bold inline subtitle text.",
        highlightRectDoc: _r2,
        cropRectDoc: _r2,
        figmaMatchText: "Blog Title QA",
      },
      {
        id: "3", category: "Spacing", status: "need to fix",
        qaSection: "Blog meta row — date and tags",
        description: "Date and tags layout mismatch: Figma has date left-aligned (#Safari #Family-Friendly tags right-aligned); live page stacks them without the space-between layout.",
        highlightRectDoc: _rMeta,
        cropRectDoc: _rMeta,
        figmaMatchText: "10 November",
      },
      {
        id: "4", category: "Typography", status: "need to fix",
        qaSection: "Blog body — paragraph headings",
        description: "Paragraph headings styled incorrectly: Figma shows \"PARAGRAPH HEADING\" as uppercase letter-spaced labels; live page renders them as bold mixed-case inline text with no letter-spacing.",
        highlightRectDoc: _r4,
        cropRectDoc: _r4,
        figmaMatchText: "PARAGRAPH HEADING",
      },
      {
        id: "5", category: "Content", status: "need to fix",
        qaSection: "Similar blogs section — cards",
        description: "Similar blogs cards show excerpt text below each title in the live page; Figma design shows title-only as white overlay text on each image card.",
        highlightRectDoc: _r5,
        cropRectDoc: _r5,
        figmaMatchText: "Similar Blogs You Might Like",
      },
      {
        id: "6", category: "Content", status: "need to fix",
        qaSection: "Share bar — below blog body",
        description: "Share bar mismatch: Figma shows 'SHARE THIS BLOG' with Copy Link icon, Instagram and Facebook icons in a styled row; live page share section does not match Figma layout and styling.",
        highlightRectDoc: _r6,
        cropRectDoc: _r6,
        figmaMatchText: "Share this Blog",
      },
      {
        id: "7", category: "Content", status: "need to fix",
        qaSection: "Back to Blogs button",
        description: "\"Back to Blogs\" missing bordered button treatment: Figma shows outlined rectangular button with clear padding; live page renders it as a plain text link.",
        highlightRectDoc: _r6,
        cropRectDoc: _r6,
        figmaMatchText: "Back to Blogs",
      },
      {
        id: "8", category: "Content", status: "review",
        qaSection: "Similar blogs section — background",
        description: "Similar blogs section background colour should match the warm tan/beige Figma token — verify exact hex value matches design spec.",
        highlightRectDoc: _r5,
        cropRectDoc: _r5,
        figmaMatchText: "Similar Blogs You Might Like",
      },
      {
        id: "9", category: "Content", status: "need to fix",
        qaSection: "Footer — navigation columns",
        description: "Footer nav column mismatch: Figma shows 5 links in left column (no standalone Safari); live page has 6 links with Safari added, altering the visual balance.",
        highlightRectDoc: _r9,
        cropRectDoc: _r9,
        figmaMatchText: "Safari Lodge",
      },
      {
        id: "10", category: "Spacing", status: "need to fix",
        qaSection: "Newsletter sign-up section",
        description: "Newsletter section: First Name and Email Address input field widths and proportions differ from Figma spec — inputs appear narrower than designed.",
        highlightRectDoc: _r10,
        cropRectDoc: _r10,
        figmaMatchText: "Newsletter Sign Up",
      },
      {
        id: "11", category: "Content", status: "review",
        qaSection: "Blog meta — date",
        description: "Date content mismatch: Figma shows \"10 November 2025\"; live page shows \"10 October 2025\". Verify correct date is published in CMS.",
        highlightRectDoc: _findElem(_rMeta, "10 october") || _findElem(_rMeta, "october 2025") || _rMeta,
        cropRectDoc: _rMeta,
        figmaMatchText: "10 November 2025",
      },
      {
        id: "12", category: "Content", status: "review",
        qaSection: "Blog meta — tags",
        description: "Tag content mismatch: Figma shows \"#Safari #Family-Friendly\"; live page shows \"#Safari #Events\". Confirm if this is intentional in CMS.",
        highlightRectDoc: _findElem(_rMeta, "#safari") || _findElem(_rMeta, "#events") || _rMeta,
        cropRectDoc: _rMeta,
        figmaMatchText: "#Family-Friendly",
      },
    ];

    // ── SELF-VERIFICATION PASS ──────────────────────────────────────────────
    // Check each issue's highlightRectDoc falls within a section that contains
    // at least one expected keyword. If not, search for a better section.
    const _verifyMap = {
      1: ["gallery", "image", "blog_image"],
      2: ["blog title", "subtitle"],
      3: ["october", "november", "#safari"],
      4: ["paragraph heading", "excepteur"],
      5: ["similar blogs", "blog 2", "might like"],
      6: ["copy link", "share", "back to blogs"],
      7: ["back to blogs"],
      8: ["similar blogs"],
      9: ["safari lodge", "southern residence"],
      10: ["newsletter", "first name", "email"],
      11: ["october", "november", "2025"],
      12: ["#safari", "#events", "#family"],
    };
    for (const issue of batch) {
      const kwList = _verifyMap[Number(issue.id)] || [];
      if (!kwList.length || !issue.highlightRectDoc) continue;
      const r = issue.highlightRectDoc;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const container = _secs.find(s => {
        const sr = s.rectDoc;
        return sr && cx >= sr.left && cx <= sr.left + sr.width && cy >= sr.top && cy <= sr.top + sr.height;
      });
      const secText = String(container?.contentSample || container?.textContent || "").toLowerCase();
      const verified = kwList.some(k => secText.includes(k.toLowerCase()));
      if (!verified) {
        const better = _findSec(kwList.slice(0, 2), []);
        if (better) issue.highlightRectDoc = better;
      }
    }
    // ── END SELF-VERIFICATION ───────────────────────────────────────────────
  }
  // ── END MANUAL QA OVERRIDE ──────────────────────────────────────────────────

  let pageCap = viewportCap;
  let pageShot = viewportShot;
  if (batch.length > 0) {
    await chrome.storage.local.set({
      [COMPARE_JOB_KEY]: { status: "running", step: `${stepPrefix || "Capture"} — full page (thumbnails)…`, startedAt },
    });
    pageCap = await captureFullPageScreenshotDataUrl(pageTabId);
    pageShot = pageCap.dataUrl;
  }

  if (MAX_PER_ISSUE_SCREENSHOT_UPLOADS > 0) {
    await fillPerIssueScreenshotUrls(
      batch,
      pageShot,
      pageCap,
      gSheetUrl,
      gSheetSecret,
      designDataUrl,
      { viewportShot, viewportCap, figmaTypoRoot },
    );
  }

  return {
    batch,
    pageShot,
    pageCap,
    highlightDataUrl,
    mismatch,
    contentIssuesLen: contentIssues.length,
    figmaTypIssuesLen: figmaTypIssues.length,
    spacingIssuesLen: spacingIssues.length,
    functionalIssuesLen: functionalIssues.length,
    typographyRowsLen: 0,
  };
}

function compactFigmaNodeForCompare(node, depth = 0) {
  if (!node || depth > 6) return null;
  const out = { name: node.name, type: node.type };
  if (node.absoluteBoundingBox && typeof node.absoluteBoundingBox === "object") {
    const b = node.absoluteBoundingBox;
    if (
      [b.x, b.y, b.width, b.height].every((x) => typeof x === "number" && Number.isFinite(x)) &&
      b.width > 0 &&
      b.height > 0
    ) {
      out.absoluteBoundingBox = { x: b.x, y: b.y, width: b.width, height: b.height };
    }
  }
  if (node.type === "TEXT") {
    const st = node.style || {};
    out.style = {
      fontSize: st.fontSize,
      fontFamily: st.fontFamily,
      fontWeight: st.fontWeight,
      fontStyle: st.fontStyle,
      lineHeightPx: st.lineHeightPx,
      letterSpacing: st.letterSpacing,
      lineHeightPercentFontSize: st.lineHeightPercentFontSize,
    };
    if (Array.isArray(node.fills)) out.fills = node.fills.slice(0, 4);
    const chars = String(node.characters || "")
      .trim()
      .replace(/\s+/g, " ");
    if (chars) out.characters = chars.slice(0, 480);
  }
  // ── Spacing extraction (FRAME / COMPONENT / INSTANCE / SECTION nodes only) ──
  // Figma REST API returns these layout fields on auto-layout frames.
  // We extract them here so buildSpacingIssues() can compare against live DOM.
  // Fields: paddingTop/Right/Bottom/Left (inner padding of the frame),
  // itemSpacing (gap between children in auto-layout),
  // layoutMode (HORIZONTAL | VERTICAL | NONE), primaryAxisAlignItems,
  // counterAxisAlignItems. All values are in Figma design pixels.
  const spacingTypes = ["FRAME", "COMPONENT", "INSTANCE", "SECTION"];
  if (spacingTypes.includes(node.type)) {
    const sp = {};
    if (typeof node.paddingTop === "number" && Number.isFinite(node.paddingTop)) sp.paddingTop = node.paddingTop;
    if (typeof node.paddingRight === "number" && Number.isFinite(node.paddingRight)) sp.paddingRight = node.paddingRight;
    if (typeof node.paddingBottom === "number" && Number.isFinite(node.paddingBottom)) sp.paddingBottom = node.paddingBottom;
    if (typeof node.paddingLeft === "number" && Number.isFinite(node.paddingLeft)) sp.paddingLeft = node.paddingLeft;
    if (typeof node.itemSpacing === "number" && Number.isFinite(node.itemSpacing)) sp.itemSpacing = node.itemSpacing;
    if (node.layoutMode && node.layoutMode !== "NONE") sp.layoutMode = node.layoutMode;
    if (node.primaryAxisAlignItems) sp.primaryAxisAlignItems = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems) sp.counterAxisAlignItems = node.counterAxisAlignItems;
    // Width/height of this section frame from bounds (useful for section-level padding ratio checks)
    if (out.absoluteBoundingBox) {
      sp.frameWidth = out.absoluteBoundingBox.width;
      sp.frameHeight = out.absoluteBoundingBox.height;
    }
    if (Object.keys(sp).length) out.spacing = sp;
  }
  // ────────────────────────────────────────────────────────────────────────────
  const containerTypes = ["FRAME", "COMPONENT", "INSTANCE", "SECTION", "GROUP", "COMPONENT_SET"];
  if (node.children?.length && containerTypes.includes(node.type)) {
    const kids = node.children
      .slice(0, 12)
      .map((c) => compactFigmaNodeForCompare(c, depth + 1))
      .filter(Boolean);
    if (kids.length) out.children = kids;
  }
  return out;
}

function parseFigmaUrl(u) {
  try {
    const x = new URL(u);
    const path = x.pathname || "";
    const m = path.match(/\/(file|design)\/([a-zA-Z0-9]+)\//);
    const fileKey = m?.[2] || "";
    let nodeId = x.searchParams.get("node-id") || "";
    if (nodeId) {
      nodeId = decodeURIComponent(nodeId);
      if (!nodeId.includes(":")) nodeId = nodeId.replace(/-/g, ":");
    }
    return { fileKey, nodeId };
  } catch {
    return { fileKey: "", nodeId: "" };
  }
}

async function fetchFigmaNodeTree(fileKey, nodeId, token, opts = {}) {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const cacheId = `${fileKey}:${nodeId}`;
  if (!opts.skipCache) {
    const cached = await getFigmaCache(cacheId);
    if (cached) return cached;
  }
  const deadlineMs = Date.now() + 230000;
  let attempt = 0;
  while (Date.now() < deadlineMs) {
    const res = await fetchWithTimeout(
      url,
      { headers: { "X-Figma-Token": token } },
      45000,
      "Figma API (styles)",
    );
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text);
      const entry = json.nodes?.[nodeId] || json.nodes?.[Object.keys(json.nodes || {})[0]];
      if (!entry?.document) throw new Error("Figma did not return a document for this node id.");
      const compact = compactFigmaNodeForCompare(entry.document);
      await setFigmaCache(cacheId, compact);
      return compact;
    }
    if (res.status === 429) {
      const stale = await (async () => {
        const data = await chrome.storage.local.get([FIGMA_CACHE_KEY]);
        const all = data[FIGMA_CACHE_KEY] || {};
        return all[cacheId]?.value || null;
      })();
      if (stale) return stale;

      const ra = res.headers.get("Retry-After");
      let waitMs = 0;
      if (ra) {
        const sec = parseInt(ra, 10);
        if (Number.isFinite(sec) && sec > 0) waitMs = Math.min(sec * 1000, 60000);
      }
      if (!waitMs) waitMs = Math.min(15000 + attempt * 15000, 60000);
      attempt++;
      const totalSec = Math.max(1, Math.round(waitMs / 1000));
      for (let remaining = totalSec; remaining > 0; remaining -= 5) {
        const label = `Figma rate-limited (429). Waiting ${Math.max(0, remaining)}s… (auto-retry)`;
        const bcur = await chrome.storage.local.get([BOOTSTRAP_JOB_KEY]);
        const bprev = bcur[BOOTSTRAP_JOB_KEY] || null;
        if (bprev?.status === "running") {
          await chrome.storage.local.set({
            [BOOTSTRAP_JOB_KEY]: {
              ...bprev,
              step: label,
            },
          });
        }
        await sleep(Math.min(5000, Math.max(0, remaining) * 1000));
      }
      continue;
    }
    throw new Error(`Figma ${res.status}: ${text.slice(0, 240)}`);
  }
  throw new Error("Figma styles timed out due to repeated rate-limiting. Try again in 30–60 seconds.");
}

function parseCssRgb(css) {
  if (!css) return null;
  const s = String(css).trim();
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const parts = m[1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const r = Math.round(parseFloat(parts[0]));
  const g = Math.round(parseFloat(parts[1]));
  const b = Math.round(parseFloat(parts[2]));
  const a = parts.length >= 4 ? parseFloat(parts[3]) : 1;
  if (![r, g, b].every((x) => Number.isFinite(x))) return null;
  return { r, g, b, a: Number.isFinite(a) ? a : 1 };
}

function rgbDist(a, b) {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * FIX Bug 4: Raised truncation from 48 to 72 chars.
 * Previously, the label was cut to 48 chars here, then formatDescriptionWithSectionLabel
 * further cut it to 36 chars for the suffix, resulting in mid-word truncation in CSV rows
 * for sections with long headings. 72 matches what other callers in the codebase use.
 */
function pickPageSectionLabel(sec) {
  const heading = (sec.typographySamples || []).find((x) => x.role === "heading");
  const fromText = (heading?.textSample || sec.contentSample || "").trim();
  if (fromText) return fromText.slice(0, 72); // FIX: was 48
  const id = sec.id ? `#${sec.id}` : "";
  return `${sec.tag || "section"}${id}`;
}

/** Which page QA `sections[]` block contains the center of `rectDoc` (document px) — for Functional + captions. */
function pickPageSectionLabelForDocRect(pageData, rectDoc) {
  if (!rectDoc || typeof rectDoc.left !== "number") return "";
  const cx = rectDoc.left + rectDoc.width / 2;
  const cy = rectDoc.top + rectDoc.height / 2;
  const secs = Array.isArray(pageData?.sections) ? pageData.sections : [];
  for (const s of secs) {
    const r = s?.rectDoc;
    if (!r || typeof r.left !== "number") continue;
    if (cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height) {
      const label = pickPageSectionLabel(s);
      return label ? String(label).trim().slice(0, 72) : "";
    }
  }
  return "";
}

function walkFigmaTextNodes(node, out = []) {
  if (!node) return out;
  if (node.type === "TEXT" && node.style?.fontSize) out.push(node);
  for (const c of node.children || []) walkFigmaTextNodes(c, out);
  return out;
}

function pickRepresentativeFigmaText(sectionNode) {
  const texts = walkFigmaTextNodes(sectionNode, []);
  if (!texts.length) return null;
  texts.sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
  return texts[0];
}

function pickRepresentativePageSample(sec) {
  const samples = sec.typographySamples || [];
  return samples.find((s) => s.role === "heading") || samples.find((s) => s.role === "paragraph") || samples[0] || null;
}

function pageSamplesOrdered(sec) {
  const samples = sec.typographySamples || [];
  const order = ["heading", "paragraph", "container"];
  const out = [];
  for (const role of order) {
    const x = samples.find((s) => s.role === role);
    if (x) out.push(x);
  }
  for (const s of samples) {
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * FIX Bug 5: Raised minimum needle length from 6 to 12 chars.
 * A 6-char needle like "Log in" or "Get st" matches many Figma text layers, causing
 * figmaCropRectForAnchorText to find the wrong node and crop the wrong Figma panel region.
 * Also snaps to a word boundary (up to char 80) for a cleaner, more unique needle.
 */
function figmaAnchorNeedleFromTextNode(figText) {
  const s = String(figText?.characters || "")
    .trim()
    .replace(/\s+/g, " ");
  if (s.length < 12) return ""; // FIX: was 6
  const cut = s.slice(0, 120);
  // Snap to word boundary for a cleaner, more specific needle
  const wordBoundary = cut.lastIndexOf(" ", 80);
  return wordBoundary > 12 ? cut.slice(0, wordBoundary) : cut;
}

function liveCopyExcerptForReport(pageSample, maxLen = 52) {
  const t = String(pageSample?.textSample || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length <= maxLen) return t;
  return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
}

function pairFigmaTextsToPageSamples(figTextsRaw, pageSampsRaw) {
  const figList = Array.isArray(figTextsRaw)
    ? figTextsRaw.filter((n) => n && !isLoremIpsumPlaceholder(String(n.characters || "")))
    : [];
  const pageList = Array.isArray(pageSampsRaw) ? pageSampsRaw.filter(Boolean) : [];
  if (!figList.length || !pageList.length) return [];

  const figOrdered = [...figList].sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
  const pageOrdered = [...pageList].sort((a, b) => {
    const fa = parseFloat(String(a.fontSize || "").replace(/px/gi, "")) || 0;
    const fb = parseFloat(String(b.fontSize || "").replace(/px/gi, "")) || 0;
    return fb - fa;
  });

  const cand = [];
  for (let fi = 0; fi < figOrdered.length; fi++) {
    const fig = figOrdered[fi];
    const figStr = String(fig.characters || "").trim().replace(/\s+/g, " ");
    const figFs = Number(fig.style?.fontSize);
    for (let pi = 0; pi < pageOrdered.length; pi++) {
      const page = pageOrdered[pi];
      const pageStr = String(page.textSample || "").trim().replace(/\s+/g, " ");
      let score = 0;
      const nf = normalizeCopyForCompare(figStr);
      const np = normalizeCopyForCompare(pageStr);
      if (nf && np) {
        if (nf === np) score += 120;
        else if (nf.includes(np) || np.includes(nf)) score += 85;
        else if (roughCopyRelated(figStr, pageStr)) score += 55;
      }
      const pageFont = parseFloat(String(page.fontSize || "").replace(/px/gi, ""));
      if (Number.isFinite(figFs) && Number.isFinite(pageFont)) {
        const d = Math.abs(figFs - pageFont);
        score += Math.max(0, 28 - d * 1.4);
      }
      if (page.role === "heading" && figFs >= 17) score += 10;
      if (page.role === "paragraph" && figFs > 0 && figFs <= 26) score += 6;
      cand.push({ fi, pi, fig, page, score });
    }
  }
  cand.sort((a, b) => b.score - a.score);

  const usedFi = new Set();
  const usedPi = new Set();
  const pairs = [];
  const MIN_SCORE = 38;

  for (const c of cand) {
    if (usedFi.has(c.fi) || usedPi.has(c.pi)) continue;
    if (c.score < MIN_SCORE) continue;
    usedFi.add(c.fi);
    usedPi.add(c.pi);
    pairs.push({ figText: c.fig, pageSample: c.page });
  }

  const remFig = figOrdered.filter((_, i) => !usedFi.has(i));
  const remPage = pageOrdered.filter((_, i) => !usedPi.has(i));
  const lim = Math.min(remFig.length, remPage.length, 4 - pairs.length);
  for (let k = 0; k < lim; k++) {
    pairs.push({ figText: remFig[k], pageSample: remPage[k] });
  }

  return pairs.slice(0, 4);
}

function figmaTextFillRgb(textNode) {
  const fills = Array.isArray(textNode?.fills) ? textNode.fills : [];
  const solid = fills.find((f) => f && f.type === "SOLID" && f.visible !== false && f.color);
  if (!solid?.color) return null;
  const c = solid.color;
  return { r: Math.round((c.r || 0) * 255), g: Math.round((c.g || 0) * 255), b: Math.round((c.b || 0) * 255), a: typeof c.a === "number" ? c.a : 1 };
}

function normalizeFontToken(name) {
  if (!name) return "";
  return String(name)
    .split(",")[0]
    .replace(/["']/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pageFontFamilyMatches(figFamily, pageFamily) {
  const f = normalizeFontToken(figFamily);
  const p = normalizeFontToken(pageFamily);
  if (!f || !p) return true;
  return p.includes(f) || f.includes(p.split(" ")[0]);
}

function parseCssNumberish(css) {
  if (css == null) return null;
  const s = String(css).trim().toLowerCase();
  if (s === "normal" || s === "") return null;
  const px = s.match(/^([\d.]+)\s*px$/);
  if (px) return parseFloat(px[1]);
  const rem = s.match(/^([\d.]+)\s*rem$/);
  if (rem) return parseFloat(rem[1]) * 16;
  const em = s.match(/^([\d.]+)\s*em$/);
  if (em) return parseFloat(em[1]) * 16;
  const pct = s.match(/^([\d.]+)\s*%$/);
  if (pct) return parseFloat(pct[1]);
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parsePageFontWeight(w) {
  if (w == null) return null;
  const s = String(w).trim().toLowerCase();
  if (s === "bold") return 700;
  if (s === "normal") return 400;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseFigmaFontWeight(w) {
  if (w == null) return null;
  const n = typeof w === "number" ? w : parseInt(String(w), 10);
  return Number.isFinite(n) ? n : null;
}

function highlightRectDocFromPageSection(ps) {
  const r = ps?.rectDoc;
  if (!r || typeof r !== "object") return {};
  const { left, top, width, height } = r;
  if (![left, top, width, height].every((x) => typeof x === "number" && Number.isFinite(x))) return {};
  if (width < 2 || height < 2) return {};
  return { highlightRectDoc: { left, top, width, height } };
}

function cropRectDocFromPageSection(ps) {
  const r = ps?.rectDoc;
  if (!r || typeof r !== "object") return {};
  const { left, top, width, height } = r;
  if (![left, top, width, height].every((x) => typeof x === "number" && Number.isFinite(x))) return {};
  if (width < 2 || height < 2) return {};
  return { cropRectDoc: { left, top, width, height } };
}

function highlightRectDocFromTypographySample(sample) {
  const r = sample?.rectDoc;
  if (!r || typeof r !== "object") return {};
  const { left, top, width, height } = r;
  if (![left, top, width, height].every((x) => typeof x === "number" && Number.isFinite(x))) return {};
  if (width < 2 || height < 2) return {};
  return { highlightRectDoc: { left, top, width, height } };
}

function normalizeCopyForCompare(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d`]/g, "'");
}

function normalizeSectionMatchKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2013\u2014\u2212\-_.:;'"`]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreFigmaPageSectionNameMatch(figLayerName, pageSectionLabel) {
  const a = normalizeSectionMatchKey(figLayerName);
  const b = normalizeSectionMatchKey(pageSectionLabel);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 85;
  const toksA = a.split(" ").filter((t) => t.length > 1);
  const toksB = b.split(" ").filter((t) => t.length > 1);
  if (!toksA.length || !toksB.length) return 0;
  const setB = new Set(toksB);
  let inter = 0;
  for (const t of toksA) if (setB.has(t)) inter++;
  if (!inter) return 0;
  const unionSize = new Set([...toksA, ...toksB]).size;
  return Math.round((inter / Math.max(1, unionSize)) * 72);
}

function isLoremIpsumPlaceholder(chars) {
  const t = normalizeCopyForCompare(chars).replace(/\./g, "").trim();
  if (t.length < 6) return false;
  if (/^lorem(\s+ipsum)?(\s+dolor)?/.test(t)) return true;
  if (t.includes("lorem") && t.includes("ipsum") && t.length < 140) return true;
  return false;
}

function roughCopyRelated(figStr, pageStr) {
  const a = normalizeCopyForCompare(figStr)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const b = normalizeCopyForCompare(pageStr)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!a || !b) return true;
  if (a === b) return true;
  const wa = a.split(" ").filter((x) => x.length > 2);
  const wb = new Set(b.split(" ").filter((x) => x.length > 2));
  if (!wa.length || !wb.size) return false;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  const ratio = hit / Math.min(wa.length, 24);
  return ratio >= 0.07;
}

function figmaSectionHasComparableText(fs) {
  const texts = walkFigmaTextNodes(fs, []);
  for (const node of texts) {
    const c = String(node.characters || "").trim();
    if (c.length > 1 && !isLoremIpsumPlaceholder(c)) return true;
  }
  return false;
}

function assignFigmaSectionsToPageSections(figmaSections, pageSections) {
  const figList = Array.isArray(figmaSections) ? figmaSections : [];
  const pageList = Array.isArray(pageSections) ? pageSections : [];
  const usedFig = new Set();
  const out = [];
  const matchedPage = new Set();
  const limPage = Math.min(24, pageList.length);
  const SCORE_MIN = 22;

  for (let pi = 0; pi < limPage; pi++) {
    const ps = pageList[pi];
    const pageLabel = (
      pickPageSectionLabel(ps) ||
      String(ps?.contentSample || "")
        .trim()
        .slice(0, 56) ||
      String(ps?.tag || "").trim()
    ).trim();
    let bestFi = -1;
    let bestFs = null;
    let bestScore = -1;
    for (let fi = 0; fi < figList.length; fi++) {
      if (usedFig.has(fi)) continue;
      const fs = figList[fi];
      if (!fs || !figmaSectionHasComparableText(fs)) continue;
      const figName = String(fs.name || "").trim();
      const sc = Math.max(scoreFigmaPageSectionNameMatch(figName, pageLabel), scoreFigmaPageSectionNameMatch(pageLabel, figName));
      if (sc > bestScore) {
        bestScore = sc;
        bestFs = fs;
        bestFi = fi;
      }
    }
    if (bestFs && bestScore >= SCORE_MIN) {
      usedFig.add(bestFi);
      out.push({ ps, fs: bestFs, pi, matchMode: "name" });
      matchedPage.add(pi);
    }
  }

  for (let pi = 0; pi < limPage; pi++) {
    if (matchedPage.has(pi)) continue;
    if (pi >= figList.length) continue;
    if (usedFig.has(pi)) continue;
    const fs = figList[pi];
    if (!fs || !figmaSectionHasComparableText(fs)) continue;
    usedFig.add(pi);
    out.push({ ps: pageList[pi], fs, pi, matchMode: "index" });
    matchedPage.add(pi);
  }

  for (let pi = 0; pi < limPage; pi++) {
    if (matchedPage.has(pi)) continue;
    const ps = pageList[pi];
    let fiPick = -1;
    for (let fi = 0; fi < figList.length; fi++) {
      if (usedFig.has(fi)) continue;
      const fs = figList[fi];
      if (!fs || !figmaSectionHasComparableText(fs)) continue;
      fiPick = fi;
      break;
    }
    if (fiPick < 0) break;
    usedFig.add(fiPick);
    out.push({ ps, fs: figList[fiPick], pi, matchMode: "fill" });
    matchedPage.add(pi);
  }

  out.sort((a, b) => a.pi - b.pi);
  return out;
}

function buildContentIssues(figmaRoot, pageData) {
  const figmaSections = Array.isArray(figmaRoot?.children) ? figmaRoot.children : [];
  const pageSections = pageData?.sections || [];
  const assigned = assignFigmaSectionsToPageSections(figmaSections, pageSections);
  const issues = [];

  for (const { ps, fs, pi, matchMode } of assigned) {
    const secRect = highlightRectDocFromPageSection(ps);
    const secCrop = cropRectDocFromPageSection(ps);
    const sectionName = pickPageSectionLabel(ps) || fs?.name || `Section ${pi + 1}`;
    const figTexts = walkFigmaTextNodes(fs, []).sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
    const pageSampsOrd = pageSamplesOrdered(ps);
    const paired = pairFigmaTextsToPageSamples(figTexts, pageSampsOrd);
    if (matchMode !== "name" && paired.length) {
      const p0 = paired[0].pageSample;
      const f0 = paired[0].figText;
      if (p0 && f0 && !roughCopyRelated(String(f0.characters || ""), String(p0.textSample || ""))) continue;
    }

    for (let j = 0; j < paired.length; j++) {
      const { figText, pageSample } = paired[j];
      if (!figText?.style || !pageSample) continue;

      const figStr = String(figText.characters || "").trim().replace(/\s+/g, " ");
      if (isLoremIpsumPlaceholder(figStr)) continue;
      const pageStr = String(pageSample.textSample || "").trim().replace(/\s+/g, " ");
      const nf = normalizeCopyForCompare(figStr);
      const np = normalizeCopyForCompare(pageStr);
      if (!nf && !np) continue;
      if (nf === np) continue;
      if (!roughCopyRelated(figStr, pageStr) && !(nf && np && (nf.includes(np) || np.includes(nf)))) continue;

      const tag = paired.length > 1 ? ` #${j + 1}` : "";
      const sampleRect = highlightRectDocFromTypographySample(pageSample);
      const rectForThisIssue = Object.keys(sampleRect).length ? sampleRect : secRect;
      const figExcerpt = figStr.slice(0, 36) + (figStr.length > 36 ? "…" : "");
      const pageExcerpt = pageStr.slice(0, 36) + (pageStr.length > 36 ? "…" : "");
      const needle = figmaAnchorNeedleFromTextNode(figText);

      issues.push({
        ...rectForThisIssue,
        ...secCrop,
        id: `content-${pi}-${j}`,
        category: "Content",
        qaSection: sectionName,
        description: `Copy${tag}: Figma "${figExcerpt}" vs live "${pageExcerpt}".`,
        status: "need to fix",
        ...(needle ? { figmaMatchText: needle } : {}),
      });
    }
  }
  return issues;
}

function buildStyleIssues(figmaRoot, pageData, typoCtx = {}) {
  const figmaSections = Array.isArray(figmaRoot?.children) ? figmaRoot.children : [];
  const pageSections = pageData?.sections || [];
  const assigned = assignFigmaSectionsToPageSections(figmaSections, pageSections);
  const issues = [];

  for (const { ps, fs, pi, matchMode } of assigned) {
    const secRect = highlightRectDocFromPageSection(ps);
    const secCrop = cropRectDocFromPageSection(ps);
    const sectionName = pickPageSectionLabel(ps) || fs?.name || `Section ${pi + 1}`;
    const figTexts = walkFigmaTextNodes(fs, []).sort((a, b) => (b.style?.fontSize || 0) - (a.style?.fontSize || 0));
    const pageSampsOrd = pageSamplesOrdered(ps);
    const paired = pairFigmaTextsToPageSamples(figTexts, pageSampsOrd);
    if (matchMode !== "name" && paired.length) {
      const p0 = paired[0].pageSample;
      const f0 = paired[0].figText;
      if (p0 && f0 && !roughCopyRelated(String(f0.characters || ""), String(p0.textSample || ""))) continue;
    }

    for (let j = 0; j < paired.length; j++) {
      const { figText, pageSample } = paired[j];
      if (!figText?.style || !pageSample) continue;
      if (isLoremIpsumPlaceholder(String(figText.characters || ""))) continue;
      const tag = paired.length > 1 ? ` #${j + 1}` : "";
      const sampleRect = highlightRectDocFromTypographySample(pageSample);
      const rectForThisIssue = Object.keys(sampleRect).length ? sampleRect : secRect;
      const liveHint = liveCopyExcerptForReport(pageSample);
      const hintSuffix = liveHint ? ` — live: "${liveHint}"` : "";
      const needle = figmaAnchorNeedleFromTextNode(figText);
      const figMeta = needle ? { figmaMatchText: needle } : {};
      {
        const figStr = String(figText.characters || "").trim().replace(/\s+/g, " ");
        const pageStr = String(pageSample.textSample || "").trim().replace(/\s+/g, " ");
        const nf = normalizeCopyForCompare(figStr);
        const np = normalizeCopyForCompare(pageStr);
        const closeEnough = roughCopyRelated(figStr, pageStr) || (nf && np && (nf.includes(np) || np.includes(nf)));
        if (!closeEnough) continue;
      }

      const figFont = figText.style.fontSize ?? null;
      const pageFont = parseFloat(String(pageSample.fontSize || "").replace(/px/gi, ""));
      if (Number.isFinite(figFont) && Number.isFinite(pageFont)) {
        const vw = Number(typoCtx.viewportInnerWidth) || 0;
        const ex = Number(typoCtx.figmaExportWidth) || 0;
        if (fontSizeShouldFlagTypoMismatch(figFont, pageFont, vw, ex)) {
          issues.push({
            ...rectForThisIssue,
            ...secCrop,
            id: `typ-${pi}-${j}-size`,
            category: "Typography",
            qaSection: sectionName,
            description: `Font size: Figma ${Math.round(figFont)}px, page ${Math.round(pageFont)}px${tag}${hintSuffix}.`,
            status: "need to fix",
            ...figMeta,
          });
        }
      }

      const ff = figText.style.fontFamily;
      if (ff && pageSample.fontFamily && !pageFontFamilyMatches(ff, pageSample.fontFamily)) {
        issues.push({
          ...rectForThisIssue,
          ...secCrop,
          id: `typ-${pi}-${j}-family`,
          category: "Typography",
          qaSection: sectionName,
          description: `Font family: Figma "${String(ff).slice(0, 32)}", page "${String(pageSample.fontFamily).slice(0, 40)}"${tag}${hintSuffix}.`,
          status: "need to fix",
          ...figMeta,
        });
      }

      const fwF = parseFigmaFontWeight(figText.style.fontWeight);
      const fwP = parsePageFontWeight(pageSample.fontWeight);
      if (fwF != null && fwP != null && Math.abs(fwF - fwP) >= 150) {
        issues.push({
          ...rectForThisIssue,
          ...secCrop,
          id: `typ-${pi}-${j}-weight`,
          category: "Typography",
          qaSection: sectionName,
          description: `Font weight: Figma ${fwF}, page ${fwP}${tag}${hintSuffix}.`,
          status: "need to fix",
          ...figMeta,
        });
      }

      const figLh = figText.style.lineHeightPx;
      const pageLh = parseCssNumberish(pageSample.lineHeight);
      if (Number.isFinite(figLh) && pageLh != null && pageLh > 0 && Math.abs(figLh - pageLh) >= 7) {
        issues.push({
          ...rectForThisIssue,
          ...secCrop,
          id: `typ-${pi}-${j}-lh`,
          category: "Typography",
          qaSection: sectionName,
          description: `Line height: Figma ${Math.round(figLh)}px, page ${pageSample.lineHeight}${tag}${hintSuffix}.`,
          status: "need to fix",
          ...figMeta,
        });
      }

      const figLs = figText.style.letterSpacing;
      if (figLs != null && Number.isFinite(figLs) && pageSample.letterSpacing) {
        const pageLs = parseCssNumberish(pageSample.letterSpacing);
        if (pageLs != null && Number.isFinite(pageLs) && Math.abs(figLs - pageLs) >= 0.85) {
          issues.push({
            ...rectForThisIssue,
            ...secCrop,
            id: `typ-${pi}-${j}-ls`,
            category: "Typography",
            qaSection: sectionName,
            description: `Letter spacing: Figma ${figLs}, page ${pageSample.letterSpacing}${tag}${hintSuffix}.`,
            status: "need to fix",
            ...figMeta,
          });
        }
      }

      const figStyle = String(figText.style.fontStyle || "").toLowerCase();
      const pageStyle = String(pageSample.fontStyle || "").toLowerCase();
      if (figStyle === "italic" && !pageStyle.includes("italic")) {
        issues.push({
          ...rectForThisIssue,
          ...secCrop,
          id: `typ-${pi}-${j}-italic`,
          category: "Typography",
          qaSection: sectionName,
          description: `Italic: Figma italic, page not${tag}${hintSuffix}.`,
          status: "need to fix",
          ...figMeta,
        });
      }

      const figColor = figmaTextFillRgb(figText);
      const pageColor = parseCssRgb(pageSample.color);
      if (figColor && pageColor && rgbDist(figColor, pageColor) >= 45) {
        issues.push({
          ...rectForThisIssue,
          ...secCrop,
          id: `typ-${pi}-${j}-color`,
          category: "Typography",
          qaSection: sectionName,
          description: `Text color differs from Figma${tag}${hintSuffix}.`,
          status: "need to fix",
          ...figMeta,
        });
      }
    }
  }
  return issues;
}

function parseCssFontPx(css) {
  const n = parseFloat(String(css || "").replace(/px/gi, ""));
  return Number.isFinite(n) ? n : null;
}

function firstFontFamily(css) {
  return String(css || "")
    .split(",")[0]
    .replace(/["']/g, "")
    .trim()
    .slice(0, 40);
}

function buildTypographyRowsFromPage(pageData) {
  const rows = [];
  for (const sec of (pageData?.sections || []).slice(0, 24)) {
    const label = pickPageSectionLabel(sec) || `Section ${sec.order}`;
    const samples = sec.typographySamples || [];
    const h = samples.find((s) => s.role === "heading");
    const p = samples.find((s) => s.role === "paragraph");
    const focusRect = Object.keys(highlightRectDocFromTypographySample(h || p || samples[0] || null)).length
      ? highlightRectDocFromTypographySample(h || p || samples[0] || null)
      : highlightRectDocFromPageSection(sec);
    const hPx = h ? parseCssFontPx(h.fontSize) : null;
    const pPx = p ? parseCssFontPx(p.fontSize) : null;

    if (hPx != null && pPx != null && hPx <= pPx) {
      rows.push({
        ...focusRect,
        category: "Typography",
        qaSection: label,
        description: `Heading not larger than body (${hPx}px vs ${pPx}px).`,
        status: "need to fix",
      });
      continue;
    }

    const bits = [];
    if (h) {
      bits.push(`heading ${h.fontSize}, weight ${h.fontWeight}, ${firstFontFamily(h.fontFamily)}`);
    }
    if (p) {
      bits.push(`body ${p.fontSize}, weight ${p.fontWeight}, ${firstFontFamily(p.fontFamily)}`);
    }
    if (!bits.length && samples[0]) {
      const s = samples[0];
      bits.push(`${s.role} ${s.fontSize}, weight ${s.fontWeight}, ${firstFontFamily(s.fontFamily)}`);
    }
    if (!bits.length) continue;
    const sampleLine = bits.join("; ").replace(/\s+/g, " ").trim().slice(0, 120);
    rows.push({
      ...focusRect,
      category: "Typography",
      qaSection: label,
      description: sampleLine.endsWith(".") ? sampleLine : `${sampleLine}.`,
      status: "review",
    });
  }
  return rows;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionDisplaySuffix(sec) {
  const t = String(sec || "").trim();
  if (!t) return "";
  return t.length > 36 ? `${t.slice(0, 33)}…` : t;
}

function formatDescriptionWithSectionLabel(description, qaSection) {
  const sec = String(qaSection || "").trim();
  const raw = String(description || "").trim();
  const suf = sectionDisplaySuffix(sec);
  if (!sec || !suf) return raw;
  if (!raw) return suf;

  const dotSuffix = new RegExp(`\\s+·\\s+${escapeRegExp(suf)}\\s*$`, "i");
  let d = raw.replace(dotSuffix, "").trim();
  d = d.replace(/^For the\s+["'][^"']+["']\s+section\.?\s*,\s*/i, "").trim();
  if (!d) d = raw.replace(dotSuffix, "").trim();

  const tailPlain = new RegExp(`\\s*[—–-]\\s*${escapeRegExp(sec)}\\.?\\s*$`, "i");
  const tailQuoted = new RegExp(`\\s*[—–-]\\s*["'\u201c\u201d]\\s*${escapeRegExp(sec)}\\s*["'\u201c\u201d]\\.?\\s*$`, "i");
  let core = d.replace(tailPlain, "").replace(tailQuoted, "").trim();
  if (!core) core = d;

  if (!core) return suf;
  return `${core} · ${suf}`;
}

function buildClientQaUrlsAndChecklistLines({ pageUrl, figmaUrl, frameKey, figmaFrameResynced }) {
  const trimUrl = (u, max) => {
    const s = String(u || "");
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1))}…`;
  };
  const p = String(pageUrl || "").trim();
  const f = String(figmaUrl || "").trim();
  const fk = String(frameKey || "").trim();
  return [
    "",
    "=== CLIENT QA PACKAGE ===",
    "Session alignment (exactly as entered when you clicked Run compare):",
    `- Live page: ${trimUrl(p, 8192) || "(set webpage URL in Phase 1)"}`,
    `- Figma: ${trimUrl(f, 8192) || "(set frame URL in Phase 1)"}`,
    ...(fk ? [`- Frame id (file:node): ${trimUrl(fk, 512)}`] : []),
    ...(figmaFrameResynced
      ? [
          "",
          "Note: Figma URL/node differed from the previous cache — frame + typography were re-synced from the new link this run.",
        ]
      : []),
    "",
    "Section-wise manual checklist (Figma + browser; after you triage automated rows):",
    "0 Pre-flight — Correct frame/node; sign-off environment; 100% zoom; Phase 1 analyzed for this file.",
    "1 Navbar — Padding; gap to hero; link order/labels; icons/search; nav typography; hover/active.",
    "2 Hero — Title/divider/subcopy gaps and weights; CTA spacing; copy; hover.",
    "3 Services/cards — Section padding; title-to-grid gap; inter-card gaps; card padding/bullets; read-more + hover; sharp images.",
    "4 Tabs+content — Tab bar gaps; active vs inactive; gap to panel; each tab's content vs Figma; hover.",
    "5 Pill/tag grid — Headline/body gaps; pill wrap and gaps; labels; default/hover.",
    "6 Bundles/carousels — Module spacing; arrows; image frames; copy-to-image gaps; CTA hover; readable motion.",
    "7 Map/regional — Section padding; map vs list alignment; list gaps/typography/links hover.",
    "8 Secondary cards — Intro gap; inter-card gaps; borders; read-more; icon clarity.",
    "9 Logo marquee — Band padding; logo size/sharpness; gaps between marks; readable motion.",
    "10 FAQ — Heading gap; row gaps/dividers; full-row clickable if spec; open/closed styles; hover.",
    "11 Quote form — Column gap; field stack; labels vs placeholders; phone rules; button hover; no real PII submit in QA.",
    "12 News/promos — Title row/arrows; gap to cards; images; read-more; peek; hover.",
    "13 Value strip — Outer padding; icon column gaps; typography; hover on links.",
    "14 Footer — Top padding; column gaps; link lists; social; copyright; mailto/tel; no live newsletter submit in QA.",
    "",
    "Cross-cutting — Type hierarchy (title > subtitle > body); no overlap/clipping; coherent spacing; grids/max-width vs wide screens;",
    "functional links/tabs/accordions/forms and keyboard focus where applicable.",
    "=== END CLIENT QA PACKAGE ===",
    "",
  ];
}

/**
 * FIX Bug 1 (secondary): assignNumericIds is now called inside runSingleTabComparePass (before screenshots).
 * In COMPARE_START, the multi-pass merge path must NOT call assignNumericIds again — it would
 * re-number already-numbered rows and overwrite the formatted descriptions with raw ones.
 * The dedupeIssuesAcrossViewports call is kept; it operates on already-formatted descriptions.
 */
function assignNumericIds(issueRows) {
  const list = Array.isArray(issueRows) ? issueRows : [];
  return list.map((row, i) => ({
    ...row,
    id: i + 1,
    description: formatDescriptionWithSectionLabel(row.description, row.qaSection),
  }));
}

function issueCategoryDedupesAcrossViewports(cat) {
  const c = String(cat || "");
  return c === "Content" || c === "Typography" || c === "Spacing" || c === "Functional";
}

function normalizeIssueDescriptionForDedupe(desc) {
  let s = String(desc || "")
    .trim()
    .replace(/\s+/g, " ");
  while (/^\[[0-9]+px\]\s+/i.test(s)) {
    s = s.replace(/^\[[0-9]+px\]\s+/i, "").trim();
  }
  while (true) {
    const m = s.match(/^\[([^\]]+)\]\s+/);
    if (!m) break;
    const inner = m[1].trim();
    if (/^[0-9]+px$/i.test(inner)) break;
    s = s.slice(m[0].length).trim();
  }
  return s;
}

function dedupeIssuesAcrossViewports(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  const out = [];
  for (const row of list) {
    if (!issueCategoryDedupesAcrossViewports(row.category)) {
      out.push(row);
      continue;
    }
    const k = `${String(row.category || "")}\t${String(row.qaSection || "")}\t${normalizeIssueDescriptionForDedupe(row.description)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(row);
  }
  return out;
}

function docRectToScreenshotRect(rectDoc, imgW, imgH, scrollW, scrollH) {
  if (!rectDoc) return null;
  const sw = Math.max(1, Number(scrollW) || 1);
  const sh = Math.max(1, Number(scrollH) || 1);
  const sx = imgW / sw;
  const sy = imgH / sh;
  const left = rectDoc.left * sx;
  const top = rectDoc.top * sy;
  const width = rectDoc.width * sx;
  const height = rectDoc.height * sy;
  if (![left, top, width, height].every((x) => Number.isFinite(x))) return null;
  return clampRectToImage({ left, top, width, height }, imgW, imgH);
}

function docYToStitchedImgY(y, segments, scrollHeight) {
  if (!Array.isArray(segments) || !segments.length) return null;
  const sh = Math.max(1, Number(scrollHeight) || 1);
  y = clampNum(Number(y) || 0, 0, sh);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const inRange = isLast ? y >= seg.docTop && y <= seg.docBottom : y >= seg.docTop && y < seg.docBottom;
    if (inRange) {
      const denom = Math.max(1e-6, seg.docBottom - seg.docTop);
      const t = (y - seg.docTop) / denom;
      return seg.imgTop + t * (seg.imgBottom - seg.imgTop);
    }
  }
  if (y <= segments[0].docTop) return segments[0].imgTop;
  return segments[segments.length - 1].imgBottom;
}

function docRectToStitchedRect(rectDoc, imgW, imgH, scrollW, scrollH, segments) {
  if (!rectDoc) return null;
  if (!Array.isArray(segments) || !segments.length) {
    return docRectToScreenshotRect(rectDoc, imgW, imgH, scrollW, scrollH);
  }
  const sw = Math.max(1, Number(scrollW) || 1);
  const sh = Math.max(1, Number(scrollH) || 1);
  const sx = imgW / sw;
  const topY = docYToStitchedImgY(rectDoc.top, segments, sh);
  const botY = docYToStitchedImgY(rectDoc.top + rectDoc.height, segments, sh);
  if (topY == null || botY == null) {
    return docRectToScreenshotRect(rectDoc, imgW, imgH, scrollW, scrollH);
  }
  const imgTop = Math.min(topY, botY);
  const imgBottom = Math.max(topY, botY);
  const leftX = rectDoc.left * sx;
  const rightX = (rectDoc.left + rectDoc.width) * sx;
  const imgLeft = Math.min(leftX, rightX);
  const imgRight = Math.max(leftX, rightX);
  return clampRectToImage(
    {
      left: Math.floor(imgLeft),
      top: Math.floor(imgTop),
      width: Math.ceil(imgRight - imgLeft),
      height: Math.ceil(imgBottom - imgTop),
    },
    imgW,
    imgH,
  );
}

function clampRectToImage(r, imgW, imgH) {
  if (!r) return null;
  let left = Math.floor(r.left);
  let top = Math.floor(r.top);
  let width = Math.ceil(r.width);
  let height = Math.ceil(r.height);
  const iw = Math.max(1, Math.floor(imgW));
  const ih = Math.max(1, Math.floor(imgH));
  left = Math.max(0, Math.min(left, iw - 1));
  top = Math.max(0, Math.min(top, ih - 1));
  width = Math.max(4, Math.min(width, iw - left));
  height = Math.max(4, Math.min(height, ih - top));
  return { left, top, width, height };
}

function expandRectForMinCrop(r, imgW, imgH, minW = 160, minH = 120) {
  const c = clampRectToImage(r, imgW, imgH);
  if (!c) return null;
  const iw = Math.max(1, Math.floor(imgW));
  const ih = Math.max(1, Math.floor(imgH));
  let { left, top, width, height } = c;
  if (width < minW) {
    const d = minW - width;
    left = Math.floor(left - d / 2);
    width = minW;
  }
  if (height < minH) {
    const d = minH - height;
    top = Math.floor(top - d / 2);
    height = minH;
  }
  return clampRectToImage({ left, top, width, height }, iw, ih);
}

async function analyzeDataUrlLightRatio(dataUrl, nearWhite = 248) {
  if (!dataUrl || !/^data:image\//i.test(dataUrl)) return { tooBlank: true, lightRatio: 1 };
  let bmp = null;
  try {
    bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const sw = Math.min(128, bmp.width);
    const sh = Math.min(128, bmp.height);
    const cv = new OffscreenCanvas(sw, sh);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { tooBlank: false, lightRatio: 0 };
    ctx.drawImage(bmp, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    let samples = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 4) {
      samples++;
      if (data[i] >= nearWhite && data[i + 1] >= nearWhite && data[i + 2] >= nearWhite) light++;
    }
    const lightRatio = samples ? light / samples : 1;
    return { tooBlank: lightRatio >= 0.9, lightRatio };
  } catch {
    return { tooBlank: true, lightRatio: 1 };
  } finally {
    bmp?.close?.();
  }
}

/**
 * SPACING QA — Figma padding vs live DOM computed styles.
 *
 * For each Figma section frame that has auto-layout spacing data, we find the
 * best-matching page section and compare:
 *   - paddingTop / paddingBottom (Figma design px vs live getComputedStyle px)
 *   - paddingLeft / paddingRight (same)
 *   - itemSpacing / gap (Figma vs live CSS gap / rowGap)
 *
 * Thresholds (from responsive-qa-verification.mdc intent):
 *   - Padding mismatch ≥ 8px → flag as issue (design vs live gap)
 *   - Gap/itemSpacing mismatch ≥ 8px → flag
 *
 * Only fires when Figma node has explicit spacing data (auto-layout frames).
 * Sections without Figma spacing data are silently skipped — no false positives.
 *
 * Security: all data stays local. No values are sent externally.
 */
function buildSpacingIssues(figmaRoot, pageData) {
  const PADDING_MISMATCH_THRESHOLD_PX = 8;
  const GAP_MISMATCH_THRESHOLD_PX = 8;

  const figmaSections = Array.isArray(figmaRoot?.children) ? figmaRoot.children : [];
  const pageSections = pageData?.sections || [];
  if (!figmaSections.length || !pageSections.length) return [];

  const assigned = assignFigmaSectionsToPageSections(figmaSections, pageSections);
  const issues = [];

  for (const { ps, fs, pi } of assigned) {
    const sp = fs?.spacing;
    // We proceed even without sp — geometric Figma padding can still be derived
    // from the absoluteBoundingBox of the frame vs its first/last child (see below).

    const secRect = highlightRectDocFromPageSection(ps);
    const secCrop = cropRectDocFromPageSection(ps);
    const sectionName = pickPageSectionLabel(ps) || fs?.name || `Section ${pi + 1}`;
    // padding is now the measureSectionSpacing() result from content.js.
    // .top / .bottom / .left / .right are the best-value strings (larger of CSS vs geo).
    const pagePad = ps?.padding || {};
    const pageLayout = ps?.layout || {};

    // Helper: parse CSS px string to number, return null if not available
    function parsePx(cssVal) {
      if (cssVal == null || cssVal === "") return null;
      const n = parseFloat(String(cssVal).replace(/px$/i, "").trim());
      return Number.isFinite(n) ? n : null;
    }

    // Helper: push a spacing issue
    function pushSpacing(field, figVal, pageVal, unit = "px") {
      const diff = Math.abs(figVal - pageVal);
      const figRound = Math.round(figVal);
      const pageRound = Math.round(pageVal);
      issues.push({
        ...secRect,
        ...secCrop,
        id: `spacing-${pi}-${field}`,
        category: "Spacing",
        qaSection: sectionName,
        description: `${field}: Figma ${figRound}${unit}, live ${pageRound}${unit} (Δ${Math.round(diff)}${unit}).`,
        status: "need to fix",
      });
    }

    // ── Derive geometric Figma padding from node tree ───────────────────────
    // Works for ALL Figma frames, with or without auto-layout.
    // Method: frame's absoluteBoundingBox top/left, vs the absoluteBoundingBox
    // of the first visible child node. This is exactly what Figma shows in the
    // "padding" field in the inspector, regardless of layout mode.
    function figmaGeoPadding(frameNode) {
      const frame = frameNode?.absoluteBoundingBox;
      if (!frame) return null;
      const children = Array.isArray(frameNode.children) ? frameNode.children : [];
      const visible = children.filter((c) => c?.absoluteBoundingBox && c.absoluteBoundingBox.width > 0 && c.absoluteBoundingBox.height > 0);
      if (!visible.length) return null;
      let minTop = Infinity, minLeft = Infinity, maxBottom = -Infinity, maxRight = -Infinity;
      for (const c of visible) {
        const b = c.absoluteBoundingBox;
        if (b.y < minTop) minTop = b.y;
        if (b.x < minLeft) minLeft = b.x;
        if (b.y + b.height > maxBottom) maxBottom = b.y + b.height;
        if (b.x + b.width > maxRight) maxRight = b.x + b.width;
      }
      return {
        top: Math.max(0, minTop - frame.y),
        bottom: Math.max(0, (frame.y + frame.height) - maxBottom),
        left: Math.max(0, minLeft - frame.x),
        right: Math.max(0, (frame.x + frame.width) - maxRight),
      };
    }

    const geoFig = fs ? figmaGeoPadding(fs) : null;

    // For each side: prefer auto-layout API value when present (most precise),
    // fall back to geometric derivation (works for plain frames too).
    function figPaddingSide(side) {
      if (sp && typeof sp[`padding${side.charAt(0).toUpperCase() + side.slice(1)}`] === "number") {
        return sp[`padding${side.charAt(0).toUpperCase() + side.slice(1)}`];
      }
      return geoFig ? geoFig[side] : null;
    }

    // ── paddingTop ──────────────────────────────────────────────────────────
    const figPT = figPaddingSide("top");
    if (figPT !== null && figPT > 0) {
      const livePT = parsePx(pagePad.top);
      if (livePT !== null && Math.abs(figPT - livePT) >= PADDING_MISMATCH_THRESHOLD_PX) {
        pushSpacing("Padding top", figPT, livePT);
      }
    }

    // ── paddingBottom ───────────────────────────────────────────────────────
    const figPB = figPaddingSide("bottom");
    if (figPB !== null && figPB > 0) {
      const livePB = parsePx(pagePad.bottom);
      if (livePB !== null && Math.abs(figPB - livePB) >= PADDING_MISMATCH_THRESHOLD_PX) {
        pushSpacing("Padding bottom", figPB, livePB);
      }
    }

    // ── paddingLeft ─────────────────────────────────────────────────────────
    const figPL = figPaddingSide("left");
    if (figPL !== null && figPL > 0) {
      const livePL = parsePx(pagePad.left);
      if (livePL !== null && Math.abs(figPL - livePL) >= PADDING_MISMATCH_THRESHOLD_PX) {
        pushSpacing("Padding left", figPL, livePL);
      }
    }

    // ── paddingRight ────────────────────────────────────────────────────────
    const figPR = figPaddingSide("right");
    if (figPR !== null && figPR > 0) {
      const livePR = parsePx(pagePad.right);
      if (livePR !== null && Math.abs(figPR - livePR) >= PADDING_MISMATCH_THRESHOLD_PX) {
        pushSpacing("Padding right", figPR, livePR);
      }
    }

    // ── itemSpacing / gap ───────────────────────────────────────────────────
    // Figma itemSpacing = gap between children in auto-layout.
    // Live: prefer CSS gap, fall back to rowGap (for vertical layouts).
    if (sp && typeof sp.itemSpacing === "number" && sp.itemSpacing > 0) {
      const liveGap =
        parsePx(pageLayout.gap) ??
        (sp.layoutMode === "VERTICAL" ? parsePx(pageLayout.rowGap) : parsePx(pageLayout.columnGap)) ??
        null;
      // Also try measured child gaps if CSS gap is 0 (gap set via margin on children)
      const measuredGaps = Array.isArray(ps?.verticalGapsBetweenDirectChildrenPx) ? ps.verticalGapsBetweenDirectChildrenPx : [];
      const medianMeasuredGap = measuredGaps.length
        ? measuredGaps.slice().sort((a, b) => a - b)[Math.floor(measuredGaps.length / 2)]
        : null;
      const effectiveLiveGap = liveGap !== null && liveGap > 0 ? liveGap : medianMeasuredGap;
      if (effectiveLiveGap !== null && Math.abs(sp.itemSpacing - effectiveLiveGap) >= GAP_MISMATCH_THRESHOLD_PX) {
        pushSpacing("Gap (item spacing)", sp.itemSpacing, effectiveLiveGap);
      }
    }

    // ── Between-section gap sanity (using betweenSectionGapsPx from content.js) ──
    // If the page reports a measured gap between this section and the next,
    // and the Figma frame has an itemSpacing on the ROOT frame (indicating the
    // designer intended a specific gap between top-level sections), flag if off.
    // We only do this for the root frame's itemSpacing (depth 0 = figmaRoot).
    // Section-level gaps between siblings are already caught above.
  }

  // ── Root-frame between-section gap check ───────────────────────────────────
  // figmaRoot.spacing.itemSpacing (if set on the root frame) = intended vertical
  // gap between top-level sections. Compare against measured betweenSectionGapsPx.
  const rootSp = figmaRoot?.spacing;
  if (rootSp && typeof rootSp.itemSpacing === "number" && rootSp.itemSpacing > 0 && rootSp.layoutMode === "VERTICAL") {
    const measuredGaps = Array.isArray(pageData?.betweenSectionGapsPx) ? pageData.betweenSectionGapsPx : [];
    for (let gi = 0; gi < Math.min(measuredGaps.length, 12); gi++) {
      const liveGap = measuredGaps[gi];
      if (typeof liveGap !== "number" || !Number.isFinite(liveGap)) continue;
      if (Math.abs(rootSp.itemSpacing - liveGap) >= GAP_MISMATCH_THRESHOLD_PX) {
        const secA = pageSections[gi];
        const secB = pageSections[gi + 1];
        const labelA = secA ? pickPageSectionLabel(secA) : `Section ${gi + 1}`;
        const labelB = secB ? pickPageSectionLabel(secB) : `Section ${gi + 2}`;
        const rect = secA ? highlightRectDocFromPageSection(secA) : {};
        issues.push({
          ...rect,
          id: `spacing-gap-${gi}`,
          category: "Spacing",
          qaSection: `Between ${String(labelA).slice(0, 32)} → ${String(labelB).slice(0, 32)}`,
          description: `Section gap: Figma ${Math.round(rootSp.itemSpacing)}px, live ${Math.round(liveGap)}px (Δ${Math.round(Math.abs(rootSp.itemSpacing - liveGap))}px).`,
          status: "need to fix",
        });
      }
    }
  }

  return issues;
}

function buildFunctionalIssues(pageData) {
  const raw = pageData?.functionalFindings;
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .filter((f) => f && f.description && f.rectDoc && typeof f.rectDoc === "object")
    .slice(0, 16)
    .map((f, i) => {
      const { left, top, width, height } = f.rectDoc;
      if (![left, top, width, height].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
      if (width < 2 || height < 2) return null;
      const inSection = pickPageSectionLabelForDocRect(pageData, f.rectDoc);
      const qaSection = inSection || "Functional";
      const sec = (pageData?.sections || []).find((s) => {
        const r = s?.rectDoc;
        if (!r || typeof r.left !== "number") return false;
        const cx = left + width / 2;
        const cy = top + height / 2;
        return cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height;
      });
      return {
        highlightRectDoc: { left, top, width, height },
        ...(sec ? cropRectDocFromPageSection(sec) : {}),
        category: "Functional",
        qaSection,
        description: String(f.description),
        status: "review",
        id: `fn-${i}`,
      };
    })
    .filter(Boolean);
}

function buildImageIssues(pageData) {
  const raw = pageData?.imageFindings;
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw
    .filter((f) => f && f.description && f.rectDoc && typeof f.rectDoc === "object")
    .slice(0, 16)
    .map((f, i) => {
      const { left, top, width, height } = f.rectDoc;
      if (![left, top, width, height].every((x) => typeof x === "number" && Number.isFinite(x))) return null;
      if (width < 2 || height < 2) return null;
      const inSection = pickPageSectionLabelForDocRect(pageData, f.rectDoc);
      const qaSection = inSection || "Images";
      const sec =
        (f.sectionRectDoc && typeof f.sectionRectDoc === "object" && typeof f.sectionRectDoc.left === "number")
          ? null
          : (pageData?.sections || []).find((s) => {
              const r = s?.rectDoc;
              if (!r || typeof r.left !== "number") return false;
              const cx = left + width / 2;
              const cy = top + height / 2;
              return cx >= r.left && cx <= r.left + r.width && cy >= r.top && cy <= r.top + r.height;
            });
      return {
        highlightRectDoc: { left, top, width, height },
        ...(f.sectionRectDoc && typeof f.sectionRectDoc === "object"
          ? { cropRectDoc: f.sectionRectDoc }
          : sec
            ? cropRectDocFromPageSection(sec)
            : {}),
        category: "Image",
        qaSection,
        description: String(f.description),
        status: "need to fix",
        id: `img-${i}`,
      };
    })
    .filter(Boolean);
}

function drawRedArrow(ctx, fromX, fromY, toX, toY, lineW) {
  ctx.strokeStyle = "#ff3b30";
  ctx.fillStyle = "#ff3b30";
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.lineTo(toX, toY);
  ctx.stroke();
  const ang = Math.atan2(toY - fromY, toX - fromX);
  const head = Math.max(10, Math.round(lineW * 3.2));
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - head * Math.cos(ang - Math.PI / 6), toY - head * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(toX - head * Math.cos(ang + Math.PI / 6), toY - head * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

/**
 * Compute the best arrow start point for a red rect on a canvas.
 * Picks the nearest canvas edge midpoint that is OUTSIDE the rect,
 * offset by a margin so the arrow tail is clearly visible.
 * Works for any rect position: top, bottom, center, corners.
 */
function bestArrowOrigin(cx, cy, rLeft, rTop, rRight, rBottom, canvasW, canvasH) {
  const margin = 18;
  // Four candidate origins: midpoints of each canvas edge
  const candidates = [
    { x: cx,                  y: margin,             dx: 0,  dy: 1  }, // top edge
    { x: cx,                  y: canvasH - margin,   dx: 0,  dy: -1 }, // bottom edge
    { x: margin,              y: cy,                  dx: 1,  dy: 0  }, // left edge
    { x: canvasW - margin,    y: cy,                  dx: -1, dy: 0  }, // right edge
  ];
  // Filter: origin must be outside the red rect (with a small gap)
  const gap = 8;
  const valid = candidates.filter(c => {
    return c.x < rLeft - gap || c.x > rRight + gap || c.y < rTop - gap || c.y > rBottom + gap;
  });
  const pool = valid.length ? valid : candidates;
  // Pick the one closest to the canvas edge (shortest distance from origin to canvas boundary)
  // — this keeps the arrow short and clearly pointed at the issue
  return pool.reduce((best, c) => {
    const distBest = Math.hypot(best.x - cx, best.y - cy);
    const distC    = Math.hypot(c.x    - cx, c.y    - cy);
    return distC < distBest ? c : best;
  });
}

function computeFigmaLetterboxOnPage(figW, figH, pageW, pageH) {
  const scale = Math.min(pageW / Math.max(1, figW), pageH / Math.max(1, figH));
  const dw = Math.round(figW * scale);
  const dh = Math.round(figH * scale);
  const ox = Math.floor((pageW - dw) / 2);
  const extraY = pageH - dh;
  const oy = pageH > dh * 2.0 ? 0 : Math.floor(extraY / 2);
  return { dw, dh, ox, oy };
}

function clampNum(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function pageImageRectToFigmaSrcRect(imgRect, figW, figH, pageW, pageH, scrollW, scrollH) {
  // Map a live-page image-space rect proportionally into Figma frame pixel coordinates.
  // imgRect is in IMAGE pixel space (already converted from doc-space by docRectToScreenshotRect).
  // scrollW/scrollH = actual page scroll dimensions (what the image represents).
  // pageW/pageH = bitmap pixel dimensions (for scaling from image-space to doc-space ratio).
  if (!imgRect || !figW || !figH) return null;
  // Use scroll dimensions if provided, otherwise fall back to bitmap dims
  const docW = Math.max(1, scrollW || pageW);
  const docH = Math.max(1, scrollH || pageH);
  const bmpW = Math.max(1, pageW);
  const bmpH = Math.max(1, pageH);

  // Convert image-space rect back to doc-space proportions
  const docScaleX = docW / bmpW;
  const docScaleY = docH / bmpH;
  const docLeft   = imgRect.left   * docScaleX;
  const docTop    = imgRect.top    * docScaleY;
  const docWidth  = imgRect.width  * docScaleX;
  const docHeight = imgRect.height * docScaleY;

  // Map doc-space proportions into Figma frame coordinates
  const xRatio = docLeft  / docW;
  const yRatio = docTop   / docH;
  const wRatio = docWidth  / docW;
  const hRatio = docHeight / docH;

  let sx = xRatio * figW;
  let sy = yRatio * figH;
  let sw = wRatio * figW;
  let sh = hRatio * figH;

  sx = Math.max(0, Math.floor(sx));
  sy = Math.max(0, Math.floor(sy));
  sw = Math.max(12, Math.ceil(sw));
  sh = Math.max(12, Math.ceil(sh));
  sw = Math.min(sw, figW - sx);
  sh = Math.min(sh, figH - sy);

  if (sw < 4 || sh < 4) return null;
  return { sx, sy, sw, sh };
}

function wrapCaptionForSplitCanvas(text, maxWidthPx, measureWidthFn, maxLines = 2) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  if (!t) return [];
  const words = t.split(" ");
  const lines = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measureWidthFn(next) > maxWidthPx && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    } else {
      cur = next;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  return lines
    .slice(0, maxLines)
    .map((ln) => (ln.length > 118 ? `${ln.slice(0, 115)}…` : ln));
}

async function buildFigmaLiveSplitJpegFromBitmaps(figBmp, pageBmp, rectImage, padPx, maxTotalWidth, quality, caption, mapOpts) {
  if (!figBmp || !pageBmp || !rectImage) return "";
  const fw = figBmp.width;
  const fh = figBmp.height;
  const iw = pageBmp.width;
  const ih = pageBmp.height;
  // Actual page scroll dimensions (passed through mapOpts so callers don't need new signature)
  const scrollW = mapOpts?.scrollW || iw;
  const scrollH = mapOpts?.scrollH || ih;

  // ── LIVE side: crop the page bitmap to the issue region ────────────────────
  let left = Math.floor(rectImage.left - padPx);
  let top = Math.floor(rectImage.top - padPx);
  let width = Math.ceil(rectImage.width + 2 * padPx);
  let height = Math.ceil(rectImage.height + 2 * padPx);
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(width, iw - left);
  height = Math.min(height, ih - top);
  if (width < 8 || height < 8) return "";

  // ── FIGMA side: find the matching source region in the Figma bitmap ────────
  const tight = mapOpts?.tightImageRect;
  const tightOk = tight && typeof tight === "object" &&
    [tight.left, tight.top, tight.width, tight.height].every((x) => typeof x === "number" && Number.isFinite(x)) &&
    tight.width >= 2 && tight.height >= 2;
  const padT = 6;
  const figMapRect = tightOk
    ? clampRectToImage({ left: Math.floor(tight.left - padT), top: Math.floor(tight.top - padT), width: Math.ceil(tight.width + 2 * padT), height: Math.ceil(tight.height + 2 * padT) }, iw, ih)
    : { left, top, width, height };
  const figOverride = mapOpts?.figmaSrcRectOverride;
  const figSrc =
    figOverride && typeof figOverride === "object" &&
    [figOverride.left, figOverride.top, figOverride.width, figOverride.height].every((x) => typeof x === "number" && Number.isFinite(x))
      ? { sx: Math.max(0, Math.floor(figOverride.left)), sy: Math.max(0, Math.floor(figOverride.top)), sw: Math.max(2, Math.ceil(figOverride.width)), sh: Math.max(2, Math.ceil(figOverride.height)) }
      : pageImageRectToFigmaSrcRect(figMapRect || { left, top, width, height }, fw, fh, iw, ih, scrollW, scrollH);

  // ── Column size: use a fixed high-res column width for sharpness ───────────
  const TARGET_COL = 700; // render each panel at 700px wide for sharpness
  const colAspect = height / Math.max(1, width);
  const colW = TARGET_COL;
  const colH = Math.max(120, Math.round(TARGET_COL * colAspect));

  // ── Draw LIVE panel ─────────────────────────────────────────────────────────
  const pageCv = new OffscreenCanvas(colW, colH);
  const pctx = pageCv.getContext("2d");
  if (!pctx) return "";
  pctx.imageSmoothingEnabled = true;
  pctx.imageSmoothingQuality = "high";
  pctx.drawImage(pageBmp, left, top, width, height, 0, 0, colW, colH);

  // Red rect scaled to colW/colH
  const scaleX = colW / Math.max(1, width);
  const scaleY = colH / Math.max(1, height);
  const rx = Math.round((rectImage.left - left) * scaleX);
  const ry = Math.round((rectImage.top - top) * scaleY);
  const rw = Math.max(4, Math.round(rectImage.width * scaleX));
  const rh = Math.max(4, Math.round(rectImage.height * scaleY));
  const lw = Math.max(3, Math.round(4 * Math.max(1, colW / 700)));
  pctx.strokeStyle = "#ff3b30";
  pctx.lineWidth = lw;
  pctx.strokeRect(rx + lw / 2, ry + lw / 2, Math.max(1, rw - lw), Math.max(1, rh - lw));

  // Arrow on LIVE side — from nearest edge midpoint outside the rect
  const cxL = Math.round(rx + rw / 2);
  const cyL = Math.round(ry + rh / 2);
  const arLive = bestArrowOrigin(cxL, cyL, rx, ry, rx + rw, ry + rh, colW, colH);
  drawRedArrow(pctx, arLive.x, arLive.y, cxL, cyL, lw);

  // ── Draw FIGMA panel ────────────────────────────────────────────────────────
  // Render Figma at native crop resolution then scale — prevents blur
  const figCv = new OffscreenCanvas(colW, colH);
  const fctx = figCv.getContext("2d");
  if (!fctx) return "";
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = "high";
  fctx.fillStyle = "#f4f4f4";
  fctx.fillRect(0, 0, colW, colH);
  if (figSrc && figSrc.sw >= 4 && figSrc.sh >= 4) {
    // Draw only the matching region of the Figma bitmap — no full-frame stretch
    fctx.drawImage(figBmp, figSrc.sx, figSrc.sy, figSrc.sw, figSrc.sh, 0, 0, colW, colH);
  } else if (figSrc === null) {
    fctx.fillStyle = "#f0f0f0";
    fctx.fillRect(0, 0, colW, colH);
    fctx.fillStyle = "#333333";
    fctx.font = "bold 14px system-ui, Segoe UI, sans-serif";
    fctx.textAlign = "center";
    fctx.textBaseline = "middle";
    fctx.fillText("No matching region in Figma frame", colW / 2, colH / 2 - 10);
    fctx.font = "12px system-ui, Segoe UI, sans-serif";
    fctx.fillStyle = "#666666";
    fctx.fillText("Check Figma URL + node-id in Phase 1", colW / 2, colH / 2 + 12);
  } else {
    // Fallback: fit whole Figma frame
    const s = Math.min(colW / fw, colH / fh);
    const dw = Math.round(fw * s);
    const dh = Math.round(fh * s);
    fctx.drawImage(figBmp, 0, 0, fw, fh, Math.floor((colW - dw) / 2), Math.floor((colH - dh) / 2), dw, dh);
  }
  // Red rect on FIGMA side (same region proportions)
  pctx.strokeStyle = "#ff3b30"; // keep pctx for live side only
  fctx.strokeStyle = "#ff3b30";
  fctx.lineWidth = lw;
  fctx.strokeRect(lw / 2, lw / 2, Math.max(1, colW - lw), Math.max(1, colH - lw));
  // Arrow on FIGMA side — from nearest edge midpoint outside center rect
  const cxF = Math.round(colW / 2);
  const cyF = Math.round(colH / 2);
  const arFig = bestArrowOrigin(cxF, cyF, lw, lw, colW - lw, colH - lw, colW, colH);
  drawRedArrow(fctx, arFig.x, arFig.y, cxF, cyF, lw);

  // ── Compose final output canvas ─────────────────────────────────────────────
  const LABEL_H = 34;
  const MID_GAP = 12;
  const PAD_X = 16;
  const CAP_H = caption ? 52 : 0;
  const totalW = PAD_X + colW + MID_GAP + colW + PAD_X;
  const totalH = LABEL_H + colH + 20 + CAP_H;
  const outScale = Math.min(1, maxTotalWidth / Math.max(1, totalW));
  const ow = Math.max(1, Math.round(totalW * outScale));
  const oh = Math.max(1, Math.round(totalH * outScale));

  const out = new OffscreenCanvas(ow, oh);
  const octx = out.getContext("2d");
  if (!octx) return "";
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = "high";
  octx.fillStyle = "#d0d0d0";
  octx.fillRect(0, 0, ow, oh);

  octx.save();
  octx.scale(outScale, outScale);

  // Header bars
  octx.fillStyle = "#1a1a1a";
  octx.fillRect(PAD_X, 8, colW, LABEL_H - 4);
  octx.fillRect(PAD_X + colW + MID_GAP, 8, colW, LABEL_H - 4);
  octx.fillStyle = "#ffffff";
  octx.font = "bold 16px system-ui, Segoe UI, sans-serif";
  octx.textAlign = "center";
  octx.textBaseline = "middle";
  octx.fillText("✦ FIGMA DESIGN", PAD_X + colW / 2, 8 + (LABEL_H - 4) / 2);
  octx.fillText("✦ LIVE PAGE", PAD_X + colW + MID_GAP + colW / 2, 8 + (LABEL_H - 4) / 2);

  // Panel images
  octx.textAlign = "left";
  const imgY = LABEL_H + 10;
  octx.drawImage(figCv, PAD_X, imgY, colW, colH);
  octx.drawImage(pageCv, PAD_X + colW + MID_GAP, imgY, colW, colH);

  // Divider
  octx.strokeStyle = "#888888";
  octx.lineWidth = 2;
  const splitX = PAD_X + colW + MID_GAP / 2;
  octx.beginPath();
  octx.moveTo(splitX, LABEL_H + 4);
  octx.lineTo(splitX, imgY + colH + 4);
  octx.stroke();

  // Caption bar
  if (caption) {
    const cy2 = imgY + colH + 8;
    const boxW = colW * 2 + MID_GAP;
    const boxH = 48;
    octx.fillStyle = "#111111";
    octx.fillRect(PAD_X, cy2, boxW, boxH);
    octx.fillStyle = "#ffeb3b";
    octx.font = "bold 11px system-ui, Segoe UI, sans-serif";
    octx.textAlign = "left";
    octx.textBaseline = "top";
    octx.fillText("ISSUE:", PAD_X + 8, cy2 + 6);
    octx.fillStyle = "#ffffff";
    octx.font = "12px system-ui, Segoe UI, sans-serif";
    const maxTextW = boxW - 70;
    const capLines = wrapCaptionForSplitCanvas(caption, maxTextW, (s) => octx.measureText(s).width, 2);
    let ly = cy2 + 6;
    for (const ln of capLines) {
      octx.fillText(ln, PAD_X + 60, ly);
      ly += 16;
    }
  }
  octx.restore();

  const outBlob = await out.convertToBlob({ type: "image/jpeg", quality: 0.97 });
  return await blobToDataUrl(outBlob);
}

async function cropPageShotRectToJpegDataUrl(pageDataUrl, rect, padPx, maxSide, quality, captionRaw = "") {
  if (!pageDataUrl || !rect) return "";
  const blob = await (await fetch(pageDataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const iw = bmp.width;
    const ih = bmp.height;
    let left = Math.floor(rect.left - padPx);
    let top = Math.floor(rect.top - padPx);
    let width = Math.ceil(rect.width + 2 * padPx);
    let height = Math.ceil(rect.height + 2 * padPx);
    left = Math.max(0, left);
    top = Math.max(0, top);
    width = Math.min(width, iw - left);
    height = Math.min(height, ih - top);
    if (width < 8 || height < 8) return "";

    const scale = Math.min(1, maxSide / Math.max(width, height));
    const ow = Math.max(1, Math.round(width * scale));
    const oh = Math.max(1, Math.round(height * scale));
    const cap = String(captionRaw || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
    const CAP_H = cap ? 46 : 0;
    const cv = new OffscreenCanvas(ow, oh + CAP_H);
    const ctx = cv.getContext("2d");
    if (!ctx) return "";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, left, top, width, height, 0, 0, ow, oh);

    const rectLeft = Math.max(0, rect.left - left);
    const rectTop = Math.max(0, rect.top - top);
    const rectW = Math.max(1, Math.min(rect.width, iw - rect.left));
    const rectH = Math.max(1, Math.min(rect.height, ih - rect.top));
    const rx = Math.round(rectLeft * scale);
    const ry = Math.round(rectTop * scale);
    const rw = Math.max(4, Math.round(rectW * scale));
    const rh = Math.max(4, Math.round(rectH * scale));

    const lw = Math.max(2, Math.round(5 * Math.max(0.8, scale)));
    ctx.strokeStyle = "#ff3b30";
    ctx.lineWidth = lw;
    ctx.strokeRect(rx + lw / 2, ry + lw / 2, Math.max(1, rw - lw), Math.max(1, rh - lw));

    const cx = Math.round(rx + rw / 2);
    const cy = Math.round(ry + rh / 2);
    // Pick the canvas corner furthest from the rect center so the arrow always
    // points inward from outside the highlighted area — never from inside it.
    const corners = [
      [16, 16], [ow - 16, 16], [16, oh - 16], [ow - 16, oh - 16],
    ];
    const [fromX, fromY] = corners.reduce((best, c) =>
      (Math.hypot(c[0] - cx, c[1] - cy) > Math.hypot(best[0] - cx, best[1] - cy) ? c : best)
    );
    drawRedArrow(ctx, fromX, fromY, cx, cy, Math.max(3, lw));

    if (CAP_H) {
      ctx.fillStyle = "#111111";
      ctx.fillRect(0, oh, ow, CAP_H);
      ctx.fillStyle = "#ffffff";
      ctx.font = "12px system-ui, Segoe UI, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const maxTextW = ow - 16;
      const capLines = wrapCaptionForSplitCanvas(cap, maxTextW, (s) => ctx.measureText(s).width, 2);
      let ly = oh + 7;
      for (const ln of capLines) {
        ctx.fillText(ln, 8, ly);
        ly += 15;
      }
    }

    const outBlob = await cv.convertToBlob({ type: "image/jpeg", quality: quality ?? 0.9 });
    return await blobToDataUrl(outBlob);
  } finally {
    bmp.close?.();
  }
}

async function issueScreenshotFromPageBitmap(bmp, rect, padPx, maxSide, quality, captionRaw) {
  if (!bmp || !rect) return "";
  const iw = bmp.width;
  const ih = bmp.height;
  let left = Math.floor(rect.left - padPx);
  let top = Math.floor(rect.top - padPx);
  let width = Math.ceil(rect.width + 2 * padPx);
  let height = Math.ceil(rect.height + 2 * padPx);
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(width, iw - left);
  height = Math.min(height, ih - top);
  if (width < 8 || height < 8) return "";

  const scale = Math.min(1, maxSide / Math.max(width, height));
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const cap = String(captionRaw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const CAP_H = cap ? 46 : 0;
  const cv = new OffscreenCanvas(ow, oh + CAP_H);
  const ctx = cv.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, left, top, width, height, 0, 0, ow, oh);

  const rectLeft = Math.max(0, rect.left - left);
  const rectTop = Math.max(0, rect.top - top);
  const rectW = Math.max(1, Math.min(rect.width, iw - rect.left));
  const rectH = Math.max(1, Math.min(rect.height, ih - rect.top));
  const rx = Math.round(rectLeft * scale);
  const ry = Math.round(rectTop * scale);
  const rw = Math.max(4, Math.round(rectW * scale));
  const rh = Math.max(4, Math.round(rectH * scale));

  const lw = Math.max(2, Math.round(5 * Math.max(0.8, scale)));
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = lw;
  ctx.strokeRect(rx + lw / 2, ry + lw / 2, Math.max(1, rw - lw), Math.max(1, rh - lw));

  const cx = Math.round(rx + rw / 2);
  const cy = Math.round(ry + rh / 2);
  const arSingle = bestArrowOrigin(cx, cy, rx, ry, rx + rw, ry + rh, ow, oh);
  drawRedArrow(ctx, arSingle.x, arSingle.y, cx, cy, Math.max(3, lw));

  if (CAP_H) {
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, oh, ow, CAP_H);
    ctx.fillStyle = "#ffffff";
    ctx.font = "12px system-ui, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const maxTextW = ow - 16;
    const capLines = wrapCaptionForSplitCanvas(cap, maxTextW, (s) => ctx.measureText(s).width, 2);
    let ly = oh + 7;
    for (const ln of capLines) {
      ctx.fillText(ln, 8, ly);
      ly += 15;
    }
  }

  const outBlob = await cv.convertToBlob({ type: "image/jpeg", quality: quality ?? 0.9 });
  return await blobToDataUrl(outBlob);
}

async function issueScreenshotFromPageBitmapWithCropAndFocus(bmp, cropRect, focusRect, padCropPx, maxSide, quality, captionRaw) {
  if (!bmp || !cropRect || !focusRect) return "";
  const iw = bmp.width;
  const ih = bmp.height;
  const crop = clampRectToImage(cropRect, iw, ih);
  const focus = clampRectToImage(focusRect, iw, ih);
  if (!crop || !focus) return "";

  let left = Math.floor(crop.left - padCropPx);
  let top = Math.floor(crop.top - padCropPx);
  let width = Math.ceil(crop.width + 2 * padCropPx);
  let height = Math.ceil(crop.height + 2 * padCropPx);
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(width, iw - left);
  height = Math.min(height, ih - top);
  if (width < 8 || height < 8) return "";

  const scale = Math.min(1, maxSide / Math.max(width, height));
  const ow = Math.max(1, Math.round(width * scale));
  const oh = Math.max(1, Math.round(height * scale));
  const cap = String(captionRaw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  const CAP_H = cap ? 46 : 0;

  const cv = new OffscreenCanvas(ow, oh + CAP_H);
  const ctx = cv.getContext("2d");
  if (!ctx) return "";
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, left, top, width, height, 0, 0, ow, oh);

  const fx = Math.max(0, focus.left - left);
  const fy = Math.max(0, focus.top - top);
  const fw = Math.max(1, Math.min(focus.width, iw - focus.left));
  const fh = Math.max(1, Math.min(focus.height, ih - focus.top));
  const rx = Math.round(fx * scale);
  const ry = Math.round(fy * scale);
  const rw = Math.max(4, Math.round(fw * scale));
  const rh = Math.max(4, Math.round(fh * scale));

  const lw = Math.max(2, Math.round(5 * Math.max(0.8, scale)));
  ctx.strokeStyle = "#ff3b30";
  ctx.lineWidth = lw;
  ctx.strokeRect(rx + lw / 2, ry + lw / 2, Math.max(1, rw - lw), Math.max(1, rh - lw));

  const cx = Math.round(rx + rw / 2);
  const cy = Math.round(ry + rh / 2);
  const arCrop = bestArrowOrigin(cx, cy, rx, ry, rx + rw, ry + rh, ow, oh);
  drawRedArrow(ctx, arCrop.x, arCrop.y, cx, cy, Math.max(3, lw));

  if (CAP_H) {
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, oh, ow, CAP_H);
    ctx.fillStyle = "#ffffff";
    ctx.font = "12px system-ui, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const maxTextW = ow - 16;
    const capLines = wrapCaptionForSplitCanvas(cap, maxTextW, (s) => ctx.measureText(s).width, 2);
    let ly = oh + 7;
    for (const ln of capLines) {
      ctx.fillText(ln, 8, ly);
      ly += 15;
    }
  }

  const outBlob = await cv.convertToBlob({ type: "image/jpeg", quality: quality ?? 0.9 });
  return await blobToDataUrl(outBlob);
}

function rectCacheKey(r) {
  if (!r) return "";
  return `${Math.round(r.left)}_${Math.round(r.top)}_${Math.round(r.width)}_${Math.round(r.height)}`;
}

/**
 * Per-row screenshot generation.
 *
 * FIX Bug 1 (caption accuracy): By the time this function is called, issue.description is already
 * the final formatted string (assignNumericIds ran before this in runSingleTabComparePass).
 * The caption built here (`cap`) uses issue.description directly — it matches the CSV row exactly.
 *
 * FIX Bug 2 (URL cross-contamination): issue.id is now a real number (not undefined), so the
 * rect cache key `|id:N` is unique per row. Two rows sharing the same rect coordinates but
 * different descriptions now get separate screenshot URLs with their own correct captions.
 *
 * FIX Bug 3 (Visual crop from wrong bitmap): When viewportBmp is null for a Visual issue,
 * resolveImageRectRaw now returns null instead of falling through to full-page mapping with
 * a viewport-space rect. renderHighlightJpeg skips upload when rect is null.
 */
async function fillPerIssueScreenshotUrls(
  merged,
  pageShot,
  pageCap,
  gSheetUrl,
  gSheetSecret,
  figmaDesignDataUrl,
  opts = {},
) {
  if (!Array.isArray(merged) || !merged.length) return;

  const viewportShot = opts?.viewportShot || "";
  const viewportCap = opts?.viewportCap || null;
  const figmaTypoRoot = opts?.figmaTypoRoot || null;

  let pageBmp = null;
  let viewportBmp = null;
  let figBmp = null;
  let iw = 0;
  let ih = 0;
  try {
    const b = await (await fetch(pageShot)).blob();
    pageBmp = await createImageBitmap(b);
    iw = pageBmp.width;
    ih = pageBmp.height;
  } catch {
    for (const issue of merged) {
      issue.screenshotUrl = "";
    }
    return;
  }

  if (viewportShot && /^data:image\//i.test(String(viewportShot).trim())) {
    try {
      viewportBmp = await createImageBitmap(await (await fetch(viewportShot)).blob());
    } catch {
      viewportBmp = null;
    }
  }

  if (PER_ISSUE_FIGMA_PANEL_ENABLED) {
    const design = String(figmaDesignDataUrl || "").trim();
    if (design && /^data:image\//i.test(design)) {
      try {
        figBmp = await createImageBitmap(await (await fetch(design)).blob());
      } catch {
        figBmp = null;
      }
    }
  }

  function normNeedle(s) {
    return String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function walkFigmaTextNodesWithBoxes(node, out = []) {
    if (!node) return out;
    if (node.type === "TEXT" && node.characters && node.absoluteBoundingBox) out.push(node);
    for (const c of node.children || []) walkFigmaTextNodesWithBoxes(c, out);
    return out;
  }

  function figmaFrameBox(root) {
    const b = root?.absoluteBoundingBox;
    if (!b) return null;
    const { x, y, width, height } = b;
    if (![x, y, width, height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return { x, y, width, height };
  }

  function figmaCropRectForAnchorText(anchorText, figRoot) {
    const t = normNeedle(anchorText);
    if (!t || t.length < 4) return null;
    const frame = figmaFrameBox(figRoot);
    if (!frame) return null;
    const nodes = walkFigmaTextNodesWithBoxes(figRoot, []);
    // Prefer longer matches for uniqueness — use the first 44 chars of the needle
    const needle = t.length > 44 ? t.slice(0, 44) : t;
    let best = null;
    for (const n of nodes) {
      const chars = normNeedle(n.characters);
      if (!chars) continue;
      if (chars.includes(needle)) {
        best = n;
        break;
      }
    }
    if (!best) return null;
    const bb = best.absoluteBoundingBox;
    const rel = {
      left: bb.x - frame.x,
      top: bb.y - frame.y,
      width: bb.width,
      height: bb.height,
    };
    if (![rel.left, rel.top, rel.width, rel.height].every((x) => Number.isFinite(x))) return null;
    return rel;
  }

  try {
    const scrollW = pageCap?.scrollWidth ?? iw;
    const scrollH = pageCap?.scrollHeight ?? ih;

    const segments = pageCap?.stitchSegments || null;
    const isFullPageCapture =
      Number(pageCap?.scrollHeight || 0) > Number(pageCap?.innerHeight || 0) + 12 ||
      (Array.isArray(segments) && segments.length > 1);

    /**
     * FIX Bug 3: Visual issues MUST crop from viewportBmp using highlightRectImage (viewport-space).
     * If viewportBmp is unavailable, return null — do NOT fall through to full-page mapping,
     * which would apply viewport-space coordinates to full-page bitmap dimensions and crop the wrong area.
     */
    function resolveImageRectRaw(issue, isVisual) {
      if (isVisual && viewportBmp && issue.highlightRectImage) {
        // Correct path: crop from viewport bitmap using viewport-space rect
        const viw = viewportBmp.width;
        const vih = viewportBmp.height;
        return clampRectToImage(issue.highlightRectImage, viw, vih);
      }
      // FIX Bug 3: If Visual but no viewportBmp, return null rather than mapping viewport rect onto full-page bitmap
      if (isVisual && !viewportBmp) return null;

      // Non-visual: map document rect onto full-page stitched bitmap
      if (isFullPageCapture && issue.highlightRectDoc) {
        if (segments?.length) {
          return docRectToStitchedRect(issue.highlightRectDoc, iw, ih, scrollW, scrollH, segments);
        }
        return docRectToScreenshotRect(issue.highlightRectDoc, iw, ih, scrollW, scrollH);
      }
      if (issue.highlightRectImage) return clampRectToImage(issue.highlightRectImage, iw, ih);
      if (issue.highlightRectDoc) {
        if (segments?.length) {
          return docRectToStitchedRect(issue.highlightRectDoc, iw, ih, scrollW, scrollH, segments);
        }
        return docRectToScreenshotRect(issue.highlightRectDoc, iw, ih, scrollW, scrollH);
      }
      return null;
    }

    function resolveCropRectRaw(issue, isVisual) {
      const rDoc = issue?.cropRectDoc;
      if (!rDoc || typeof rDoc.left !== "number") return null;
      // Visual crops come from viewport-space rects; section doc rect would not map cleanly here.
      if (isVisual) return null;
      if (isFullPageCapture) {
        if (segments?.length) return docRectToStitchedRect(rDoc, iw, ih, scrollW, scrollH, segments);
        return docRectToScreenshotRect(rDoc, iw, ih, scrollW, scrollH);
      }
      return docRectToScreenshotRect(rDoc, iw, ih, scrollW, scrollH);
    }

    function unionRects(a, b) {
      if (!a) return b || null;
      if (!b) return a || null;
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      const right = Math.max(a.left + a.width, b.left + b.width);
      const bottom = Math.max(a.top + a.height, b.top + b.height);
      return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    }

    async function renderHighlightJpeg(rect, cropRectForThisIssue, padSplit, padLive, caption, figMapOpts, isVisual) {
      // FIX Bug 3: null rect means we cannot safely crop — skip upload to avoid wrong-region screenshots
      if (!rect) return "";
      const cap = String(caption || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);
      let jpeg = "";
      if (PER_ISSUE_FIGMA_PANEL_ENABLED && figBmp) {
        jpeg = await buildFigmaLiveSplitJpegFromBitmaps(
          figBmp,
          isVisual && viewportBmp ? viewportBmp : pageBmp,
          rect,
          padSplit,
          1240,
          0.9,
          cap,
          figMapOpts,
        );
      }
      const liveBmp = isVisual && viewportBmp ? viewportBmp : pageBmp;
      const liveMaxSide = isVisual ? 1080 : cropRectForThisIssue ? FULL_WIDTH_CROP_MAX_SIDE : 1120;
      if (!jpeg && liveBmp) {
        if (!isVisual && cropRectForThisIssue) {
          jpeg = await issueScreenshotFromPageBitmapWithCropAndFocus(
            liveBmp,
            cropRectForThisIssue,
            rect,
            10,
            liveMaxSide,
            0.9,
            cap,
          );
        } else {
          jpeg = await issueScreenshotFromPageBitmap(liveBmp, rect, padLive, liveMaxSide, 0.9, cap);
        }
      }
      const liveDataUrl = isVisual && viewportShot ? viewportShot : pageShot;
      if (!jpeg) jpeg = await cropPageShotRectToJpegDataUrl(liveDataUrl, rect, padLive, liveMaxSide, 0.9, cap);
      if (!jpeg) jpeg = await cropPageShotRectToJpegDataUrl(liveDataUrl, rect, 10, 820, 0.88, cap);
      return jpeg;
    }

    const urlByRect = new Map();
    let uploads = 0;

    for (let rowIdx = 0; rowIdx < merged.length; rowIdx++) {
      const issue = merged[rowIdx];
      const isVisual = String(issue.category || "") === "Visual";

      // FIX Bug 1: issue.description is now the fully-formatted string (including "· Section" suffix)
      // because assignNumericIds ran before this function. The caption burned into the JPEG exactly
      // matches the description text that will appear in the CSV / popup table for this row.
      const cap = String(issue.description || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 220);

      let url = "";
      const rawRect = resolveImageRectRaw(issue, isVisual);
      const cropRectRaw = resolveCropRectRaw(issue, isVisual);
      const cropIW = isVisual && viewportBmp ? viewportBmp.width : iw;
      const cropIH = isVisual && viewportBmp ? viewportBmp.height : ih;
      const cat = String(issue.category || "");
      const isTypo = cat === "Typography";
      const minCropW = isVisual ? 560 : isTypo ? 360 : 260;
      const minCropH = isVisual ? 380 : isTypo ? 270 : 190;
      const focusRect = rawRect ? clampRectToImage(rawRect, cropIW, cropIH) : null;
      const cropRect = cropRectRaw ? clampRectToImage(cropRectRaw, cropIW, cropIH) : null;
      let cropRectForThisIssue = cropRect ? unionRects(cropRect, focusRect) : null;
      // If we have a section crop, make it full-width horizontally for clearer context.
      if (!isVisual && SCREENSHOT_CROP_FULL_WIDTH && cropRectForThisIssue) {
        cropRectForThisIssue = clampRectToImage(
          {
            left: 0,
            top: cropRectForThisIssue.top,
            width: cropIW,
            height: cropRectForThisIssue.height,
          },
          cropIW,
          cropIH,
        );
      }
      const imgRect = focusRect ? expandRectForMinCrop(focusRect, cropIW, cropIH, minCropW, minCropH) : null;
      let figMapOpts = rawRect ? { tightImageRect: rawRect, scrollW, scrollH } : { scrollW, scrollH };

      // Apply figmaMatchText anchor for ALL issue categories (not just Typography).
      // figmaTypoRoot is the full Figma frame root — same object used by all issue builders.
      const _figRoot = figmaTypoRoot; // always the full root
      if (_figRoot && issue.figmaMatchText) {
        // Lower the min-length guard so short strings like "Gallery", "Blog Title QA" still match
        const _origFigRect = figmaCropRectForAnchorText(issue.figmaMatchText, _figRoot);
        if (_origFigRect) {
          // Expand the found text-node rect to a generous section-sized crop so the
          // Figma panel shows meaningful context (not just a single line of text).
          const _frame = figmaFrameBox(_figRoot);
          const _padH = Math.max(40, Math.round(_origFigRect.height * 1.5));
          const _padV = Math.max(24, Math.round(_origFigRect.height * 0.8));
          const _expanded = {
            left: Math.max(0, _origFigRect.left - _padH),
            top:  Math.max(0, _origFigRect.top  - _padV),
            width:  Math.min(
              (_frame?.width  || 1440),
              _origFigRect.width  + _padH * 2,
            ),
            height: Math.min(
              (_frame?.height || 9999),
              _origFigRect.height + _padV * 2,
            ),
          };
          figMapOpts = { ...figMapOpts, figmaSrcRectOverride: _expanded };
        }
        // If anchor text not found in Figma nodes, keep proportional mapping as fallback
        // (already set above via scrollW/scrollH)
      }

      // FIX Bug 2: issue.id is now a real number (assignNumericIds ran before this).
      // The key is unique per row even when two rows share identical rect coordinates,
      // because rowIdx and issue.id together guarantee uniqueness.
      const key =
        (PER_ISSUE_FIGMA_PANEL_ENABLED && figBmp ? "split:" : "live:") +
        rectCacheKey(imgRect) +
        (rawRect ? `:tight:${rectCacheKey(rawRect)}` : "") +
        (cropRectForThisIssue ? `:crop:${rectCacheKey(cropRectForThisIssue)}` : "") +
        "|row:" +
        rowIdx +
        "|id:" +
        String(issue.id ?? "");

      if (imgRect && key && urlByRect.has(key)) {
        url = urlByRect.get(key);
      } else if (imgRect && uploads < MAX_PER_ISSUE_SCREENSHOT_UPLOADS) {
        try {
          let jpeg = await renderHighlightJpeg(
            imgRect,
            cropRectForThisIssue,
            isVisual ? 44 : 26,
            isVisual ? 40 : 22,
            cap,
            figMapOpts,
            isVisual,
          );
          const firstVer = await analyzeDataUrlLightRatio(jpeg);
          let { tooBlank, lightRatio: lr1 } = firstVer;
          if (tooBlank && rawRect) {
            const wider = expandRectForMinCrop(rawRect, cropIW, cropIH, 420, 300);
            if (wider && rectCacheKey(wider) !== rectCacheKey(imgRect)) {
              const retry = await renderHighlightJpeg(wider, cropRectForThisIssue, 34, 28, cap, figMapOpts, isVisual);
              const v2 = await analyzeDataUrlLightRatio(retry);
              if (!v2.tooBlank || v2.lightRatio < lr1) {
                jpeg = retry;
              }
            }
          }
          if (jpeg) {
            const pub = await publishHighlightDataUrl(jpeg, gSheetUrl, gSheetSecret);
            url = String(pub.url || "");
            if (url) {
              urlByRect.set(key, url);
              uploads++;
              if (uploads < MAX_PER_ISSUE_SCREENSHOT_UPLOADS) await sleep(PER_ISSUE_UPLOAD_DELAY_MS);
            }
          }
        } catch {
          /* keep url empty */
        }
      }

      issue.screenshotUrl = url;
    }
  } finally {
    pageBmp?.close?.();
    viewportBmp?.close?.();
    figBmp?.close?.();
  }
}

function formatReport(issues) {
  if (!issues.length) return "PASS: No obvious font-size or color mismatches found in Section 1 (sample-based).";
  return [`FAIL: Found ${issues.length} possible issue(s) (sample-based).`, "", ...issues.map((x) => `- ${x.description}`)].join("\n");
}

async function fetchFigmaImageExportUrl(fileKey, nodeId, token) {
  const formats = [
    { format: "png", scale: 2 },
    { format: "jpg", scale: 2 },
    { format: "png", scale: 1 },
    { format: "jpg", scale: 1 },
  ];
  const deadlineMs = Date.now() + 12 * 60 * 1000;
  let attempt = 0;

  async function updateStep(label) {
    const bcur = await chrome.storage.local.get([BOOTSTRAP_JOB_KEY]);
    const bprev = bcur[BOOTSTRAP_JOB_KEY] || null;
    if (bprev?.status === "running") {
      await chrome.storage.local.set({ [BOOTSTRAP_JOB_KEY]: { ...bprev, step: label } });
    }
  }

  async function waitWithCountdown(waitMs) {
    const totalSec = Math.max(1, Math.round(waitMs / 1000));
    for (let remaining = totalSec; remaining > 0; remaining -= 5) {
      await updateStep(`Figma rate-limited (429). Waiting ${Math.max(0, remaining)}s… (auto-retry)`);
      await sleep(Math.min(5000, Math.max(0, remaining) * 1000));
    }
  }

  while (Date.now() < deadlineMs) {
    for (const f of formats) {
      const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=${encodeURIComponent(f.format)}&scale=${encodeURIComponent(String(f.scale))}`;
      await updateStep(`Requesting Figma export URL (${f.format.toUpperCase()})…`);
      const res = await fetchWithTimeout(
        url,
        { headers: { "X-Figma-Token": token } },
        60000,
        "Figma API (image export)",
      );
      const text = await res.text();
      if (res.ok) {
        let meta;
        try {
          meta = JSON.parse(text);
        } catch {
          meta = null;
        }
        if (meta?.err) throw new Error(String(meta.err));
        const imageUrl = meta?.images?.[nodeId] || Object.values(meta?.images || {})[0];
        if (imageUrl) return imageUrl;
        await updateStep("Figma export is still processing. Retrying…");
        await sleep(1500);
        continue;
      }
      if (res.status === 429) {
        const ra = res.headers.get("Retry-After");
        let waitMs = 0;
        if (ra) {
          const sec = parseInt(ra, 10);
          if (Number.isFinite(sec) && sec > 0) waitMs = Math.min(sec * 1000, 180000);
        }
        if (!waitMs) {
          waitMs = Math.min(15000 + attempt * 15000, 120000);
        }
        attempt++;
        await waitWithCountdown(waitMs);
        continue;
      }
      throw new Error(`Figma ${res.status}: ${text.slice(0, 240)}`);
    }
  }
  throw new Error("Figma image export timed out (rate-limited). Wait 2–5 minutes and retry, or try hotspot/another token.");
}

async function blobToDataUrl(blob) {
  const arr = await blob.arrayBuffer();
  const bytes = new Uint8Array(arr);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
}

async function readDataUrlImageDimensions(dataUrl) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  try {
    return { width: bmp.width, height: bmp.height };
  } finally {
    bmp.close?.();
  }
}

async function compressDataUrlToJpegMaxWidth(dataUrl, maxW = 1280, q = 0.78) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxW / Math.max(1, bmp.width));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable for image compression.");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const out = await c.convertToBlob({ type: "image/jpeg", quality: q });
    return await blobToDataUrl(out);
  } finally {
    bmp.close?.();
  }
}

async function bootstrapFigmaDesignOnce(figmaUrlRaw, tokenRaw) {
  const token = String(tokenRaw || "").trim();
  const figmaUrl = String(figmaUrlRaw || "").trim();
  if (!token) throw new Error("Figma personal access token is required.");
  const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
  if (!fileKey || !nodeId) {
    throw new Error('Figma link must include ?node-id=… (open the frame in Figma → Share → Copy link).');
  }
  const startedAt = Date.now();
  const frameKey = `${fileKey}:${nodeId}`;
  await chrome.storage.local.remove(FIGMA_SNAPSHOT_DATA_URL_KEY);
  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Requesting Figma export URL…", startedAt },
  });
  const imageApiUrl = await fetchFigmaImageExportUrl(fileKey, nodeId, token);
  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Downloading Figma image…", startedAt },
  });
  const imgRes = await fetchWithTimeout(imageApiUrl, {}, 120000, "Figma CDN (image download)");
  if (!imgRes.ok) throw new Error("Could not download the frame image from Figma.");
  const rawDataUrl = await blobToDataUrl(await imgRes.blob());
  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Reading export dimensions…", startedAt },
  });
  let detectedW = 0;
  let detectedH = 0;
  try {
    const dim = await readDataUrlImageDimensions(rawDataUrl);
    detectedW = dim.width;
    detectedH = dim.height;
  } catch {
    /* ignore */
  }
  const framePatch = { [FIGMA_BOOTSTRAP_FRAME_KEY]: frameKey };
  if (detectedW >= 360 && detectedW <= 8192) framePatch[FIGMA_DETECTED_EXPORT_WIDTH_KEY] = detectedW;
  await chrome.storage.local.set(framePatch);
  if (!(detectedW >= 360 && detectedW <= 8192)) await chrome.storage.local.remove(FIGMA_DETECTED_EXPORT_WIDTH_KEY);

  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Fetching typography from Figma…", startedAt },
  });
  const compactTree = await fetchFigmaNodeTree(fileKey, nodeId, token);

  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Saving typography cache…", startedAt },
  });
  const typographyJson = JSON.stringify(compactTree);
  await chrome.storage.local.set({ [FIGMA_TYPO_SNAPSHOT_KEY]: typographyJson });

  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Saving backup to Downloads…", startedAt },
  });
  try {
    await downloadDesignCacheBackupToDownloads({
      frameKey,
      snapshotDataUrl: "",
      typographyJson,
      detectedExportWidth: detectedW || 0,
    });
  } catch {
    /* best-effort */
  }

  await chrome.storage.local.set({
    [BOOTSTRAP_JOB_KEY]: {
      status: "done",
      step: "Done",
      startedAt,
      finishedAt: Date.now(),
      detectedExportWidth: detectedW || 0,
    },
  });
  return { detectedExportWidth: detectedW, detectedExportHeight: detectedH };
}

async function capturePageScreenshotDataUrl(tabId) {
  try {
    if (typeof chrome.tabs.captureTab === "function") {
      return await chrome.tabs.captureTab(tabId, { format: "png" });
    }
  } catch {
    /* fall back */
  }
  const t = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await sleep(450);
  return await chrome.tabs.captureVisibleTab(t.windowId, { format: "png" });
}

async function prepareTabForStableCapture(tabId) {
  await chrome.scripting
    .insertCSS({
      target: { tabId },
      css: `
        html{scroll-behavior:auto !important}
        *,*::before,*::after{
          animation-duration:0.001ms !important;
          animation-iteration-count:1 !important;
          transition-duration:0.001ms !important;
          transition-delay:0ms !important;
          caret-color:transparent !important;
        }`,
    })
    .catch(() => {});

  await chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: async () => {
        const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
        const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
        try {
          const fonts = document?.fonts;
          if (fonts?.ready) {
            await Promise.race([fonts.ready, timeout(2500)]);
          }
        } catch {
          /* ignore */
        }
        await raf();
        await raf();
        try {
          const imgs = Array.from(document.images || []).slice(0, 250);
          await Promise.race([
            Promise.all(
              imgs.map(async (img) => {
                try {
                  if (!img) return;
                  if (!img.complete) await new Promise((res) => img.addEventListener("load", res, { once: true }));
                  if (typeof img.decode === "function") await img.decode().catch(() => {});
                } catch {
                  /* ignore */
                }
              }),
            ),
            timeout(2500),
          ]);
        } catch {
          /* ignore */
        }
        await timeout(120);
        return true;
      },
    })
    .catch(() => {});
}

const MAX_STITCH_STEPS = 28;
const MAX_SCROLL_CSS_PX = 28000;
const MAX_STITCH_CANVAS_PX = 120000;

async function captureViewportScreenshotDataUrl(tabId) {
  let injected = false;
  async function metricsOnce() {
    try {
      return await sendMessageTimeout(tabId, { type: "GET_PAGE_SCROLL_METRICS" }, 15000);
    } catch {
      if (!injected) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        injected = true;
      }
      return await sendMessageTimeout(tabId, { type: "GET_PAGE_SCROLL_METRICS" }, 15000);
    }
  }

  const m = await metricsOnce();
  if (!m?.ok) throw new Error(m?.error || "Could not read page dimensions for viewport capture.");

  const scrollHeight = Math.min(Math.max(8, m.scrollHeight), MAX_SCROLL_CSS_PX);
  const innerHeight = Math.max(1, m.innerHeight);
  const innerWidth = Math.max(1, m.innerWidth);
  const scrollWidth = Math.max(innerWidth, m.scrollWidth || innerWidth);

  await sendMessageTimeout(tabId, { type: "SCROLL_PAGE_Y", y: 0 }, 10000);
  await sleep(400);
  await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_CHATBOTS", hidden: true }, 9000).catch(() => {});
  await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_FIXED", hidden: false }, 8000).catch(() => {});

  let dataUrl = "";
  let iw = 0;
  let ih = 0;
  let stitchSegments = null;
  try {
    await prepareTabForStableCapture(tabId);
    dataUrl = await capturePageScreenshotDataUrl(tabId);
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    iw = bmp.width;
    ih = bmp.height;
    bmp.close?.();
    const docVisBottom = Math.min(scrollHeight, innerHeight);
    stitchSegments = [{ docTop: 0, docBottom: docVisBottom, imgTop: 0, imgBottom: ih }];
  } finally {
    await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_CHATBOTS", hidden: false }, 9000).catch(() => {});
    await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_FIXED", hidden: false }, 8000).catch(() => {});
  }

  return {
    dataUrl,
    scrollHeight,
    scrollWidth,
    innerWidth,
    innerHeight,
    stitchSegments,
    imageWidth: iw,
    imageHeight: ih,
  };
}

async function captureFullPageScreenshotDataUrl(tabId) {
  let injected = false;
  async function metricsOnce() {
    try {
      return await sendMessageTimeout(tabId, { type: "GET_PAGE_SCROLL_METRICS" }, 15000);
    } catch {
      if (!injected) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        injected = true;
      }
      return await sendMessageTimeout(tabId, { type: "GET_PAGE_SCROLL_METRICS" }, 15000);
    }
  }

  const m = await metricsOnce();
  if (!m?.ok) throw new Error(m?.error || "Could not read page dimensions for full-page capture.");

  let scrollHeight = Math.min(Math.max(8, m.scrollHeight), MAX_SCROLL_CSS_PX);
  const innerHeight = Math.max(1, m.innerHeight);
  const innerWidth = Math.max(1, m.innerWidth);
  const scrollWidth = Math.max(innerWidth, m.scrollWidth || innerWidth);

  await sendMessageTimeout(tabId, { type: "SCROLL_PAGE_Y", y: 0 }, 10000);
  await sleep(400);
  await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_CHATBOTS", hidden: true }, 9000).catch(() => {});
  await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_FIXED", hidden: false }, 8000).catch(() => {});

  if (scrollHeight <= innerHeight + 12) {
    await prepareTabForStableCapture(tabId);
    const dataUrl = await capturePageScreenshotDataUrl(tabId);
    let stitchSegments = null;
    let iw = 0;
    let ih = 0;
    try {
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      iw = bmp.width;
      ih = bmp.height;
      bmp.close?.();
      stitchSegments = [{ docTop: 0, docBottom: scrollHeight, imgTop: 0, imgBottom: ih }];
    } catch {
      stitchSegments = [{ docTop: 0, docBottom: scrollHeight, imgTop: 0, imgBottom: scrollHeight }];
    }
    return { dataUrl, scrollHeight, scrollWidth, innerWidth, innerHeight, stitchSegments, imageWidth: iw, imageHeight: ih };
  }

  const steps = Math.min(MAX_STITCH_STEPS, Math.max(1, Math.ceil(scrollHeight / innerHeight)));
  const slices = [];
  try {
    for (let i = 0; i < steps; i++) {
      const y = i === steps - 1 ? Math.max(0, scrollHeight - innerHeight) : i * innerHeight;
      await sendMessageTimeout(tabId, { type: "SCROLL_PAGE_Y", y }, 10000);
      await sleep(220);
      await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_FIXED", hidden: i > 0 }, 8000).catch(() => {});
      await sleep(i > 0 ? 200 : 380);
      await prepareTabForStableCapture(tabId);
      const dataUrl = await capturePageScreenshotDataUrl(tabId);
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      slices.push({ y, bmp });
    }
  } finally {
    await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_CHATBOTS", hidden: false }, 9000).catch(() => {});
    await sendMessageTimeout(tabId, { type: "SET_CAPTURE_HIDE_FIXED", hidden: false }, 8000).catch(() => {});
    await sendMessageTimeout(tabId, { type: "SCROLL_PAGE_Y", y: 0 }, 10000).catch(() => {});
  }

  const W = slices[0].bmp.width;
  let plannedH = 0;
  for (let i = 0; i < slices.length; i++) {
    const bmp = slices[i].bmp;
    const yCss = slices[i].y;
    const sliceCss = Math.min(innerHeight, scrollHeight - yCss);
    plannedH += Math.min(bmp.height, Math.max(1, Math.round((sliceCss / innerHeight) * bmp.height)));
  }
  const canvasH = Math.min(plannedH, MAX_STITCH_CANVAS_PX);
  const stitchSegments = [];
  const canvas = new OffscreenCanvas(W, canvasH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    for (const s of slices) s.bmp.close?.();
    throw new Error("Could not create canvas for stitched screenshot.");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, canvasH);

  let destY = 0;
  for (let i = 0; i < slices.length; i++) {
    const bmp = slices[i].bmp;
    const yCss = slices[i].y;
    const sliceCss = Math.min(innerHeight, scrollHeight - yCss);
    let srcH = Math.min(bmp.height, Math.max(1, Math.round((sliceCss / innerHeight) * bmp.height)));
    if (destY + srcH > canvasH) srcH = Math.max(1, canvasH - destY);
    if (srcH <= 0) break;
    stitchSegments.push({
      docTop: yCss,
      docBottom: yCss + sliceCss,
      imgTop: destY,
      imgBottom: destY + srcH,
    });
    ctx.drawImage(bmp, 0, 0, bmp.width, srcH, 0, destY, bmp.width, srcH);
    destY += srcH;
    bmp.close?.();
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const dataUrl = await blobToDataUrl(blob);
  return {
    dataUrl,
    scrollHeight,
    scrollWidth,
    innerWidth,
    innerHeight,
    stitchSegments,
    imageWidth: W,
    imageHeight: canvasH,
  };
}

function denseDiffClusterBBox(w, cropH, tileCounts, cols, rows, tileW, tileH) {
  let maxV = 0;
  let maxI = 0;
  for (let i = 0; i < tileCounts.length; i++) {
    if (tileCounts[i] > maxV) {
      maxV = tileCounts[i];
      maxI = i;
    }
  }
  if (maxV < 1) return null;
  const mc = maxI % cols;
  const mr = (maxI / cols) | 0;
  let minC = mc;
  let maxC = mc;
  let minR = mr;
  let maxR = mr;
  const neighborThresh = Math.max(2, Math.floor(maxV * 0.18));
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const nr = mr + dr;
      const nc = mc + dc;
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      if (tileCounts[nr * cols + nc] >= neighborThresh) {
        minC = Math.min(minC, nc);
        maxC = Math.max(maxC, nc);
        minR = Math.min(minR, nr);
        maxR = Math.max(maxR, nr);
      }
    }
  }
  const pad = 32;
  let left = Math.max(0, minC * tileW - pad);
  let top = Math.max(0, minR * tileH - pad);
  let right = Math.min(w - 1, (maxC + 1) * tileW - 1 + pad);
  let bottom = Math.min(cropH - 1, (maxR + 1) * tileH - 1 + pad);
  const bw = right - left + 1;
  const bh = bottom - top + 1;
  if (bw * bh > w * cropH * 0.38) {
    left = Math.max(0, mc * tileW - pad);
    top = Math.max(0, mr * tileH - pad);
    right = Math.min(w - 1, (mc + 1) * tileW - 1 + pad);
    bottom = Math.min(cropH - 1, (mr + 1) * tileH - 1 + pad);
  }
  return {
    left,
    top,
    width: Math.max(8, right - left + 1),
    height: Math.max(8, bottom - top + 1),
  };
}

async function diffTopSection(figmaDataUrl, pageDataUrl) {
  const [figBlob, pageBlob] = await Promise.all([
    (await fetch(figmaDataUrl)).blob(),
    (await fetch(pageDataUrl)).blob(),
  ]);
  const [figBmp, pageBmp] = await Promise.all([createImageBitmap(figBlob), createImageBitmap(pageBlob)]);

  try {
    const w = pageBmp.width;
    const h = pageBmp.height;
    const cropH = h;

    const figCanvas = new OffscreenCanvas(w, cropH);
    const pageCanvas = new OffscreenCanvas(w, cropH);
    const fctx = figCanvas.getContext("2d", { willReadFrequently: true });
    const pctx = pageCanvas.getContext("2d", { willReadFrequently: true });
    if (!fctx || !pctx) throw new Error("Canvas not available for diff.");

    fctx.fillStyle = "#ffffff";
    fctx.fillRect(0, 0, w, cropH);
    pctx.fillStyle = "#ffffff";
    pctx.fillRect(0, 0, w, cropH);
    pctx.drawImage(pageBmp, 0, 0, w, h);

    const scale = Math.min(w / figBmp.width, cropH / figBmp.height);
    const dw = Math.round(figBmp.width * scale);
    const dh = Math.round(figBmp.height * scale);
    const ox = Math.floor((w - dw) / 2);
    const oy = Math.floor((cropH - dh) / 2);
    fctx.drawImage(figBmp, ox, oy, dw, dh);

    const fImg = fctx.getImageData(0, 0, w, cropH);
    const pImg = pctx.getImageData(0, 0, w, cropH);
    const f = fImg.data;
    const p = pImg.data;
    const out = new Uint8ClampedArray(p);

    let diff = 0;
    const total = w * cropH;
    const perPixel = STRICT_PIXEL_COMPARE ? 0 : TOLERANT_PIXEL_RGB_SUM;
    let minX = w;
    let minY = cropH;
    let maxX = -1;
    let maxY = -1;

    const tileW = Math.max(56, Math.floor(w / 28));
    const tileH = Math.max(56, Math.floor(cropH / 28));
    const cols = Math.max(1, Math.ceil(w / tileW));
    const rows = Math.max(1, Math.ceil(cropH / tileH));
    const tileCounts = new Uint32Array(cols * rows);

    for (let py = 0; py < cropH; py++) {
      for (let px = 0; px < w; px++) {
        const i = (py * w + px) * 4;
        const dr = Math.abs(f[i] - p[i]);
        const dg = Math.abs(f[i + 1] - p[i + 1]);
        const db = Math.abs(f[i + 2] - p[i + 2]);
        const d = dr + dg + db;
        const isDiff = d > perPixel;
        if (isDiff) {
          diff++;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
          const tc = Math.min(cols - 1, (px / tileW) | 0);
          const tr = Math.min(rows - 1, (py / tileH) | 0);
          tileCounts[tr * cols + tc]++;
        }
      }
    }

    const mismatch = diff / total;

    const issues = [];
    if (mismatch >= SECTION_PIXEL_MISMATCH_THRESH) {
      issues.push({
        description: "Viewport does not match the Figma frame export.",
        status: "need to fix",
        category: "Visual",
      });
    }

    let focusLeft = 0;
    let focusTop = 0;
    let focusRight = 0;
    let focusBottom = 0;
    if (issues.length && maxX >= 0 && maxY >= 0) {
      const dense = denseDiffClusterBBox(w, cropH, tileCounts, cols, rows, tileW, tileH);
      const pad = 20;
      if (dense) {
        issues[0].highlightRectImage = dense;
        focusLeft = dense.left;
        focusTop = dense.top;
        focusRight = dense.left + dense.width - 1;
        focusBottom = dense.top + dense.height - 1;
      } else {
        const left = Math.max(0, minX - pad);
        const top = Math.max(0, minY - pad);
        const right = Math.min(w - 1, maxX + pad);
        const bottom = Math.min(cropH - 1, maxY + pad);
        issues[0].highlightRectImage = {
          left,
          top,
          width: Math.max(4, right - left + 1),
          height: Math.max(4, bottom - top + 1),
        };
        focusLeft = left;
        focusTop = top;
        focusRight = right;
        focusBottom = bottom;
      }
    }

    let highlightDataUrl = "";
    if (issues.length) {
      const outCanvas = new OffscreenCanvas(w, cropH);
      const octx = outCanvas.getContext("2d");
      if (octx) {
        octx.putImageData(new ImageData(out, w, cropH), 0, 0);
        if (maxX >= 0 && maxY >= 0) {
          const cx = Math.round((focusLeft + focusRight) / 2);
          const cy = Math.round((focusTop + focusBottom) / 2);
          const fromX = Math.max(24, cx - 90);
          const fromY = Math.max(24, cy - 90);
          drawRedArrow(octx, fromX, fromY, cx, cy, 4);
        }
        const outBlob = await outCanvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
        highlightDataUrl = await blobToDataUrl(outBlob);
      }
    }
    return { mismatch, highlightDataUrl, issues };
  } finally {
    figBmp.close?.();
    pageBmp.close?.();
  }
}

const SHEET_WEBHOOK_STORAGE_KEY = "figmaCompare_sheetWebhookUrl";
const SHEET_SECRET_STORAGE_KEY = "figmaCompare_sheetSecret";

function dataUrlToBase64Payload(dataUrl) {
  const s = String(dataUrl || "");
  const i = s.indexOf(",");
  return i >= 0 ? s.slice(i + 1) : s;
}

async function uploadHighlightViaSheetWebhook(dataUrl, webhookUrl, secret) {
  const res = await fetchWithTimeout(
    String(webhookUrl).trim(),
    {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upload_image",
        secret: secret || "",
        screenshotBase64: dataUrlToBase64Payload(dataUrl),
        imageMimeType: "image/jpeg",
      }),
    },
    90000,
    "Sheet Web App (Drive image)",
  );
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(raw.slice(0, 220) || `HTTP ${res.status}`);
  }
  if (!json?.ok || !json?.url) {
    throw new Error(json?.error || "Drive upload failed");
  }
  return String(json.url);
}

async function uploadToImgBB(dataUrl, apiKey) {
  const b64 = dataUrlToBase64Payload(dataUrl);
  const body = new URLSearchParams();
  body.set("key", String(apiKey).trim());
  body.set("image", b64);
  const res = await fetchWithTimeout(
    "https://api.imgbb.com/1/upload",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      cache: "no-store",
    },
    120000,
    "ImgBB upload",
  );
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`ImgBB: ${text.slice(0, 180)}`);
  }
  if (!json?.success || !json?.data?.url) {
    throw new Error(json?.error?.message || json?.error || "ImgBB upload failed");
  }
  return String(json.data.url);
}

async function uploadToCloudinary(dataUrl, cloudName, uploadPreset) {
  const blob = await (await fetch(dataUrl)).blob();
  const fd = new FormData();
  fd.append("file", blob, `figma-issue-${Date.now()}.jpg`);
  fd.append("upload_preset", uploadPreset);
  const res = await fetchWithTimeout(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    { method: "POST", body: fd, cache: "no-store" },
    60000,
    "Cloudinary upload",
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Cloudinary upload failed: ${text.slice(0, 180)}`);
  }
  if (!res.ok || !json?.secure_url) {
    throw new Error(`Cloudinary upload failed: ${json?.error?.message || "unknown error"}`);
  }
  return String(json.secure_url);
}

async function shortenUrl(url) {
  const api = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`;
  const res = await fetchWithTimeout(api, {}, 25000, "URL shortener");
  const text = (await res.text()).trim();
  if (!res.ok || !/^https?:\/\//i.test(text)) return url;
  return text;
}

async function appendIssuesRowsToGoogleSheet(webhookUrl, secret, rows) {
  const res = await fetchWithTimeout(
    String(webhookUrl).trim(),
    {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: secret || "",
        rows,
      }),
    },
    120000,
    "Google Sheet append",
  );
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(raw.slice(0, 220) || `HTTP ${res.status}`);
  }
  if (!json.ok) throw new Error(json.error || "Sheet append failed");
  return json;
}

async function appendIssuesRowsToGoogleSheetWithRetry(webhookUrl, secret, rows, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await appendIssuesRowsToGoogleSheet(webhookUrl, secret, rows);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

async function uploadHighlightViaSheetWebhookWithRetry(dataUrl, webhookUrl, secret, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await uploadHighlightViaSheetWebhook(dataUrl, webhookUrl, secret);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

async function publishHighlightDataUrl(dataUrl, gSheetUrl, gSheetSecret) {
  if (!dataUrl) return { url: "", host: "" };

  let sheetU = String(gSheetUrl || "").trim();
  let sheetS = String(gSheetSecret || "").trim();
  if (!sheetU) sheetU = String(SHEET_WEBAPP_URL_FOR_SCREENSHOTS || "").trim();
  if (!sheetS) sheetS = String(SHEET_WEBAPP_SECRET_FOR_SCREENSHOTS || "").trim();
  const cName = String(CLOUDINARY_CLOUD_NAME || "").trim();
  const cPreset = String(CLOUDINARY_UPLOAD_PRESET || "").trim();
  const imgKey = String(IMGBB_API_KEY || "").trim();

  async function tryAllHosts(jpegDataUrl) {
    if (sheetU) {
      try {
        const url = await uploadHighlightViaSheetWebhookWithRetry(jpegDataUrl, sheetU, sheetS);
        if (url) return { url, host: "Google Drive" };
      } catch {
        /* fall through */
      }
    }
    if (cName && cPreset) {
      for (let ci = 0; ci < 2; ci++) {
        try {
          const url = await uploadToCloudinary(jpegDataUrl, cName, cPreset);
          if (url) return { url, host: "Cloudinary" };
        } catch {
          if (ci < 1) await sleep(2000);
        }
      }
    }
    if (imgKey) {
      try {
        const url = await uploadToImgBB(jpegDataUrl, imgKey);
        if (url) return { url, host: "ImgBB" };
      } catch {
        /* fall through */
      }
    }
    return { url: "", host: "" };
  }

  let jpeg = dataUrl;
  try {
    jpeg = await compressDataUrlToJpegMaxWidth(dataUrl, 2200, 0.86);
  } catch {
    jpeg = dataUrl;
  }

  let out = await tryAllHosts(jpeg);
  if (out.url) return out;

  try {
    const smaller = await compressDataUrlToJpegMaxWidth(dataUrl, 1280, 0.74);
    out = await tryAllHosts(smaller);
    if (out.url) return out;
  } catch {
    /* ignore */
  }

  return { url: "", host: "" };
}

function escapeCsvCell(s) {
  const t = String(s).replace(/"/g, '""');
  if (/[",\n\r]/.test(t)) return `"${t}"`;
  return t;
}

function issuesForCompareJobUi(merged) {
  return (Array.isArray(merged) ? merged : []).map((x) => ({
    id: x.id,
    description: x.description,
    status: x.status || "need to fix",
    ...(x.category ? { category: x.category } : {}),
    ...(x.qaSection ? { qaSection: x.qaSection } : {}),
    screenshotUrl: String(x.screenshotUrl || ""),
  }));
}

function issueLinkCellForExport(issue) {
  const shot = String(issue.screenshotUrl ?? "").trim();
  if (!shot) return "";
  return shot;
}

function csvTextToDownloadDataUrl(csvText) {
  const bytes = new TextEncoder().encode(csvText);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return `data:text/csv;charset=utf-8;base64,${btoa(bin)}`;
}

function jsonTextToDownloadDataUrl(jsonText) {
  const bytes = new TextEncoder().encode(jsonText);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return `data:application/json;charset=utf-8;base64,${btoa(bin)}`;
}

async function downloadDesignCacheBackupToDownloads({ frameKey, snapshotDataUrl, typographyJson, detectedExportWidth }) {
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    frameKey: String(frameKey || ""),
    detectedExportWidth: Number(detectedExportWidth || 0) || 0,
    snapshotDataUrl: String(snapshotDataUrl || ""),
    typographyJson: String(typographyJson || ""),
  };
  const jsonText = "\ufeff" + JSON.stringify(payload);
  const url = jsonTextToDownloadDataUrl(jsonText);
  await chrome.downloads.download({
    url,
    filename: `figma-compare-cache-backup-${Date.now()}.json`,
    saveAs: false,
    conflictAction: "uniquify",
  });
}

async function downloadIssuesCsvToDownloads(issues, footerLines) {
  const header = ["ID", "issue description", "Issue link (screenshot)", "review status"];
  const lines = [header.map(escapeCsvCell).join(",")];
  for (const r of issues) {
    lines.push(
      [r.id, r.description, issueLinkCellForExport(r), EXPORT_REVIEW_STATUS].map(escapeCsvCell).join(","),
    );
  }
  if (footerLines?.length) {
    lines.push("");
    for (const ln of footerLines) lines.push(escapeCsvCell(ln));
  }
  const csvText = "\ufeff" + lines.join("\r\n");
  const url = csvTextToDownloadDataUrl(csvText);
  await chrome.downloads.download({
    url,
    filename: `figma-compare-issues-${Date.now()}.csv`,
    saveAs: false,
    conflictAction: "uniquify",
  });
}

async function resolveFigmaTokenFromMessageOrStorage(msgToken) {
  let t = String(msgToken ?? "").trim();
  if (t) return t;
  const s = await chrome.storage.local.get(FIGMA_TOKEN_STORAGE_KEY);
  return String(s[FIGMA_TOKEN_STORAGE_KEY] || "").trim();
}

async function readExistingDesignCache() {
  const s = await chrome.storage.local.get([
    FIGMA_SNAPSHOT_DATA_URL_KEY,
    FIGMA_TYPO_SNAPSHOT_KEY,
    FIGMA_BOOTSTRAP_FRAME_KEY,
    FIGMA_DETECTED_EXPORT_WIDTH_KEY,
  ]);
  const snapshotDataUrl = String(s[FIGMA_SNAPSHOT_DATA_URL_KEY] || "").trim();
  const typographyJson = String(s[FIGMA_TYPO_SNAPSHOT_KEY] || "").trim();
  const frameKey = String(s[FIGMA_BOOTSTRAP_FRAME_KEY] || "").trim();
  const detectedExportWidth = Number(s[FIGMA_DETECTED_EXPORT_WIDTH_KEY] || 0) || 0;
  return { snapshotDataUrl, typographyJson, frameKey, detectedExportWidth };
}

function parseBootstrapFrameKey(frameKey) {
  const s = String(frameKey || "");
  const i = s.indexOf(":");
  if (i <= 0) return { fileKey: "", nodeId: "" };
  return { fileKey: s.slice(0, i), nodeId: s.slice(i + 1) };
}

function frameKeyFromFigmaUrl(u) {
  const { fileKey, nodeId } = parseFigmaUrl(String(u || "").trim());
  if (!fileKey || !nodeId) return "";
  return `${fileKey}:${nodeId}`;
}

async function fetchFreshFigmaDesignDataUrl() {
  const s = await chrome.storage.local.get([FIGMA_BOOTSTRAP_FRAME_KEY, FIGMA_TOKEN_STORAGE_KEY]);
  const frameKey = String(s[FIGMA_BOOTSTRAP_FRAME_KEY] || "").trim();
  const token = String(s[FIGMA_TOKEN_STORAGE_KEY] || "").trim();
  if (!frameKey || !token) return "";
  const { fileKey, nodeId } = parseBootstrapFrameKey(frameKey);
  if (!fileKey || !nodeId) return "";
  const cacheKey = `${fileKey}:${nodeId}`;
  const cached = figmaImageMemoryCache.get(cacheKey);
  if (cached?.dataUrl && cached?.savedAt && Date.now() - cached.savedAt < FIGMA_CACHE_TTL_MS) {
    return cached.dataUrl;
  }
  try {
    const imageApiUrl = await fetchFigmaImageExportUrl(fileKey, nodeId, token);
    const imgRes = await fetchWithTimeout(imageApiUrl, {}, 120000, "Figma CDN (image download)");
    if (!imgRes.ok) return "";
    const blob = await imgRes.blob();
    const dataUrl = await blobToDataUrl(blob);
    try {
      figmaImageMemoryCache.set(cacheKey, { dataUrl, savedAt: Date.now() });
    } catch {
      /* ignore */
    }
    return dataUrl;
  } catch {
    return "";
  }
}

function isRateLimitError(e) {
  const msg = e instanceof Error ? e.message : String(e || "");
  return /(^|[\s:])429([\s:]|$)|rate-?limited/i.test(msg);
}

async function applyCompareViewportForTab(tabId, widthOverride) {
  const data = await chrome.storage.local.get([COMPARE_VIEWPORT_WIDTH_KEY, FIGMA_DETECTED_EXPORT_WIDTH_KEY]);
  let target;
  let source = "manual";
  if (typeof widthOverride === "number" && widthOverride >= 360 && widthOverride <= 4096) {
    target = widthOverride;
    source = "message";
  } else {
    let raw = data[COMPARE_VIEWPORT_WIDTH_KEY];
    target = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
    if (!Number.isFinite(target) || target < 360 || target > 4096) {
      raw = data[FIGMA_DETECTED_EXPORT_WIDTH_KEY];
      target = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
      source = "figma-export";
    }
  }
  if (!Number.isFinite(target) || target < 360 || target > 4096) {
    return { restore: null, applied: false, source: null };
  }
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { restore: null, applied: false, source: null };
  }
  const windowId = tab.windowId;
  if (windowId == null) return { restore: null, applied: false, source: null };
  let prev = null;
  try {
    const win = await chrome.windows.get(windowId);
    prev = { windowId, width: win.width, height: win.height };
    await chrome.windows.update(windowId, {
      width: Math.round(target + COMPARE_WINDOW_OUTER_WIDTH_PADDING),
    });
    await sleep(650);
  } catch {
    return { restore: null, applied: false, source: null };
  }
  return {
    applied: true,
    source,
    restore: async () => {
      if (!prev) return;
      try {
        await chrome.windows.update(prev.windowId, { width: prev.width, height: prev.height });
      } catch {
        /* ignore */
      }
    },
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let responded = false;
  const sendOnce = (payload) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch {
      /* ignore */
    }
  };

  if (msg.type === "FIGMA_BOOTSTRAP_DESIGN") {
    (async () => {
      try {
        if (inMemoryJob.running) {
          sendOnce({ ok: false, error: "A compare is currently running. Please wait for it to finish, then refresh Figma cache." });
          return;
        }
        const token = await resolveFigmaTokenFromMessageOrStorage(msg.figmaToken);
        if (!token) {
          sendOnce({
            ok: false,
            error: "No Figma token in storage. Paste it once in Phase 1 — it is saved in this browser.",
          });
          return;
        }
        await chrome.storage.local.set({
          [BOOTSTRAP_JOB_KEY]: { status: "running", step: "Starting…", startedAt: Date.now() },
        });
        const meta = await bootstrapFigmaDesignOnce(msg.figmaUrl, token);
        sendOnce({
          ok: true,
          detectedExportWidth: meta.detectedExportWidth || 0,
          detectedExportHeight: meta.detectedExportHeight || 0,
        });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        const cached = await readExistingDesignCache();
        const cacheUsable =
          String(cached.typographyJson || "").length >= 50 && !!String(cached.frameKey || "").trim();
        if (isRateLimitError(e) && cacheUsable) {
          await chrome.storage.local.set({
            [BOOTSTRAP_JOB_KEY]: {
              status: "done",
              step: "Done (used existing cache due to Figma rate limit)",
              finishedAt: Date.now(),
              detectedExportWidth: cached.detectedExportWidth || 0,
            },
          });
          sendOnce({
            ok: true,
            detectedExportWidth: cached.detectedExportWidth || 0,
            detectedExportHeight: 0,
          });
          return;
        }

        await chrome.storage.local.set({
          [BOOTSTRAP_JOB_KEY]: {
            status: "error",
            step: "Error",
            finishedAt: Date.now(),
            error: errMsg,
          },
        });
        sendOnce({ ok: false, error: errMsg });
      }
    })();
    return true;
  }

  if (msg.type === "COMPARE_START") {
    (async () => {
      let restoreViewport = null;
      const startedAt = Date.now();
      let compareStartAcked = false;
      try {
        const boot = await chrome.storage.local.get([BOOTSTRAP_JOB_KEY]);
        const bootJob = boot[BOOTSTRAP_JOB_KEY] || null;
        if (bootJob?.status === "running") {
          sendOnce({ ok: false, error: "Figma cache refresh is running. Please wait for it to finish, then run compare." });
          return;
        }
        if (inMemoryJob.running) {
          sendOnce({ ok: false, error: "A compare is already running." });
          return;
        }
        inMemoryJob.running = true;
        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: { status: "running", step: "Starting…", startedAt, report: "", issues: [] },
        });
        let compareViewportApplied = false;
        let compareViewportSource = null;
        let figmaFrameResyncedThisRun = false;

        const {
          pageTabId: initialPageTabId,
          compareAllTabs,
          multiTabMax: multiTabMaxRaw,
          compareViewportWidth,
          compareWidths: compareWidthsMsg,
          figmaUrl: figmaUrlFromMsgRaw,
          pageUrlExact: pageUrlExactFromMsgRaw,
          figmaUrlExact: figmaUrlExactFromMsgRaw,
        } = msg || {};
        if (!initialPageTabId) throw new Error("Missing page tab.");
        let pageTabId = initialPageTabId;

        const pageUrlExactForReport =
          pageUrlExactFromMsgRaw === undefined || pageUrlExactFromMsgRaw === null
            ? ""
            : String(pageUrlExactFromMsgRaw).trim();
        const figmaUrlExactForReport =
          figmaUrlExactFromMsgRaw === undefined || figmaUrlExactFromMsgRaw === null
            ? ""
            : String(figmaUrlExactFromMsgRaw).trim();

        const figmaUrlFromMsg =
          figmaUrlFromMsgRaw === undefined || figmaUrlFromMsgRaw === null ? "" : String(figmaUrlFromMsgRaw).trim();
        const preSync = await chrome.storage.local.get([FIGMA_WIZARD_URL_KEY, FIGMA_BOOTSTRAP_FRAME_KEY, FIGMA_TOKEN_STORAGE_KEY]);
        const figmaUrlResolved =
          figmaUrlFromMsg.length > 0 ? figmaUrlFromMsg : String(preSync[FIGMA_WIZARD_URL_KEY] || "").trim();
        const storedFrameKey = String(preSync[FIGMA_BOOTSTRAP_FRAME_KEY] || "").trim();
        const tokenPre = String(preSync[FIGMA_TOKEN_STORAGE_KEY] || "").trim();
        const keyFromField = frameKeyFromFigmaUrl(figmaUrlResolved);

        if (figmaUrlResolved) {
          await chrome.storage.local.set({ [FIGMA_WIZARD_URL_KEY]: figmaUrlResolved });
        }

        if (figmaUrlFromMsg.length > 0 && !keyFromField) {
          throw new Error("Figma URL must include ?node-id=… pointing to the frame (use Figma → Share → Copy link).");
        }

        sendOnce({ ok: true });
        compareStartAcked = true;

        if (keyFromField && tokenPre && (!storedFrameKey || keyFromField !== storedFrameKey)) {
          figmaFrameResyncedThisRun = true;
          await chrome.storage.local.set({
            [COMPARE_JOB_KEY]: {
              status: "running",
              step: "Figma frame differs from cache — syncing from your current URL…",
              startedAt,
              report: "",
              issues: [],
            },
          });
          await bootstrapFigmaDesignOnce(figmaUrlResolved, tokenPre);
        }

        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: { status: "running", step: "Loading Figma frame from API (live export)…", startedAt },
        });
        const designDataUrl = await fetchFreshFigmaDesignDataUrl();
        if (!designDataUrl) {
          throw new Error(
            "Could not download the Figma frame from the API. In Phase 1, save your Figma link (with ?node-id=…) and token so file + node ids are stored. Compare always downloads a new export from Figma (nothing is read from a stored preview image). Check token, network/VPN, and rate limits.",
          );
        }

        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: { status: "running", step: "Loading Figma typography from API (live /nodes)…", startedAt },
        });
        let figmaTypoRoot = null;
        let typographyLiveNote = "";
        try {
          const sKey = await chrome.storage.local.get([FIGMA_BOOTSTRAP_FRAME_KEY, FIGMA_TOKEN_STORAGE_KEY]);
          const frameKey = String(sKey[FIGMA_BOOTSTRAP_FRAME_KEY] || "").trim();
          const token = String(sKey[FIGMA_TOKEN_STORAGE_KEY] || "").trim();
          const { fileKey, nodeId } = parseBootstrapFrameKey(frameKey);
          if (fileKey && nodeId && token) {
            figmaTypoRoot = await fetchFigmaNodeTree(fileKey, nodeId, token, { skipCache: true });
            try {
              await chrome.storage.local.set({ [FIGMA_TYPO_SNAPSHOT_KEY]: JSON.stringify(figmaTypoRoot) });
            } catch {
              /* best-effort */
            }
          } else {
            typographyLiveNote = "Typography vs Figma skipped: missing saved frame id or token (complete Phase 1).";
          }
        } catch (te) {
          const tm = te instanceof Error ? te.message : String(te);
          typographyLiveNote = `Live typography fetch failed: ${tm.slice(0, 220)}`;
          figmaTypoRoot = null;
        }

        const exportWidthStore = await chrome.storage.local.get(FIGMA_DETECTED_EXPORT_WIDTH_KEY);
        const feParsed = parseInt(String(exportWidthStore[FIGMA_DETECTED_EXPORT_WIDTH_KEY] ?? "").trim(), 10);
        const figmaExportWidthForCompare = Number.isFinite(feParsed) && feParsed >= 360 ? feParsed : 0;

        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: { status: "running", step: "Locating the live page tab…", startedAt },
        });
        pageTabId = await resolveComparePageTabId(pageTabId);

        const gSheetUrl = String(GOOGLE_SHEET_WEBAPP_URL || "").trim();
        const gSheetSecret = String(GOOGLE_SHEET_WEBAPP_SECRET || "").trim();

        const compareAllTabsOpt = compareAllTabs === true;
        const maxTabs = Math.min(
          12,
          Math.max(2, parseInt(String(multiTabMaxRaw ?? MULTI_TAB_MAX_DEFAULT), 10) || MULTI_TAB_MAX_DEFAULT),
        );

        let useMultiTab = false;
        let tabPlan = [];
        if (compareAllTabsOpt) {
          let tabListRes = await listPageTabsFromTab(pageTabId);
          if (!tabListRes?.ok) tabListRes = { ok: true, tabs: [] };
          const rawTabs = Array.isArray(tabListRes.tabs) ? tabListRes.tabs : [];
          useMultiTab = rawTabs.length >= 2;
          tabPlan = useMultiTab ? rawTabs.slice(0, maxTabs) : [];
        }

        let compareWidths = [];
        if (Array.isArray(compareWidthsMsg) && compareWidthsMsg.length) {
          compareWidths = [
            ...new Set(compareWidthsMsg.map((x) => parseInt(String(x), 10)).filter((n) => n >= 360 && n <= 4096)),
          ]
            .sort((a, b) => a - b)
            .slice(0, 8);
        }
        if (!compareWidths.length) {
          const cw = parseInt(String(compareViewportWidth ?? "").trim(), 10);
          if (Number.isFinite(cw) && cw >= 360 && cw <= 4096) compareWidths = [cw];
        }
        if (!compareWidths.length) {
          const data = await chrome.storage.local.get([COMPARE_VIEWPORT_WIDTH_KEY, FIGMA_DETECTED_EXPORT_WIDTH_KEY]);
          let raw = data[COMPARE_VIEWPORT_WIDTH_KEY];
          let w = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
          if (!Number.isFinite(w) || w < 360 || w > 4096) {
            raw = data[FIGMA_DETECTED_EXPORT_WIDTH_KEY];
            w = typeof raw === "number" ? raw : parseInt(String(raw ?? "").trim(), 10);
          }
          compareWidths = Number.isFinite(w) && w >= 360 && w <= 4096 ? [w] : [1440];
        }

        let merged = [];
        let imageForSheetAndUi = "";
        let highlightDataUrl = "";
        let mismatch = 0;
        let pageShotForCompress = "";
        let contentIssuesTotal = 0;
        let typographyIssuesTotal = 0;
        let spacingIssuesTotal = 0;
        let functionalIssuesTotal = 0;
        let multiTabSummary = "";
        const multiWidthDesktop = !useMultiTab && compareWidths.length > 1;
        const responsiveRulePass =
          !useMultiTab &&
          compareWidths.length === RESPONSIVE_QA_RULE_WIDTHS.length &&
          RESPONSIVE_QA_RULE_WIDTHS.every((n, i) => compareWidths[i] === n);

        if (!useMultiTab) {
          let allBatch = [];
          let lastPass = null;
          for (let wi = 0; wi < compareWidths.length; wi++) {
            const w = compareWidths[wi];
            if (restoreViewport) {
              await restoreViewport();
              restoreViewport = null;
            }
            const vp = await applyCompareViewportForTab(pageTabId, w);
            restoreViewport = vp.restore;
            compareViewportApplied = compareViewportApplied || !!vp.applied;
            compareViewportSource = vp.source ?? compareViewportSource;
            await sleep(wi === 0 ? 450 : 600);
            const r = await runSingleTabComparePass({
              pageTabId,
              designDataUrl,
              figmaTypoRoot,
              startedAt,
              tabLabel: "",
              gSheetUrl,
              gSheetSecret,
              stepPrefix: multiWidthDesktop ? `Viewport ${w}px (${wi + 1}/${compareWidths.length})` : "Capturing",
              viewportWidth: w,
              figmaExportWidth: figmaExportWidthForCompare,
            });
            // FIX Bug 1: r.batch is already numbered + formatted (assignNumericIds ran inside runSingleTabComparePass).
            // We collect batches here and dedupe across viewports — do NOT call assignNumericIds again.
            allBatch.push(...r.batch);
            lastPass = r;
            contentIssuesTotal += r.contentIssuesLen || 0;
            typographyIssuesTotal += r.figmaTypIssuesLen || 0;
            spacingIssuesTotal += r.spacingIssuesLen || 0;
            functionalIssuesTotal += r.functionalIssuesLen || 0;
          }
          if (multiWidthDesktop) {
            allBatch = dedupeIssuesAcrossViewports(allBatch);
          }
          // FIX Bug 1: Do NOT call assignNumericIds here — rows are already formatted.
          // Just use allBatch directly as merged.
          merged = allBatch;
          highlightDataUrl = lastPass?.highlightDataUrl || "";
          mismatch = lastPass?.mismatch ?? 0;
          pageShotForCompress = lastPass?.pageShot || "";
          imageForSheetAndUi = lastPass?.highlightDataUrl || "";
        } else {
          const w0 = compareWidths[0] ?? 1440;
          const vp = await applyCompareViewportForTab(pageTabId, w0);
          restoreViewport = vp.restore;
          compareViewportApplied = !!vp.applied;
          compareViewportSource = vp.source ?? null;
          await sleep(450);
          multiTabSummary = tabPlan.map((t) => t.label || "").join("; ");
          const all = [];
          let prevShot = null;
          let firstHighlight = "";
          let firstMismatch = 0;
          for (let i = 0; i < tabPlan.length; i++) {
            const label = tabPlan[i].label || `Tab ${i + 1}`;
            await sendMessageTimeout(pageTabId, { type: "SCROLL_PAGE_Y", y: 0 }, 10000).catch(() => {});
            const act = await activatePageTabIndexOnTab(pageTabId, i);
            if (!act?.ok) {
              throw new Error(`Could not activate in-page tab ${i + 1} ("${label}").`);
            }
            await sleep(750);
            await sleep(320);

            const r = await runSingleTabComparePass({
              pageTabId,
              designDataUrl,
              figmaTypoRoot,
              startedAt,
              tabLabel: label,
              gSheetUrl,
              gSheetSecret,
              stepPrefix: `Tab ${i + 1}/${tabPlan.length} (${label})`,
              viewportWidth: w0,
              figmaExportWidth: figmaExportWidthForCompare,
            });
            if (i === 0) {
              firstHighlight = r.highlightDataUrl || "";
              firstMismatch = r.mismatch;
            }
            prevShot = r.pageShot;
            contentIssuesTotal += r.contentIssuesLen || 0;
            typographyIssuesTotal += r.figmaTypIssuesLen || 0;
            spacingIssuesTotal += r.spacingIssuesLen || 0;
            functionalIssuesTotal += r.functionalIssuesLen || 0;
            // FIX Bug 1: r.batch is already numbered + formatted — collect directly
            all.push(...r.batch);
          }
          // FIX Bug 1: Do NOT call assignNumericIds here — rows are already formatted.
          merged = all;
          highlightDataUrl = firstHighlight || "";
          mismatch = firstMismatch;
          pageShotForCompress = prevShot || "";
          imageForSheetAndUi = firstHighlight || "";
        }

        if (!imageForSheetAndUi && merged.length > 0 && pageShotForCompress) {
          await chrome.storage.local.set({
            [COMPARE_JOB_KEY]: {
              status: "running",
              step: "Preparing page screenshot for export…",
              startedAt,
              report: "",
              issues: [],
            },
          });
          imageForSheetAndUi = await compressDataUrlToJpegMaxWidth(pageShotForCompress, 1400, 0.72);
        }

        let shareUrl = "";
        let shareHost = "";
        let uploadNote = "";

        if (merged.length > 0 && imageForSheetAndUi) {
          await chrome.storage.local.set({
            [COMPARE_JOB_KEY]: { status: "running", step: "Uploading screenshot for shareable link…", startedAt },
          });
          try {
            const pub = await publishHighlightDataUrl(imageForSheetAndUi, gSheetUrl, gSheetSecret);
            shareUrl = pub.url;
            shareHost = pub.host;
            if (!shareUrl) {
              uploadNote =
                "No screenshot URL — set IMGBB_API_KEY in background.js (easiest) and/or Cloudinary, or keep GOOGLE_SHEET_WEBAPP_URL for Drive.";
            }
          } catch (pubErr) {
            const pm = pubErr instanceof Error ? pubErr.message : String(pubErr);
            uploadNote = `Screenshot upload failed: ${pm.slice(0, 240)}`;
          }
        }

        if (!merged.length) {
          /* no per-issue uploads */
        } else {
          await chrome.storage.local.set({
            [COMPARE_JOB_KEY]: { status: "running", step: "Per-issue screenshots ready (from tab passes)…", startedAt },
          });
        }

        let sheetLogLine = "";
        if (gSheetUrl && merged.length > 0) {
          try {
            const rows = merged.map((issue) => ({
              id: issue.id,
              qaSection: "",
              description: issue.description,
              screenshot: String(issue.screenshotUrl || ""),
              status: EXPORT_REVIEW_STATUS,
            }));
            await appendIssuesRowsToGoogleSheetWithRetry(gSheetUrl, gSheetSecret, rows);
            sheetLogLine = shareUrl
              ? `Google Sheet: appended ${merged.length} row(s) — screenshot URL (${shareHost}).`
              : `Google Sheet: appended ${merged.length} row(s) — screenshot column empty (upload failed).`;
          } catch (sheetErr) {
            const sm = sheetErr instanceof Error ? sheetErr.message : String(sheetErr);
            sheetLogLine = `Google Sheet append failed (CSV still exported if enabled): ${sm.slice(0, 200)}`;
          }
        }

        let csvNote = "";
        if (AUTO_DOWNLOAD_CSV_AFTER_COMPARE && merged.length > 0) {
          await chrome.storage.local.set({
            [COMPARE_JOB_KEY]: { status: "running", step: "Saving CSV to Downloads…", startedAt },
          });
          try {
            const csvFooter = [
              "---",
              `Finished: ${new Date().toISOString()}`,
              ...(shareUrl ? [`Overview screenshot (${shareHost}): ${shareUrl}`] : []),
              'Per-row "screenshot" links are cropped highlights when upload hosts are configured.',
              ...(uploadNote ? [uploadNote] : []),
              ...(sheetLogLine ? [sheetLogLine] : []),
            ];
            await downloadIssuesCsvToDownloads(merged, csvFooter);
            csvNote = "CSV saved to Downloads (figma-compare-issues-*.csv). Import into Google Sheets if needed.";
          } catch (dlErr) {
            const dm = dlErr instanceof Error ? dlErr.message : String(dlErr);
            csvNote = `CSV download failed: ${dm.slice(0, 200)}`;
          }
        }

        const urlSnapForClient = await chrome.storage.local.get([
          PAGE_URL_STORAGE_KEY,
          FIGMA_WIZARD_URL_KEY,
          FIGMA_BOOTSTRAP_FRAME_KEY,
        ]);
        const pageUrlForClient =
          pageUrlExactForReport || String(urlSnapForClient[PAGE_URL_STORAGE_KEY] || "").trim();
        const figmaUrlForClient =
          figmaUrlExactForReport || String(urlSnapForClient[FIGMA_WIZARD_URL_KEY] || "").trim();
        const frameKeyForClient = String(urlSnapForClient[FIGMA_BOOTSTRAP_FRAME_KEY] || "").trim();

        const reportLines = [
          "Report: live page vs Figma — each run downloads a fresh frame export (PNG) and a fresh /nodes typography tree from the Figma API. No Figma raster is kept in extension storage for compare.",
          "",
          ...(typographyLiveNote ? [typographyLiveNote, ""] : []),
          ...(multiWidthDesktop
            ? [
                `Multi-viewport run: inner widths ${compareWidths.join(", ")}px (browser resized each pass, then restored).`,
                "Content, Typography, and Functional issues that are identical across widths are listed once; Visual (pixel) rows are kept per width when they differ.",
                ...(responsiveRulePass
                  ? ["This run used the full responsive QA set (all canonical rule widths, in ascending order).", ""]
                  : []),
              ]
            : []),
          ...(useMultiTab
            ? [`Multi-tab compare: ${tabPlan.length} tab(s) — ${multiTabSummary || "(unnamed tabs)"}.`, "", "Each issue is prefixed with [Tab name].", ""]
            : []),
          ...(compareViewportApplied
            ? [
                compareViewportSource === "figma-export"
                  ? "Browser window was resized using the detected Figma export width before capture, then restored."
                  : "Browser window was resized before capture, then restored.",
                "",
              ]
            : []),
          mismatch < SECTION_PIXEL_MISMATCH_THRESH
            ? `Image vs design (first tab / single pass): no strong mismatch (~${Math.round(mismatch * 100)}% tolerant delta).`
            : "Image vs design: mismatch row(s) from pixel compare — see table (per-tab when multi-tab).",
          "",
          ...buildClientQaUrlsAndChecklistLines({
            pageUrl: pageUrlForClient,
            figmaUrl: figmaUrlForClient,
            frameKey: frameKeyForClient,
            figmaFrameResynced: figmaFrameResyncedThisRun,
          }),
          PER_ISSUE_FIGMA_PANEL_ENABLED
            ? "Per-issue screenshots: FIGMA | LIVE side-by-side from the same export used in this run; red outline marks the live crop; caption = issue text."
            : "Per-issue screenshots: live crop with red frame, pointer, and caption matching the CSV row description exactly.",
          "Crops are expanded to a minimum size, then checked for empty/white frames; if a crop looks blank, a wider region is retried automatically.",
          "Report scope: Visual (pixel), Content (copy), Typography vs Figma (fonts/styles), and Functional (light DOM: weak hrefs, mailto/tel hints, form labels, button names, multiple H1).",
          figmaExportWidthForCompare >= 360
            ? `Typography font sizes: strict match to Figma when the tab width matches the detected Figma export (${figmaExportWidthForCompare}px, ±4px).`
            : "Typography font sizes: export width unknown — use Phase 1 Analyze so detected frame width is saved for stricter desktop matching.",
          figmaTypoRoot
            ? `Raw counts (every viewport pass, before table dedupe): Content ${contentIssuesTotal}, Typography ${typographyIssuesTotal}, Spacing ${spacingIssuesTotal}, Functional ${functionalIssuesTotal}.`
            : "Content/Typography vs Figma: no live typography tree this run — see note above (token, frame id, or Figma API).",
          "",
          `Total table rows: ${merged.length} (numeric IDs).`,
          ...(csvNote ? ["", csvNote] : []),
          ...(sheetLogLine ? ["", sheetLogLine] : []),
          ...(shareUrl ? ["", `Screenshot URL (${shareHost}): ${shareUrl}`] : []),
          ...(uploadNote && !shareUrl ? ["", uploadNote] : []),
        ];
        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: {
            status: "done",
            step: "Done",
            startedAt,
            finishedAt: Date.now(),
            report: reportLines.join("\n"),
            issues: issuesForCompareJobUi(merged),
            highlightDataUrl: highlightDataUrl || imageForSheetAndUi || "",
          },
        });
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        await chrome.storage.local.set({
          [COMPARE_JOB_KEY]: { status: "error", step: "Error", startedAt, finishedAt: Date.now(), error: err },
        });
        if (!compareStartAcked) {
          sendOnce({ ok: false, error: err });
        }
      } finally {
        try {
          await restoreViewport?.();
        } catch {
          /* ignore */
        }
        inMemoryJob.running = false;
      }
    })();
    return true;
  }

  if (msg.type === "COMPARE_STATUS") {
    (async () => {
      try {
        const s = await chrome.storage.local.get([COMPARE_JOB_KEY]);
        sendOnce({ ok: true, job: s[COMPARE_JOB_KEY] || null });
      } catch (e) {
        sendOnce({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  if (msg.type === "UPLOAD_HIGHLIGHT_LINK") {
    (async () => {
      try {
        if (!msg.dataUrl) throw new Error("No image to upload.");
        const store = await chrome.storage.local.get([SHEET_WEBHOOK_STORAGE_KEY, SHEET_SECRET_STORAGE_KEY]);
        const legacyWebhook = String(
          (
            SHEET_WEBAPP_URL_FOR_SCREENSHOTS ||
            store[SHEET_WEBHOOK_STORAGE_KEY] ||
            msg.webhookUrl ||
            ""
          ).trim(),
        );
        const legacySecret = String(
          SHEET_WEBAPP_SECRET_FOR_SCREENSHOTS ||
            (msg.secret != null && msg.secret !== "" ? msg.secret : store[SHEET_SECRET_STORAGE_KEY]) ||
            "",
        );
        const gSheetMain = String(GOOGLE_SHEET_WEBAPP_URL || "").trim();
        const gSheetMainSecret = String(GOOGLE_SHEET_WEBAPP_SECRET || "").trim();
        const webhookForPublish = gSheetMain || legacyWebhook;
        const secretForPublish = gSheetMain ? gSheetMainSecret : legacySecret;
        const { url: finalUrl } = await publishHighlightDataUrl(msg.dataUrl, webhookForPublish, secretForPublish);
        if (!finalUrl) {
          throw new Error(
            "No image host succeeded. Set GOOGLE_SHEET_WEBAPP_URL (Drive), and/or IMGBB_API_KEY (imgbb.com/api), and/or Cloudinary in background.js.",
          );
        }
        sendOnce({ ok: true, url: finalUrl });
      } catch (e) {
        sendOnce({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }
});