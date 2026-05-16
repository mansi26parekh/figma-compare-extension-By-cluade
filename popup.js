/**
 * LOCKED FUNCTIONAL SURFACE — Keep message payloads to background unchanged (see LOCKED_SURFACE.md).
 * Types: FIGMA_BOOTSTRAP_DESIGN, COMPARE_START (acks immediately; poll COMPARE_STATUS), COMPARE_STATUS, UPLOAD_HIGHLIGHT_LINK.
 * UI (phases, modals, labels) may change; wiring to those messages and storage keys may not break.
 */
const $ = (id) => document.getElementById(id);
let isQaRunning = false;
/** Rows shown in preview + used for CSV download */
let lastPreviewRows = [];
let lastHighlightDataUrl = "";
let lastHighlightShareUrl = "";
let isUploadingHighlightLink = false;
/** True when Phase 1 saved a Figma frame id (`figmaCompare_figmaBootstrapFrameKey`) from your link. */
let snapshotReady = false;

const STORAGE = {
  setupComplete: "figmaCompare_setupComplete",
  figmaUrl: "figmaCompare_figmaUrl",
  pageUrl: "figmaCompare_pageUrl",
  /** Last compare job (same key as `background.js` `COMPARE_JOB_KEY`). */
  compareJob: "figmaCompare_compareJob",
  wizardDraft: "figmaCompare_wizardDraft",
  figmaToken: "figmaCompare_figmaToken",
  figmaSnapshotDataUrl: "figmaCompare_figmaSnapshotDataUrl",
  figmaTypographySnapshot: "figmaCompare_figmaTypographySnapshot_v2",
  figmaBootstrapFrame: "figmaCompare_figmaBootstrapFrameKey",
  /** Pixel width of last Figma API PNG export (`background.js` sets on bootstrap). */
  figmaDetectedExportWidth: "figmaCompare_figmaDetectedExportWidth",
  bootstrapJob: "figmaCompare_bootstrapJob",
  /** Single-compare width when set (same key `background.js` reads). */
  compareViewportWidth: "figmaCompare_compareViewportWidth",
  /** Remember “all breakpoints” checkbox in Phase 2. */
  responsiveQaPass: "figmaCompare_responsiveQaPass",
  /** After CSV download from Phase 3, next popup open shows Phase 1 (setup). */
  openSetupNext: "figmaCompare_openSetupNext",
};

/** Fixed compare viewport inner width (px) while the width control is hidden from the UI. */
const COMPARE_VIEWPORT_WIDTH = 1440;

const OPENAI_MODEL_TEXT = "gpt-4o-mini";
const OPENAI_MODEL_VISION = "gpt-4o-mini";

let draftSaveTimer = null;
let apiKeySaveTimer = null;
/** Mirrors last-known token: input value or `chrome.storage` so we do not require retyping after popup closes. */
let figmaTokenResolvedHint = "";

async function refreshFigmaTokenHint() {
  const fromField = ($("wizardFigmaToken")?.value || "").trim();
  if (fromField) {
    figmaTokenResolvedHint = fromField;
    return;
  }
  const s = await chrome.storage.local.get(STORAGE.figmaToken);
  figmaTokenResolvedHint = (s[STORAGE.figmaToken] || "").trim();
}

function tokenOkForWizard(w) {
  const fromField = (w.figmaToken || "").trim();
  if (fromField.length > 0) return true;
  return (figmaTokenResolvedHint || "").trim().length > 0;
}

function setSetupStatus(text) {
  const el = $("setupStatus");
  if (el) el.textContent = text || "";
}

function setCompareRunStatus(text) {
  const el = $("compareRunStatus");
  if (el) el.textContent = text || "";
}

function isLikelyFigmaUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === "www.figma.com" || h === "figma.com";
  } catch {
    return false;
  }
}

function parseFigmaFrameKeyFromUrl(u) {
  try {
    const x = new URL(String(u || "").trim());
    const path = x.pathname || "";
    const m = path.match(/\/(file|design)\/([a-zA-Z0-9]+)\//);
    const fileKey = m?.[2] || "";
    let nodeId = x.searchParams.get("node-id") || "";
    if (nodeId) {
      nodeId = decodeURIComponent(nodeId);
      if (!nodeId.includes(":")) nodeId = nodeId.replace(/-/g, ":");
    }
    if (!fileKey || !nodeId) return "";
    return `${fileKey}:${nodeId}`;
  } catch {
    return "";
  }
}

function isHttpUrl(u) {
  try {
    const p = new URL(u).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

// (Google Sheet support removed from UI)

async function loadWizardFromStorage() {
  const data = await chrome.storage.local.get([
    STORAGE.setupComplete,
    STORAGE.figmaUrl,
    STORAGE.pageUrl,
  ]);
  return {
    setupComplete: !!data[STORAGE.setupComplete],
    figmaUrl: data[STORAGE.figmaUrl] || "",
    pageUrl: data[STORAGE.pageUrl] || "",
  };
}

/**
 * Phase 2 compare must use the same Figma frame + webpage URL saved in Phase 1
 * (`figmaCompare_figmaUrl` / `figmaCompare_pageUrl`), not only whatever happens to be in
 * the (often hidden) inputs. Field values still win when non-empty so edits on setup apply.
 */
async function resolveCompareSessionUrls() {
  const data = await chrome.storage.local.get([STORAGE.figmaUrl, STORAGE.pageUrl]);
  const storedFigma = String(data[STORAGE.figmaUrl] || "").trim();
  const storedPage = String(data[STORAGE.pageUrl] || "").trim();
  const figmaFromField = String($("wizardFigmaUrl")?.value ?? "").trim();
  const pageFromField = String($("wizardPageUrl")?.value ?? "").trim();

  let liveFigmaUrl = figmaFromField || storedFigma;
  let livePageUrl = pageFromField || storedPage;

  if ($("wizardFigmaUrl") && !figmaFromField && liveFigmaUrl) {
    $("wizardFigmaUrl").value = liveFigmaUrl;
  }
  if ($("wizardPageUrl") && !pageFromField && livePageUrl && isHttpUrl(livePageUrl)) {
    $("wizardPageUrl").value = livePageUrl;
  }

  if (!livePageUrl || !isHttpUrl(livePageUrl)) {
    try {
      const tab = await getActiveTab();
      const u = String(tab?.url || "").trim();
      if (u && isHttpUrl(u)) {
        livePageUrl = u;
        if ($("wizardPageUrl")) $("wizardPageUrl").value = u;
      }
    } catch {
      /* ignore */
    }
  }

  return { liveFigmaUrl, livePageUrl };
}

async function saveWizard(payload) {
  await chrome.storage.local.set({
    [STORAGE.setupComplete]: true,
    [STORAGE.figmaUrl]: payload.figmaUrl,
    [STORAGE.pageUrl]: payload.pageUrl,
  });
  await chrome.storage.local.remove(STORAGE.wizardDraft);
}

async function loadWizardDraft() {
  const data = await chrome.storage.local.get(STORAGE.wizardDraft);
  return data[STORAGE.wizardDraft] || null;
}

async function persistWizardDraftNow() {
  const w = getWizardForm();
  await chrome.storage.local.set({
    [STORAGE.wizardDraft]: {
      figmaUrl: w.figmaUrl,
      pageUrl: w.pageUrl,
    },
  });
}

function scheduleWizardDraftSave() {
  clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(persistWizardDraftNow, 250);
}

async function refreshSnapshotReady() {
  const s = await chrome.storage.local.get([STORAGE.figmaBootstrapFrame]);
  snapshotReady = !!String(s[STORAGE.figmaBootstrapFrame] || "").trim();
  updateSaveEnabled();
}

async function loadApiKeysIntoFields() {
  const data = await chrome.storage.local.get([
    STORAGE.figmaToken,
    STORAGE.figmaSnapshotDataUrl,
    STORAGE.figmaTypographySnapshot,
    STORAGE.figmaDetectedExportWidth,
    STORAGE.figmaBootstrapFrame,
  ]);
  const st = $("figmaSnapshotStatus");
  const hasUploadedSnapshot = !!data[STORAGE.figmaSnapshotDataUrl];
  const hasTypo = String(data[STORAGE.figmaTypographySnapshot] || "").length >= 50;
  const hasFrame = !!String(data[STORAGE.figmaBootstrapFrame] || "").trim();
  const det = data[STORAGE.figmaDetectedExportWidth];
  const detN = typeof det === "number" ? det : parseInt(String(det ?? "").trim(), 10);
  const detLine =
    Number.isFinite(detN) && detN >= 360
      ? ` Last Figma export width: ${detN}px (used to resize the window before compare).`
      : "";
  if (st) {
    if (hasTypo && hasFrame) {
      st.textContent =
        "Phase 1: frame + typography saved. No Figma preview image is kept in storage — each compare downloads a fresh export from the API." +
        detLine;
    } else if (hasUploadedSnapshot) {
      st.textContent =
        "Uploaded design image (fallback) is stored locally. Add Figma URL + token for live API exports and typography." +
        detLine;
    } else if (hasFrame) {
      st.textContent =
        "Frame id saved; typography missing or incomplete — click Analyze Figma page or Refresh Figma cache." + detLine;
    } else {
      st.textContent =
        "Add Figma URL + token and save, or use design upload if that option is enabled in the UI." + detLine;
    }
  }
}

async function persistApiKeysNow() {
  const t = ($("wizardFigmaToken")?.value || "").trim();
  if (t) await chrome.storage.local.set({ [STORAGE.figmaToken]: t });
  await refreshFigmaTokenHint();
}

// (Google Sheet logging removed from UI)

function scheduleApiKeySave() {
  clearTimeout(apiKeySaveTimer);
  apiKeySaveTimer = setTimeout(persistApiKeysNow, 150);
}

async function resolveApiKeysForRun() {
  await loadApiKeysIntoFields();
  let figmaToken = ($("wizardFigmaToken")?.value || "").trim();
  if (!figmaToken) {
    const s = await chrome.storage.local.get([STORAGE.figmaToken]);
    figmaToken = (s[STORAGE.figmaToken] || "").trim();
  }
  await persistApiKeysNow();
  return { figmaToken };
}

/* Figma URL parsing — unused in popup (background parses URLs).
function parseFigmaUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:design|file)\/([^/]+)/);
    const fileKey = m?.[1] || null;
    const nodeParam = u.searchParams.get("node-id");
    const nodeId = nodeParam ? decodeURIComponent(nodeParam).replace(/-/g, ":") : null;
    return { fileKey, nodeId };
  } catch {
    return { fileKey: null, nodeId: null };
  }
}
*/

function compactFigmaNodeForQa(node, depth = 0) {
  if (!node || depth > 10) return null;
  const out = { name: node.name, type: node.type };
  if (node.type === "TEXT") {
    out.text = (node.characters || "").slice(0, 700);
    if (node.style) {
      const s = node.style;
      out.typography = {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        fontFamily: s.fontFamily,
        fontStyle: s.fontStyle,
        lineHeightPx: s.lineHeightPx,
        letterSpacing: s.letterSpacing,
      };
    }
    const solid = (node.fills || []).find((f) => f && f.type === "SOLID" && f.visible !== false && f.color);
    if (solid?.color) {
      const c = solid.color;
      out.fillColor = {
        r: Math.round((c.r || 0) * 255),
        g: Math.round((c.g || 0) * 255),
        b: Math.round((c.b || 0) * 255),
        a: typeof c.a === "number" ? c.a : 1,
      };
    }
  }
  if (["FRAME", "COMPONENT", "INSTANCE", "SECTION", "GROUP", "COMPONENT_SET"].includes(node.type)) {
    if (node.layoutMode && node.layoutMode !== "NONE") {
      out.padding = {
        top: node.paddingTop,
        right: node.paddingRight,
        bottom: node.paddingBottom,
        left: node.paddingLeft,
      };
      out.itemSpacing = node.itemSpacing;
    }
  }
  if (node.children?.length) {
    const kids = node.children
      .slice(0, 20)
      .map((c) => compactFigmaNodeForQa(c, depth + 1))
      .filter(Boolean);
    if (kids.length) out.children = kids;
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Content scripts can hang on heavy pages; this avoids an infinite spinner. */
function sendMessageTimeout(tabId, message, timeoutMs = 45000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `The page did not respond in ${timeoutMs / 1000}s. Focus that tab, reload it, then try again.`,
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);
}

/** Prevents infinite spinner when APIs or Sheet webhook hang. `label` shows in errors (e.g. "OpenAI"). */
async function fetchWithTimeout(resource, options = {}, timeoutMs = 120000, label = "Request") {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(resource, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw new Error(
        `${label}: timed out after ${Math.round(timeoutMs / 1000)}s. Check VPN/firewall and try again.`,
      );
    }
    const raw = e instanceof Error ? e.message : String(e);
    let hint = "";
    if (/failed to fetch|networkerror|network request failed|load failed|echec|load failed/i.test(raw)) {
      hint =
        " Common causes: no internet, VPN/firewall blocking api.openai.com or api.figma.com, ad-blocker/privacy extension blocking this extension, or corporate proxy. Try another network, allow the extension in the blocker, or disable VPN briefly.";
    }
    throw new Error(`${label}: ${raw}.${hint}`);
  } finally {
    clearTimeout(id);
  }
}

function figmaRetryWaitMs(res, attempt) {
  const h = res.headers.get("Retry-After");
  if (h) {
    const sec = parseInt(h, 10);
    if (Number.isFinite(sec)) return Math.min(sec * 1000, 120000);
  }
  return Math.min(2500 * Math.pow(2, attempt), 60000);
}

/** Figma returns 429 often; retry with backoff + optional Retry-After header. */
async function fetchFigmaNodeTree(fileKey, nodeId, token) {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(nodeId)}`;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchWithTimeout(
      url,
      { headers: { "X-Figma-Token": token } },
      90000,
      "Figma API (file nodes)",
    );
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text);
      const entry = json.nodes?.[nodeId] || json.nodes?.[Object.keys(json.nodes || {})[0]];
      if (!entry?.document) throw new Error("Figma did not return a document for this node id.");
      return compactFigmaNodeForQa(entry.document);
    }
    if (res.status === 429 && attempt < maxAttempts - 1) {
      await sleep(figmaRetryWaitMs(res, attempt));
      continue;
    }
    throw new Error(`Figma nodes API ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function fetchFigmaImageExportUrl(fileKey, nodeId, token) {
  const url = `https://api.figma.com/v1/images/${encodeURIComponent(fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`;
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchWithTimeout(
      url,
      { headers: { "X-Figma-Token": token } },
      90000,
      "Figma API (image export URL)",
    );
    const text = await res.text();
    if (res.ok) {
      const meta = JSON.parse(text);
      if (meta.err) throw new Error(String(meta.err));
      const imageUrl = meta.images?.[nodeId] || Object.values(meta.images || {})[0];
      if (!imageUrl) throw new Error("Figma did not return an image URL.");
      return imageUrl;
    }
    if (res.status === 429 && attempt < maxAttempts - 1) {
      await sleep(figmaRetryWaitMs(res, attempt));
      continue;
    }
    throw new Error(`Figma images API ${res.status}: ${text.slice(0, 400)}`);
  }
}

async function openaiChat(messages, apiKey) {
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_TEXT,
        messages,
        temperature: 0.2,
        max_tokens: 3200,
      }),
    },
    150000,
    "OpenAI (chat)",
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`OpenAI: invalid response (HTTP ${res.status}). Check API key and account status.`);
  }
  if (!res.ok) {
    const err = data.error?.message || JSON.stringify(data).slice(0, 400);
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

async function openaiVisionCompare(userContentParts, apiKey) {
  const res = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL_VISION,
        messages: [{ role: "user", content: userContentParts }],
        temperature: 0.2,
        max_tokens: 2600,
      }),
    },
    180000,
    "OpenAI (vision)",
  );
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`OpenAI (vision): invalid response (HTTP ${res.status}). Images may be too large or key invalid.`);
  }
  if (!res.ok) {
    const err = data.error?.message || JSON.stringify(data).slice(0, 400);
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  return data.choices?.[0]?.message?.content || "";
}

const QA_SYSTEM_PROMPT = `Compare PAGE_MEASUREMENTS_JSON to FIGMA_DESIGN_JSON. Be concise—it must be fast to read.

Rules:
- Favicon: one short line if relevant.
- Sections top-to-bottom: **Section N**: **PASS** or **FAIL** + at most **2 short bullets** (px numbers when comparing spacing/type).
- **Summary**: maximum **2 sentences**.

Finally output **only** this JSON code block (nothing after it):
\`\`\`json
{"issues":[{"id":"1","description":"short finding","status":"need to fix"}]}
\`\`\`
Put only real problems in \`issues\`. status: "need to fix" | "review" | "pass". Use {"issues":[]} if everything passed.`;

const VISION_COMPARE_PROMPT = `Image 1 = Figma frame. Image 2 = live viewport. Be concise.

Section-by-section: **Section N**: PASS or FAIL + max 2 short bullets. Mention viewport limits once.

End with **only** this JSON block:
\`\`\`json
{"issues":[{"id":"1","description":"short finding","status":"need to fix"}]}
\`\`\`
Only failures/reviews in issues. {"issues":[]} if none.`;

function normalizeIssue(row, index) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id ?? row.ID ?? index + 1).trim();
  const description = String(
    row.description ?? row.issue_description ?? row["issue description"] ?? "",
  ).trim();
  const status = String(row.status ?? "need to fix").trim();
  if (!description) return null;
  const screenshotUrl = String(row.screenshotUrl ?? row.screenshot ?? "").trim();
  return { id, description, status, ...(screenshotUrl ? { screenshotUrl } : {}) };
}

function parseIssuesFromAiReport(text) {
  const candidates = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    candidates.push(m[1].trim());
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(candidates[i]);
      if (j && Array.isArray(j.issues)) {
        return {
          issues: j.issues.map(normalizeIssue).filter(Boolean),
        };
      }
    } catch {
      /* try next block */
    }
  }
  return { issues: [] };
}

function shouldLogIssue(row) {
  const s = (row.status || "").toLowerCase().trim();
  return s !== "pass" && s !== "ok" && s !== "passed";
}

/** Text-only rows (no screenshot) — fast, reliable; screenshot column stays empty or you can paste links manually. */
// (Google Sheet logging removed from UI)

function fallbackRowsFromAiReport(text) {
  const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 3000);
  return [
    {
      id: "qa-report",
      description: excerpt || "(empty)",
      status: "review",
    },
  ];
}

function rowsForPreviewFromAiText(text) {
  const parsed = parseIssuesFromAiReport(text);
  let rows = parsed.issues.filter(shouldLogIssue);
  if (!rows.length && text.trim().length > 80) {
    rows = fallbackRowsFromAiReport(text);
  }
  return rows;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeCsvCell(s) {
  const t = String(s).replace(/"/g, '""');
  if (/[",\n\r]/.test(t)) return `"${t}"`;
  return t;
}

function renderFailPreviewRows(rows) {
  lastPreviewRows = Array.isArray(rows) ? rows : [];
  const section = $("failPreviewSection");
  const tbody = $("failPreviewTbody");
  if (!section || !tbody) return;

  tbody.replaceChildren();
  section.classList.remove("hidden");

  if (!lastPreviewRows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.className = "fail-preview-empty";
    td.textContent = "No issues found for this run.";
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const r of lastPreviewRows) {
      const tr = document.createElement("tr");

      const tdId = document.createElement("td");
      tdId.textContent = String(r.id ?? "");

      const tdType = document.createElement("td");
      tdType.textContent = String(r.category || "—").trim() || "—";

      const tdDesc = document.createElement("td");
      tdDesc.textContent = String(r.description ?? "");

      const tdShot = document.createElement("td");
      const perRow = String(r.screenshotUrl || "").trim();
      if (/^https?:\/\//i.test(perRow)) {
        const a = document.createElement("a");
        a.href = perRow;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Open screenshot";
        tdShot.appendChild(a);
      } else {
        tdShot.textContent = "—";
      }

      const tdStatus = document.createElement("td");
      tdStatus.textContent = String(r.status || "need to fix").trim();

      tr.append(tdId, tdType, tdDesc, tdShot, tdStatus);
      tbody.appendChild(tr);
    }
  }

  const dl = $("downloadIssuesCsv");
  if (dl) dl.disabled = lastPreviewRows.length === 0;
}

function resetFailPreview() {
  lastPreviewRows = [];
  $("failPreviewSection")?.classList.add("hidden");
  const tb = $("failPreviewTbody");
  if (tb) tb.replaceChildren();
  const dl = $("downloadIssuesCsv");
  if (dl) dl.disabled = true;
  lastHighlightDataUrl = "";
  lastHighlightShareUrl = "";
  isUploadingHighlightLink = false;
  setCompareRunStatus("");
}

function renderHighlightPreview(dataUrl) {
  lastHighlightDataUrl = dataUrl || "";
  lastHighlightShareUrl = "";
  if (lastHighlightDataUrl) void ensureHighlightShareLink();
}

function downloadHighlightImage() {
  if (!lastHighlightDataUrl) return;
  const a = document.createElement("a");
  a.href = lastHighlightDataUrl;
  a.download = `figma-compare-highlight-${Date.now()}.jpg`;
  a.click();
}

function renderFailPreview(aiText) {
  lastPreviewRows = rowsForPreviewFromAiText(aiText);
  const section = $("failPreviewSection");
  const tbody = $("failPreviewTbody");
  if (!section || !tbody) return;

  tbody.replaceChildren();
  for (const r of lastPreviewRows) {
    const tr = document.createElement("tr");

    const tdId = document.createElement("td");
    tdId.textContent = String(r.id ?? "");

    const tdType = document.createElement("td");
    tdType.textContent = String(r.category || "—").trim() || "—";

    const tdDesc = document.createElement("td");
    tdDesc.textContent = String(r.description ?? "");

    const tdShot = document.createElement("td");
    const perRow = String(r.screenshotUrl || "").trim();
    if (/^https?:\/\//i.test(perRow)) {
      const a = document.createElement("a");
      a.href = perRow;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Open screenshot";
      tdShot.appendChild(a);
    } else {
      tdShot.textContent = "—";
    }

    const tdStatus = document.createElement("td");
    tdStatus.textContent = String(r.status || "need to fix").trim();

    tr.append(tdId, tdType, tdDesc, tdShot, tdStatus);
    tbody.appendChild(tr);
  }

  section.classList.toggle("hidden", lastPreviewRows.length === 0);
  const dl = $("downloadIssuesCsv");
  if (dl) dl.disabled = lastPreviewRows.length === 0;
}

function isReportViewActive() {
  const v = $("viewReport");
  return !!(v && !v.classList.contains("hidden"));
}

function downloadIssuesCsv() {
  if (!lastPreviewRows.length) return;
  const header = [
    "ID",
    "type",
    "issue description",
    "screenshot link",
    "review status",
    "dev note",
  ];
  const lines = [header.map(escapeCsvCell).join(",")];
  for (const r of lastPreviewRows) {
    const shot = String(r.screenshotUrl || "").trim();
    const linkCol = shot || "";
    const typ = String(r.category || "").trim();
    const note = !shot ? "No screenshot URL — check IMGBB_API_KEY / GOOGLE_SHEET_WEBAPP_URL in background.js, or crop/upload failed" : "";
    lines.push(
      [r.id, typ, r.description, linkCol, String(r.status || "need to fix").trim(), note]
        .map(escapeCsvCell)
        .join(","),
    );
  }
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `figma-qa-issues-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  if (isReportViewActive()) {
    setQaDoneModal(false);
    void chrome.storage.local.set({ [STORAGE.openSetupNext]: true });
    showView("setup");
    // Let the download start before closing the popup (closing too early can cancel it).
    setTimeout(() => {
      try {
        window.close();
      } catch {
        /* ignore */
      }
    }, 250);
    return;
  }

  setQaDoneModal(true);
}

function setQaDoneModal(visible) {
  const modal = $("qaDoneModal");
  const btn = $("qaDoneDismiss");
  modal?.classList.toggle("hidden", !visible);
  modal?.setAttribute("aria-hidden", visible ? "false" : "true");
  if (visible) requestAnimationFrame(() => btn?.focus());
}

async function ensureHighlightShareLink() {
  if (!lastHighlightDataUrl || lastHighlightShareUrl || isUploadingHighlightLink) return;
  isUploadingHighlightLink = true;
  renderFailPreviewRows(lastPreviewRows);
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          type: "UPLOAD_HIGHLIGHT_LINK",
          dataUrl: lastHighlightDataUrl,
        },
        (r) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(r || null);
        },
      );
    });
    if (resp?.ok && resp.url) lastHighlightShareUrl = String(resp.url);
  } catch {
    /* keep local download fallback */
  } finally {
    isUploadingHighlightLink = false;
    renderFailPreviewRows(lastPreviewRows);
  }
}

// (Google Sheet send/test removed from UI)

function setQaProgress(visible, message) {
  const overlay = $("qaProgressOverlay");
  const label = $("qaProgressLabel");
  if (label && message) label.textContent = message;
  overlay?.classList.toggle("hidden", !visible);
  overlay?.setAttribute("aria-hidden", visible ? "false" : "true");
}

async function runCompare() {
  try {
    setCompareRunStatus("");
    resetFailPreview();
    await refreshFigmaTokenHint();
    if ($("wizardFigmaToken") && !$("wizardFigmaToken").value.trim() && figmaTokenResolvedHint) {
      $("wizardFigmaToken").value = figmaTokenResolvedHint;
    }
    await persistApiKeysNow();

    // Do not start compare while Phase 1 bootstrap is still running.
    const boot = await chrome.storage.local.get(STORAGE.bootstrapJob);
    const bootJob = boot[STORAGE.bootstrapJob] || null;
    if (bootJob?.status === "running") {
      setCompareRunStatus(`Figma cache is still building. Please wait… ${bootJob.step || ""}`.trim());
      return;
    }

    const { liveFigmaUrl, livePageUrl: livePageUrlResolved } = await resolveCompareSessionUrls();
    let livePageUrl = livePageUrlResolved;
    async function resolveToken() {
      let token = ($("wizardFigmaToken")?.value || "").trim();
      if (!token) token = figmaTokenResolvedHint;
      if (!token) {
        const st = await chrome.storage.local.get(STORAGE.figmaToken);
        token = (st[STORAGE.figmaToken] || "").trim();
      }
      return token;
    }
    let fkStore = await chrome.storage.local.get([STORAGE.figmaBootstrapFrame]);
    let frameKey = String(fkStore[STORAGE.figmaBootstrapFrame] || "").trim();
    let token = await resolveToken();
    if (!frameKey || !token) {
      const figmaUrl = liveFigmaUrl;
      if (figmaUrl && isLikelyFigmaUrl(figmaUrl) && token) {
        setQaProgress(true, "Saving Figma frame from your link (Phase 1)…");
        void pollBootstrapProgressUntilDone();
        const resp = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: "FIGMA_BOOTSTRAP_DESIGN", figmaUrl, figmaToken: token },
            (r) => resolve(r || null),
          );
        });
        setQaProgress(false, "");
        if (!resp?.ok) {
          setCompareRunStatus(resp?.error || "Figma setup failed. Try again in 60–90 seconds.");
          return;
        }
        fkStore = await chrome.storage.local.get([STORAGE.figmaBootstrapFrame]);
        frameKey = String(fkStore[STORAGE.figmaBootstrapFrame] || "").trim();
      }
    }
    if (!token) {
      setCompareRunStatus("Add your Figma personal access token in Phase 1.");
      return;
    }
    if (!frameKey) {
      setCompareRunStatus(
        "No Figma frame saved. In Phase 1, paste your Figma link (with ?node-id=…) and save or Refresh Figma cache — compare always downloads the frame from the Figma API (no stored preview image).",
      );
      return;
    }
    const enteredFkCompare = parseFigmaFrameKeyFromUrl(liveFigmaUrl);
    if (liveFigmaUrl && isLikelyFigmaUrl(liveFigmaUrl) && enteredFkCompare && frameKey && enteredFkCompare !== frameKey) {
      setCompareRunStatus(
        "Figma URL targets a different frame than cached — compare will sync the new frame from the API (see run notes in Report).",
      );
    }
    if (!livePageUrl || !isHttpUrl(livePageUrl)) {
      setCompareRunStatus("Open the webpage tab you want to compare (http/https), then click Run compare.");
      return;
    }
    setQaProgress(true, "Starting compare… (you can close this popup)");
    const targetTab = await getTabForSessionPageUrl(livePageUrl);

    const preCompareStorage = {
      [STORAGE.compareViewportWidth]: COMPARE_VIEWPORT_WIDTH,
      [STORAGE.responsiveQaPass]: false,
    };
    if (livePageUrl && isHttpUrl(livePageUrl)) {
      preCompareStorage[STORAGE.pageUrl] = livePageUrl;
    }
    await chrome.storage.local.set(preCompareStorage);

    // Service worker reads these keys for tab recovery + Figma URL fallback — mirror Phase 1 session before compare.
    const urlMirror = {};
    if (liveFigmaUrl) urlMirror[STORAGE.figmaUrl] = liveFigmaUrl;
    if (livePageUrl && isHttpUrl(livePageUrl)) urlMirror[STORAGE.pageUrl] = livePageUrl;
    if (Object.keys(urlMirror).length) await chrome.storage.local.set(urlMirror);

    /** @type {{ type: string, pageTabId: number, figmaUrl?: string, pageUrlExact?: string, figmaUrlExact?: string, compareWidths?: number[], compareViewportWidth?: number }} */
    const comparePayload = {
      type: "COMPARE_START",
      pageTabId: targetTab.id,
      figmaUrl: liveFigmaUrl,
      pageUrlExact: livePageUrl,
      figmaUrlExact: liveFigmaUrl,
    };
    comparePayload.compareViewportWidth = COMPARE_VIEWPORT_WIDTH;

    // Multi-tab compare is automatic in the service worker when ARIA tabs exist (no popup UI).
    // COMPARE_START returns immediately after the job is accepted — long work runs in the service worker
    // so the message channel does not stay open for minutes (avoids "message channel closed" errors).
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        comparePayload,
        (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!resp?.ok) reject(new Error(resp?.error || "Compare failed."));
          else resolve();
        },
      );
    });

    await sleep(120);
    await pollCompareJobUntilDone();
  } catch (e) {
    setQaProgress(false, "");
    setCompareRunStatus(e instanceof Error ? e.message : String(e));
  }
}

async function pollCompareJobUntilDone() {
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    const job = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "COMPARE_STATUS" }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(resp?.job || null);
      });
    });
    if (!job) return; // nothing running / nothing stored yet
    if (job?.status === "running") {
      setQaProgress(true, job.step || "Running…");
      await sleep(900);
      continue;
    }
    if (job?.status === "done") {
      setQaProgress(false, "");
      renderFailPreviewRows(job.issues || []);
      renderHighlightPreview(job.highlightDataUrl || "");
      showView("report");
      return;
    }
    if (job?.status === "error") {
      setQaProgress(false, "");
      setCompareRunStatus(job.error || "Compare failed.");
      showView("tools");
      return;
    }
    await sleep(900);
  }
  setQaProgress(false, "");
  setCompareRunStatus("Compare timed out after ~15 minutes. Try again.");
  showView("tools");
}

function parsePx(v) {
  const n = parseFloat(String(v || "").replace("px", ""));
  return Number.isFinite(n) ? n : null;
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

function pickPageSectionLabel(sec) {
  const heading = (sec.typographySamples || []).find((x) => x.role === "heading");
  const fromText = (heading?.textSample || sec.contentSample || "").trim();
  if (fromText) return fromText.slice(0, 48);
  const id = sec.id ? `#${sec.id}` : "";
  return `${sec.tag || "section"}${id}`;
}

function walkFigmaTextNodes(node, out = []) {
  if (!node) return out;
  // background.js stores compact Figma text style under `style` (not `typography`).
  if (node.type === "TEXT" && node.style?.fontSize) out.push(node);
  for (const c of node.children || []) walkFigmaTextNodes(c, out);
  return out;
}

function pickFigmaSectionNodes(figmaTree) {
  const kids = figmaTree?.children || [];
  return Array.isArray(kids) ? kids : [];
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

function buildStyleIssuesFromFigmaAndPage(figmaTree, pageData) {
  const figmaSections = pickFigmaSectionNodes(figmaTree);
  const pageSections = pageData?.sections || [];
  const n = Math.min(figmaSections.length, pageSections.length);
  const issues = [];

  for (let i = 0; i < n; i++) {
    const fs = figmaSections[i];
    const ps = pageSections[i];
    const sectionName = pickPageSectionLabel(ps) || fs?.name || `Section ${i + 1}`;

    const figText = pickRepresentativeFigmaText(fs);
    const pageSample = pickRepresentativePageSample(ps);
    if (!figText || !pageSample) continue;

    const figFont = figText.style?.fontSize ?? null;
    const pageFont = parsePx(pageSample.fontSize);
    if (Number.isFinite(figFont) && Number.isFinite(pageFont) && Math.abs(figFont - pageFont) >= 2) {
      issues.push({
        id: String(i + 1),
        description: `Font-size is different here in ${sectionName}.`,
        status: "need to fix",
      });
    }

    const figColor = figText.fillColor || null;
    const pageColor = parseCssRgb(pageSample.color);
    if (figColor && pageColor && rgbDist(figColor, pageColor) >= 28) {
      issues.push({
        id: `${i + 1}-c`,
        description: `Color seems mismatch here in ${sectionName}.`,
        status: "need to fix",
      });
    }
  }

  return issues;
}

function formatLocalStyleReport(issues) {
  if (!issues.length) return "PASS: No obvious font-size or color mismatches found in sampled sections.";
  return [
    `FAIL: Found ${issues.length} possible issue(s) (sample-based).`,
    "",
    ...issues.map((x) => `- ${x.description}`),
  ].join("\n");
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function stripUrlHash(u) {
  if (!u) return "";
  const i = u.indexOf("#");
  return i < 0 ? u : u.slice(0, i);
}

function urlsMatchSession(tUrl, sessionUrl) {
  try {
    const a = new URL(stripUrlHash(tUrl));
    const b = new URL(stripUrlHash(sessionUrl.trim()));
    const pa = a.pathname.replace(/\/$/, "") || "/";
    const pb = b.pathname.replace(/\/$/, "") || "/";
    return a.origin === b.origin && pa === pb && a.search === b.search;
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Page load timed out (60s). Check the webpage URL in Session setup."));
    }, 60000);
    function done() {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(id, info) {
      if (id === tabId && info.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === "complete") done();
    }).catch(() => {});
  });
}

/**
 * Session URL: reuse matching tab if open; otherwise open in the background (not mandatory to pre-open).
 */
async function getTabForSessionPageUrl(pageUrlRaw) {
  const pageUrl = (pageUrlRaw || "").trim();
  if (!pageUrl || !/^https?:/i.test(pageUrl)) {
    throw new Error("Add a valid http(s) webpage URL in Session setup.");
  }
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    throw new Error("Invalid webpage URL in session setup.");
  }

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id != null && active.url && /^https?:/i.test(active.url) && urlsMatchSession(active.url, pageUrl)) {
    return { id: active.id, windowId: active.windowId };
  }

  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  const exact = tabs.find((t) => t.url && urlsMatchSession(t.url, pageUrl));
  if (exact?.id != null) return { id: exact.id, windowId: exact.windowId };

  const created = await chrome.tabs.create({ url: pageUrl, active: false });
  if (created?.id == null) throw new Error("Could not open the webpage for capture.");
  await waitForTabComplete(created.id);
  const t = await chrome.tabs.get(created.id);
  return { id: t.id, windowId: t.windowId };
}

async function capturePageScreenshot(tabId, windowId) {
  return Promise.race([
    capturePageScreenshotInner(tabId, windowId),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Screenshot timed out (30s).")), 30000),
    ),
  ]);
}

async function capturePageScreenshotInner(tabId, windowId) {
  try {
    if (typeof chrome.tabs.captureTab === "function") {
      return await chrome.tabs.captureTab(tabId, { format: "png" });
    }
  } catch {
    /* fall back to visible capture */
  }
  await chrome.tabs.update(tabId, { active: true });
  await sleep(450);
  const w = windowId ?? (await chrome.tabs.get(tabId)).windowId;
  return chrome.tabs.captureVisibleTab(w, { format: "png" });
}

async function collectPageQaFromTab(tabId) {
  const msg = { type: "COLLECT_PAGE_QA" };
  try {
    return await sendMessageTimeout(tabId, msg, 45000);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (injErr) {
      throw new Error(
        `Cannot inject on this page (${injErr instanceof Error ? injErr.message : String(injErr)}). Open a normal http(s) site.`,
      );
    }
    return await sendMessageTimeout(tabId, msg, 45000);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function getWizardForm() {
  return {
    figmaUrl: $("wizardFigmaUrl")?.value.trim() || "",
    figmaToken: ($("wizardFigmaToken")?.value || "").trim(),
    pageUrl: $("wizardPageUrl")?.value.trim() || "",
  };
}

function validateWizardFormForAnalyze(w) {
  const urlOk = w.figmaUrl && isLikelyFigmaUrl(w.figmaUrl);
  const tokenOk = tokenOkForWizard(w);
  if (!snapshotReady && !(urlOk && tokenOk)) {
    return "Enter Figma frame URL and a token (or rely on a token already saved in this browser), then Save — or use upload if enabled.";
  }
  if (urlOk && !tokenOk && !snapshotReady) {
    return "Add your Figma token once (it is stored locally) or paste it again.";
  }
  return "";
}

function validateWizardFormForPhase2(w) {
  const setupErr = validateWizardFormForAnalyze(w);
  if (setupErr) return setupErr;
  // Webpage URL is only required to proceed to Phase 2 (compare); Analyze/Refresh should still work without it.
  if (!w.pageUrl || !isHttpUrl(w.pageUrl)) return "Enter a valid webpage URL (http or https).";
  return "";
}

function updateSaveEnabled() {
  const btn = $("saveSetup");
  if (!btn) return;
  const w = getWizardForm();
  const err = validateWizardFormForAnalyze(w);
  btn.disabled = !!err;
  updateRefreshFigmaBtnEnabled();
}

function updateRefreshFigmaBtnEnabled() {
  const btn = $("refreshFigmaDesign");
  if (!btn) return;
  const url = ($("wizardFigmaUrl")?.value || "").trim();
  const tok = ($("wizardFigmaToken")?.value || "").trim() || figmaTokenResolvedHint;
  btn.disabled = !(isLikelyFigmaUrl(url) && tok.length > 0);
}

function wireTools() {
  $("openPageBtn")?.addEventListener("click", async () => {
    const w = await loadWizardFromStorage();
    if (w.pageUrl && isHttpUrl(w.pageUrl)) await chrome.tabs.create({ url: w.pageUrl });
  });
  // $("openFigmaBtn")?.addEventListener("click", async () => {
  //   const w = await loadWizardFromStorage();
  //   if (w.figmaUrl && isLikelyFigmaUrl(w.figmaUrl)) await chrome.tabs.create({ url: w.figmaUrl });
  // });
  $("backToSetup")?.addEventListener("click", () => {
    showView("setup");
    prefillWizardFromStorage();
  });
  $("backToTools")?.addEventListener("click", () => showView("tools"));
  $("toPhase2FromSetup")?.addEventListener("click", async () => {
    const err = validateWizardFormForPhase2(getWizardForm());
    if (err) {
      setSetupStatus(err);
      return;
    }
    if (!snapshotReady) {
      setSetupStatus("Save setup first so your Figma link + token are stored (Phase 1).");
      return;
    }
    const enteredFk = parseFigmaFrameKeyFromUrl(getWizardForm().figmaUrl);
    const fkStore = await chrome.storage.local.get(STORAGE.figmaBootstrapFrame);
    const cachedFk = String(fkStore[STORAGE.figmaBootstrapFrame] || "").trim();
    if (enteredFk && cachedFk && enteredFk !== cachedFk) {
      setSetupStatus("Figma URL in the field is a different frame than what is cached. Click Analyze Figma page first.");
      return;
    }
    showView("tools");
  });
  $("toPhase3FromTools")?.addEventListener("click", () => showView("report"));

  $("runCompare")?.addEventListener("click", async (e) => {
    if (isQaRunning) return;
    const btn = e.target;
    btn.disabled = true;
    isQaRunning = true;
    try {
      await runCompare();
    } finally {
      btn.disabled = false;
      isQaRunning = false;
    }
  });
  $("downloadIssuesCsv")?.addEventListener("click", () => downloadIssuesCsv());
  $("qaDoneDismiss")?.addEventListener("click", () => setQaDoneModal(false));
  $("qaDoneModal")?.addEventListener("click", (ev) => {
    if (ev.target === $("qaDoneModal")) setQaDoneModal(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const modal = $("qaDoneModal");
    if (modal && !modal.classList.contains("hidden")) setQaDoneModal(false);
  });
  $("figmaSnapshotFile")?.addEventListener("change", async (e) => {
    const input = e.target;
    const file = input?.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await compressImageFileToDataUrl(file, 1280, 0.78);
      await chrome.storage.local.set({ [STORAGE.figmaSnapshotDataUrl]: dataUrl });
      await chrome.storage.local.remove([
        STORAGE.figmaTypographySnapshot,
        STORAGE.figmaBootstrapFrame,
        STORAGE.figmaDetectedExportWidth,
      ]);
      const st = $("figmaSnapshotStatus");
      if (st) {
        st.textContent =
          "Design image is ready (upload). Figma typography cache cleared — use URL+token if you need file fonts.";
      }
      await refreshSnapshotReady();
      updateSaveEnabled();
    } catch {
      const st = $("figmaSnapshotStatus");
      if (st) st.textContent = "Image is too large for storage. Try a smaller file.";
    } finally {
      if (input) input.value = "";
    }
  });
}

async function compressImageFileToDataUrl(file, maxWidth = 1280, quality = 0.78) {
  const src = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
  const scale = Math.min(1, maxWidth / Math.max(1, img.width));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}

async function loadLastCompareReportIfDone() {
  try {
    const data = await chrome.storage.local.get(STORAGE.compareJob);
    const job = data[STORAGE.compareJob] || null;
    if (job?.status === "done") {
      renderFailPreviewRows(job.issues || []);
    } else {
      lastPreviewRows = [];
      $("failPreviewTbody")?.replaceChildren();
      $("failPreviewSection")?.classList.add("hidden");
      const dl = $("downloadIssuesCsv");
      if (dl) dl.disabled = true;
    }
  } catch {
    lastPreviewRows = [];
    $("failPreviewTbody")?.replaceChildren();
    $("failPreviewSection")?.classList.add("hidden");
    const dl = $("downloadIssuesCsv");
    if (dl) dl.disabled = true;
  }
}

function showView(which) {
  $("viewSetup")?.classList.toggle("hidden", which !== "setup");
  $("viewTools")?.classList.toggle("hidden", which !== "tools");
  $("viewReport")?.classList.toggle("hidden", which !== "report");
  if (which === "tools") {
    loadApiKeysIntoFields();
  }
  if (which === "report") {
    void loadLastCompareReportIfDone();
  }
}

function prefillWizardFromStorage() {
  Promise.all([loadWizardFromStorage(), chrome.storage.local.get(STORAGE.figmaToken)]).then(([w, tokData]) => {
    if ($("wizardFigmaUrl")) $("wizardFigmaUrl").value = w.figmaUrl || "";
    figmaTokenResolvedHint = (tokData[STORAGE.figmaToken] || "").trim();
    if ($("wizardFigmaToken")) $("wizardFigmaToken").value = figmaTokenResolvedHint;
    if ($("wizardPageUrl")) $("wizardPageUrl").value = w.pageUrl;
    if (figmaTokenResolvedHint) {
      void chrome.storage.local.set({ [STORAGE.figmaToken]: figmaTokenResolvedHint });
    }
    void refreshSnapshotReady();
    updateSaveEnabled();
  });
}

async function pollBootstrapProgressUntilDone(maxMs = 15 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const s = await chrome.storage.local.get(STORAGE.bootstrapJob);
    const job = s[STORAGE.bootstrapJob] || null;
    if (!job) {
      await sleep(250);
      continue;
    }
    if (job.status === "running") {
      if (job.step) setSetupStatus(String(job.step));
      await sleep(500);
      continue;
    }
    if (job.status === "error") {
      if (job.error) setSetupStatus(String(job.error));
      return;
    }
    if (job.status === "done") {
      return;
    }
    await sleep(500);
  }
}

function wireWizard() {
  ["wizardFigmaUrl", "wizardPageUrl"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", () => {
      setSetupStatus("");
      updateSaveEnabled();
      scheduleWizardDraftSave();
    });
    el.addEventListener("change", () => {
      updateSaveEnabled();
      scheduleWizardDraftSave();
    });
    el.addEventListener("blur", () => persistWizardDraftNow());
  });
  $("wizardFigmaToken")?.addEventListener("input", () => {
    setSetupStatus("");
    const t = ($("wizardFigmaToken")?.value || "").trim();
    if (t) figmaTokenResolvedHint = t;
    else void refreshFigmaTokenHint().then(() => updateSaveEnabled());
    updateSaveEnabled();
    scheduleWizardDraftSave();
    scheduleApiKeySave();
  });
  $("wizardFigmaToken")?.addEventListener("blur", () => {
    void persistApiKeysNow();
    persistWizardDraftNow();
  });
  $("saveSetup")?.addEventListener("click", async () => {
    const w = getWizardForm();
    await refreshFigmaTokenHint();
    const err = validateWizardFormForAnalyze(w);
    if (err) {
      setSetupStatus(err);
      return;
    }
    setSetupStatus("");
    let token = (w.figmaToken || ($("wizardFigmaToken")?.value || "").trim());
    if (!token) token = figmaTokenResolvedHint;
    if (!token) {
      const st = await chrome.storage.local.get(STORAGE.figmaToken);
      token = (st[STORAGE.figmaToken] || "").trim();
    }
    if (token) {
      await chrome.storage.local.set({ [STORAGE.figmaToken]: token });
      figmaTokenResolvedHint = token;
    }

    const cacheMeta = await chrome.storage.local.get([STORAGE.figmaBootstrapFrame, STORAGE.figmaTypographySnapshot]);
    const cachedFrameKey = String(cacheMeta[STORAGE.figmaBootstrapFrame] || "").trim();
    const hasTypoCache = String(cacheMeta[STORAGE.figmaTypographySnapshot] || "").length >= 50;
    const wantsFigma = w.figmaUrl && isLikelyFigmaUrl(w.figmaUrl) && token;
    const enteredFrameKey = parseFigmaFrameKeyFromUrl(w.figmaUrl);

    // Need a full bootstrap when cache is incomplete OR when the link points at a different frame than what is cached.
    // (Previously we only warned on mismatch and still used the old frame — compares were wrong for the new URL.)
    const cacheComplete = hasTypoCache && !!cachedFrameKey;
    const frameMismatch = !!(enteredFrameKey && cachedFrameKey && enteredFrameKey !== cachedFrameKey);
    const needBootstrap = !cacheComplete || frameMismatch;

    if (needBootstrap) {
      if (!wantsFigma) {
        setSetupStatus(
          frameMismatch
            ? "This Figma link is a different frame than what is cached. Add your token and click Analyze Figma page again, or use Refresh Figma cache."
            : "Missing cached design/typography. Enter Figma frame URL + token and click Analyze Figma page.",
        );
        return;
      }
      setSetupStatus(
        frameMismatch
          ? "Figma frame changed — fetching typography and measuring export for this link…"
          : "Fetching from Figma once (typography + frame size)…",
      );
      void pollBootstrapProgressUntilDone();
      const resp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: "FIGMA_BOOTSTRAP_DESIGN", figmaUrl: w.figmaUrl, figmaToken: token },
          (r) => resolve(r || null),
        );
      });
      if (!resp?.ok) {
        setSetupStatus(resp?.error || "Figma fetch failed.");
        return;
      }
      await refreshSnapshotReady();
      await loadApiKeysIntoFields();
      // Hard verification: do not proceed unless both image + typography caches were actually saved.
      const post = await chrome.storage.local.get([
        STORAGE.figmaTypographySnapshot,
        STORAGE.figmaBootstrapFrame,
      ]);
      const postTypo = String(post[STORAGE.figmaTypographySnapshot] || "");
      const postKey = String(post[STORAGE.figmaBootstrapFrame] || "").trim();
      if (postTypo.length < 50 || !postKey) {
        setSetupStatus(
          "Figma setup did not save correctly (typography or frame id missing). Please retry Refresh Figma cache once.",
        );
        return;
      }
      if (enteredFrameKey && postKey !== enteredFrameKey) {
        setSetupStatus(
          "Saved frame id does not match your link (check ?node-id=…). Compare would use the wrong design — fix the URL and try again.",
        );
        return;
      }
    }

    // At this point cache matches the pasted Figma frame (or upload path elsewhere).

    await saveWizard({
      figmaUrl: w.figmaUrl,
      pageUrl: w.pageUrl,
    });
    await loadApiKeysIntoFields();
    showView("tools");
  });

  $("refreshFigmaDesign")?.addEventListener("click", async () => {
    setSetupStatus("");
    await refreshFigmaTokenHint();
    updateRefreshFigmaBtnEnabled();
    const figmaUrl = ($("wizardFigmaUrl")?.value || "").trim();
    let token = ($("wizardFigmaToken")?.value || "").trim();
    if (!token) token = figmaTokenResolvedHint;
    if (!token) {
      const st = await chrome.storage.local.get(STORAGE.figmaToken);
      token = (st[STORAGE.figmaToken] || "").trim();
    }
    if (!figmaUrl || !isLikelyFigmaUrl(figmaUrl)) {
      setSetupStatus("Enter a valid Figma frame URL first.");
      return;
    }
    if (!token) {
      setSetupStatus("Enter your Figma token (or save it once).");
      return;
    }

    // Avoid running refresh while a compare is running (they compete for time/resources and cause timeouts).
    try {
      const job = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "COMPARE_STATUS" }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(resp?.job || null);
        });
      });
      if (job?.status === "running") {
        setSetupStatus(`Compare is running right now (${job.step || "Running…"}). Please wait for it to finish, then refresh Figma cache.`);
        return;
      }
    } catch {
      // If status can't be read, proceed (background will still guard).
    }
    setSetupStatus("Refreshing Figma from API…");
    void pollBootstrapProgressUntilDone();
    const resp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "FIGMA_BOOTSTRAP_DESIGN", figmaUrl, figmaToken: token },
        (r) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(r || null);
        },
      );
    });
    if (!resp?.ok) {
      setSetupStatus(resp?.error || "Refresh failed.");
      return;
    }
    if (token) {
      figmaTokenResolvedHint = token;
      await chrome.storage.local.set({ [STORAGE.figmaToken]: token });
    }
    await refreshSnapshotReady();
    await loadApiKeysIntoFields();
    updateSaveEnabled();
    // Hard verification: do not claim success unless both image + typography + frame key are actually saved.
    const post = await chrome.storage.local.get([
      STORAGE.figmaTypographySnapshot,
      STORAGE.figmaBootstrapFrame,
    ]);
    const postTypo = String(post[STORAGE.figmaTypographySnapshot] || "");
    const postKey = String(post[STORAGE.figmaBootstrapFrame] || "");
    if (postTypo.length < 50 || !postKey.trim()) {
      setSetupStatus(
        "Refresh finished, but typography or frame id is still incomplete. Please retry Refresh Figma cache once.",
      );
      return;
    }

    setSetupStatus(
      resp.detectedExportWidth
        ? `Frame + typography updated (export width ${resp.detectedExportWidth}px). No preview image is stored — compare uses the API each run.`
        : "Frame + typography updated. No preview image is stored — compare uses the API each run.",
    );
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  wireWizard();
  wireTools();
  // If a compare is already running (or finished), show its latest status.
  void pollCompareJobUntilDone();
  await refreshSnapshotReady();
  const saved = await loadWizardFromStorage();
  const draft = await loadWizardDraft();
  await refreshFigmaTokenHint();
  if ($("wizardFigmaToken")) $("wizardFigmaToken").value = figmaTokenResolvedHint;
  if (figmaTokenResolvedHint) {
    await chrome.storage.local.set({ [STORAGE.figmaToken]: figmaTokenResolvedHint });
  }

  if (!saved.setupComplete && draft) {
    if ($("wizardFigmaUrl")) $("wizardFigmaUrl").value = draft.figmaUrl || "";
    if ($("wizardPageUrl")) $("wizardPageUrl").value = draft.pageUrl || "";
  } else {
    if ($("wizardFigmaUrl")) $("wizardFigmaUrl").value = saved.figmaUrl || "";
    if ($("wizardPageUrl")) $("wizardPageUrl").value = saved.pageUrl;
  }
  try {
    const tab = await getActiveTab();
    const u = tab?.url || "";
    if (/^https?:/i.test(u) && !$("wizardPageUrl")?.value.trim()) {
      $("wizardPageUrl").value = u;
    }
  } catch {
    /* ignore */
  }
  updateSaveEnabled();
  const openSetupFlag = await chrome.storage.local.get(STORAGE.openSetupNext);
  if (openSetupFlag[STORAGE.openSetupNext]) {
    await chrome.storage.local.remove(STORAGE.openSetupNext);
    showView("setup");
  } else if (saved.setupComplete && saved.pageUrl && snapshotReady) {
    showView("tools");
  } else {
    showView("setup");
  }
  await loadApiKeysIntoFields();
});
