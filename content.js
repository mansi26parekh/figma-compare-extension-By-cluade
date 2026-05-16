(function () {
  if (globalThis.__figmaCompareExtInit) return;
  globalThis.__figmaCompareExtInit = true;

  /**
   * LOCKED: compare/capture relies on COLLECT_PAGE_QA, GET_PAGE_SCROLL_METRICS, SCROLL_PAGE_Y; background may call capture twice (viewport diff + full-page thumbnails) (see LOCKED_SURFACE.md).
   * Overlay message types are separate; do not merge or rename without updating background + manifest commands.
   */

  const OVERLAY_ID = "figma-compare-extension-root";
  const STORAGE_KEY = "figmaCompareState";

  let state = {
    visible: false,
    imageSrc: "",
    opacity: 0.45,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    blendMode: "normal",
    invert: false,
  };

  function loadState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (data) => {
        if (data[STORAGE_KEY]) Object.assign(state, data[STORAGE_KEY]);
        resolve();
      });
    });
  }

  function saveState() {
    chrome.storage.local.set({
      [STORAGE_KEY]: {
        imageSrc: state.imageSrc,
        opacity: state.opacity,
        scale: state.scale,
        offsetX: state.offsetX,
        offsetY: state.offsetY,
        blendMode: state.blendMode,
        invert: state.invert,
      },
    });
  }

  function ensureRoot() {
    let root = document.getElementById(OVERLAY_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = OVERLAY_ID;
    root.setAttribute("data-figma-compare", "true");
    root.innerHTML = `
    <div class="fce-backdrop" aria-hidden="true"></div>
    <div class="fce-frame">
      <img class="fce-img" alt="" draggable="false" />
    </div>
  `;

    const style = document.createElement("style");
    style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      pointer-events: none;
      overflow: hidden;
      isolation: isolate;
    }
    #${OVERLAY_ID}.fce-interactive {
      pointer-events: auto;
    }
    #${OVERLAY_ID} .fce-backdrop {
      position: absolute;
      inset: 0;
      background: transparent;
    }
    #${OVERLAY_ID} .fce-frame {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%) translate(var(--fce-x, 0px), var(--fce-y, 0px)) scale(var(--fce-s, 1));
      transform-origin: center center;
      max-width: none;
      max-height: none;
    }
    #${OVERLAY_ID} .fce-img {
      display: block;
      max-width: 100vw;
      max-height: 100vh;
      width: auto;
      height: auto;
      user-select: none;
      -webkit-user-drag: none;
    }
  `;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(root);
    return root;
  }

  function applyToDom() {
    const root = ensureRoot();
    const img = root.querySelector(".fce-img");

    root.style.display = state.visible && state.imageSrc ? "block" : "none";
    if (!state.imageSrc) return;

    img.src = state.imageSrc;
    img.style.opacity = String(state.opacity);
    img.style.mixBlendMode = state.blendMode === "difference" ? "difference" : "normal";
    img.style.filter = state.invert ? "invert(1)" : "";

    root.style.setProperty("--fce-x", `${state.offsetX}px`);
    root.style.setProperty("--fce-y", `${state.offsetY}px`);
    root.style.setProperty("--fce-s", String(state.scale));
  }

  function setInteractive(on) {
    const root = document.getElementById(OVERLAY_ID);
    if (!root) return;
    root.classList.toggle("fce-interactive", !!on);
  }

  function collectFaviconInfo() {
    const links = [
      ...document.querySelectorAll('link[rel*="icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"]'),
    ].map((l) => ({
      rel: l.getAttribute("rel") || "",
      href: l.href || l.getAttribute("href") || "",
    }));
    return {
      hasExplicitIconLink: links.length > 0,
      links: links.slice(0, 8),
      note:
        "Browsers may still request /favicon.ico even without a link tag; this only reports tags in the document.",
    };
  }

  function findSectionElements(limit = 45) {
    const seen = new Set();
    const selectors = ["main section", "section", "article", '[role="region"]', "main > article", "body > section"];
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.closest(`#${OVERLAY_ID}`)) return;
          const r = el.getBoundingClientRect();
          if (r.height < 8 && el.innerText.trim().length < 5) return;
          seen.add(el);
        });
      } catch {
        /* ignore invalid selectors */
      }
    }
    let list = [...seen];
    if (list.length === 0) {
      const main = document.querySelector("main") || document.body;
      if (main) {
        list = [...main.children].filter((el) => {
          if (el.closest(`#${OVERLAY_ID}`)) return false;
          const t = el.tagName;
          if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT") return false;
          return el.offsetHeight > 0 || el.getBoundingClientRect().height > 0;
        });
      }
    }
    list.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
    return list.slice(0, Math.max(1, Math.min(45, limit)));
  }

  function sampleTypography(el) {
    const samples = [];
    const pick = (node, role) => {
      if (!node) return;
      const cs = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      const rectDoc = {
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      };
      samples.push({
        role,
        tag: node.tagName.toLowerCase(),
        rectDoc,
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily,
        fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        textSample: (node.innerText || "").trim().replace(/\s+/g, " ").slice(0, 240),
      });
    };

    // Prefer representative visible text nodes, not just the first DOM match.
    // This reduces mismatched issue descriptions (wrong text block sampled inside a section).
    try {
      const headings = [...el.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter((n) => visibleNonOverlay(n))
        .map((n) => ({ n, t: (n.innerText || "").trim().replace(/\s+/g, " ").slice(0, 240) }))
        .filter((x) => x.t.length >= 2);
      headings.sort((a, b) => {
        const fa = parseFloat(getComputedStyle(a.n).fontSize) || 0;
        const fb = parseFloat(getComputedStyle(b.n).fontSize) || 0;
        if (fb !== fa) return fb - fa;
        return a.n.getBoundingClientRect().top - b.n.getBoundingClientRect().top;
      });
      for (const h of headings.slice(0, 2)) pick(h.n, "heading");
    } catch {
      /* ignore */
    }

    try {
      const paras = [...el.querySelectorAll("p")]
        .filter((n) => visibleNonOverlay(n))
        .map((n) => ({ n, t: (n.innerText || "").trim().replace(/\s+/g, " ").slice(0, 240) }))
        .filter((x) => x.t.length >= 8);
      paras.sort((a, b) => {
        // Prefer more informative paragraphs first.
        if (b.t.length !== a.t.length) return b.t.length - a.t.length;
        const fa = parseFloat(getComputedStyle(a.n).fontSize) || 0;
        const fb = parseFloat(getComputedStyle(b.n).fontSize) || 0;
        if (fb !== fa) return fb - fa;
        return a.n.getBoundingClientRect().top - b.n.getBoundingClientRect().top;
      });
      for (const p of paras.slice(0, 2)) pick(p.n, "paragraph");
    } catch {
      /* ignore */
    }

    if (samples.length === 0) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const rectDoc = {
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      };
      samples.push({
        role: "container",
        tag: el.tagName.toLowerCase(),
        rectDoc,
        color: cs.color,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontFamily: cs.fontFamily,
        fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        textSample: (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 240),
      });
    }
    return samples;
  }

  function measureVerticalGapsBetweenDirectChildren(el) {
    const kids = [...el.children].filter((c) => {
      const t = c.tagName;
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT") return false;
      if (c.closest(`#${OVERLAY_ID}`)) return false;
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const gaps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect();
      const b = kids[i + 1].getBoundingClientRect();
      gaps.push(Math.round(Math.max(0, b.top - a.bottom) * 10) / 10);
    }
    return gaps.slice(0, 16);
  }

  function detectBrowserChallengePage() {
    const title = String(document.title || "").toLowerCase();
    const bodySnippet = String(document.body?.innerText || "")
      .slice(0, 4500)
      .toLowerCase();
    try {
      if (
        document.querySelector(
          '#challenge-form, #challenge-stage, #cf-challenge-running, .cf-browser-verification, [name="cf-turnstile-response"], .cf-turnstile',
        ) ||
        document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="recaptcha"]',
        )
      ) {
        return { likely: true, reason: "A browser / bot check (Cloudflare or similar) is active on this tab." };
      }
    } catch {
      /* ignore */
    }
    if (/just a moment…|just a moment\.|attention required|verify you are human|checking your browser|verifying your browser|enable javascript and cookies|ddos-guard|checking if the site connection is secure/.test(title)) {
      return { likely: true, reason: "The page title looks like a temporary verification or block screen." };
    }
    if (
      bodySnippet.length < 1800 &&
      /verify your browser|verifying your browser|checking your browser|verify you are human|ray id|cloudflare|turnstile|one more step|please wait|ddos-guard/.test(bodySnippet)
    ) {
      return { likely: true, reason: "The visible text looks like a browser verification page, not the real site content." };
    }
    return { likely: false, reason: "" };
  }

  function isChallengeOnlySection(contentFull) {
    const t = String(contentFull || "").toLowerCase();
    if (t.length > 900) return false;
    return /verify your browser|verifying your browser|checking your browser|verify you are human|one more step|ray id|cloudflare|just a moment|ddos-guard|turnstile/.test(t);
  }

  function rectDocFromEl(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return {
      left: r.left + window.scrollX,
      top: r.top + window.scrollY,
      width: Math.max(4, r.width),
      height: Math.max(4, r.height),
    };
  }

  function visibleNonOverlay(el) {
    if (!el || el.closest?.(`#${OVERLAY_ID}`)) return false;
    let cur = el;
    for (let d = 0; d < 8 && cur; d++) {
      if (cur.closest?.(`#${OVERLAY_ID}`)) return false;
      const cs = getComputedStyle(cur);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
      cur = cur.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }

  /** Light DOM checks for CSV/report (not a full QA suite). */
  function collectFunctionalFindings() {
    const out = [];
    const push = (description, el) => {
      const rd = el ? rectDocFromEl(el) : null;
      if (!rd) return;
      out.push({ description: String(description).slice(0, 220), rectDoc: rd });
    };
    const maxTotal = 14;

    /** Weak / script-only href checks removed — team QA focuses on copy vs design (top-to-bottom); `#` / `javascript:` anchors are not reported here. */

    /** Aligns with project QA rule: prefer `mailto:` / `tel:` on obvious contact links. */
    try {
      const anchorsContact = document.querySelectorAll("a[href]");
      const looksLikeEmailText = (t) => /^[^\s<>]{1,80}@[^\s<>]+\.[^\s<>]+$/.test(String(t || "").trim());
      const looksLikePhoneText = (t) => {
        const s = String(t || "").trim();
        if (s.length < 8 || s.length > 28) return false;
        const digits = s.replace(/\D/g, "");
        return digits.length >= 10 && digits.length <= 15 && /^[\d\s\-+()./ext]+$/i.test(s);
      };
      let mailHints = 0;
      let telHints = 0;
      for (const a of anchorsContact) {
        if (out.length >= maxTotal) break;
        if (!visibleNonOverlay(a)) continue;
        const href = (a.getAttribute("href") || "").trim();
        const hlow = href.toLowerCase();
        const text = (a.textContent || "").trim().replace(/\s+/g, " ");
        if (looksLikeEmailText(text) && !hlow.startsWith("mailto:")) {
          if (mailHints >= 3) continue;
          mailHints++;
          push(`Email-style link should use mailto: — "${text.slice(0, 48)}".`, a);
        } else if (looksLikePhoneText(text) && href && !hlow.startsWith("tel:") && !hlow.startsWith("mailto:")) {
          if (telHints >= 3) continue;
          telHints++;
          push(`Phone-style link should use tel: — "${text.slice(0, 28)}".`, a);
        }
      }
    } catch {
      /* ignore */
    }

    try {
      const h1s = document.querySelectorAll("h1");
      const visH1 = [];
      for (const h of h1s) {
        if (visibleNonOverlay(h)) visH1.push(h);
      }
      if (visH1.length > 1 && out.length < maxTotal) {
        push(`More than one visible H1 (${visH1.length}) — check heading hierarchy vs design.`, visH1[1]);
      }
    } catch {
      /* ignore */
    }

    try {
      let unlabeled = 0;
      const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])');
      for (const inp of inputs) {
        if (out.length >= maxTotal) break;
        if (!visibleNonOverlay(inp)) continue;
        const id = inp.id;
        const aria = inp.getAttribute("aria-label");
        const ph = (inp.getAttribute("placeholder") || "").trim();
        let hasLabel = false;
        if (id) {
          try {
            const esc = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            hasLabel = !!document.querySelector(`label[for="${esc}"]`);
          } catch {
            hasLabel = false;
          }
        }
        if (!aria && !ph && !hasLabel) {
          if (unlabeled >= 4) continue;
          unlabeled++;
          push(`Form control may lack a visible label, placeholder, or aria-label (input type “${inp.type || "text"}”).`, inp);
        }
      }
    } catch {
      /* ignore */
    }

    try {
      let nakedBtn = 0;
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        if (out.length >= maxTotal) break;
        if (!visibleNonOverlay(btn)) continue;
        const txt = (btn.textContent || "").trim();
        const aria = (btn.getAttribute("aria-label") || "").trim();
        const title = (btn.getAttribute("title") || "").trim();
        if (!txt && !aria && !title) {
          if (nakedBtn >= 4) continue;
          nakedBtn++;
          push(`Button or control may have no visible text or accessible name.`, btn);
        }
      }
    } catch {
      /* ignore */
    }

    return out.slice(0, maxTotal);
  }

  /** Lightweight image-quality checks (blur/low-res/stretched/object-fit). */
  function collectImageFindings() {
    const out = [];
    const maxTotal = 14;
    const dpr = Number(window.devicePixelRatio) || 1;

    const push = (description, el, sectionEl = null) => {
      const rd = el ? rectDocFromEl(el) : null;
      if (!rd) return;
      const secRd = sectionEl ? rectDocFromEl(sectionEl) : null;
      const sectionRectDoc = secRd || null;
      out.push({ description: String(description).slice(0, 220), rectDoc: rd });
      if (sectionRectDoc) out[out.length - 1].sectionRectDoc = sectionRectDoc;
    };

    const imgs = [...document.querySelectorAll("img")];
    for (const img of imgs) {
      if (out.length >= maxTotal) break;
      if (!visibleNonOverlay(img)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;

      const sectionEl =
        img.closest("section, article, [role='region'], main") ||
        img.parentElement ||
        null;
      const cs = getComputedStyle(img);
      const filter = String(cs.filter || "").toLowerCase();
      if (filter.includes("blur(")) {
        push(`Image has CSS blur filter applied (${cs.filter}).`, img, sectionEl);
        continue;
      }

      const nw = Number(img.naturalWidth) || 0;
      const nh = Number(img.naturalHeight) || 0;
      const needW = r.width * dpr;
      const needH = r.height * dpr;
      if (nw > 0 && nh > 0) {
        const tooSmall = nw < needW * 0.8 || nh < needH * 0.8;
        if (tooSmall) {
          push(
            `Image may look blurry (source ${nw}×${nh} px, rendered ~${Math.round(needW)}×${Math.round(needH)} px @dpr ${dpr}).`,
            img,
            sectionEl,
          );
          continue;
        }
      }

      const objectFit = String(cs.objectFit || "").toLowerCase();
      if (objectFit && objectFit !== "fill" && objectFit !== "none") {
        const arRender = r.width / Math.max(1, r.height);
        const arNat = nw && nh ? nw / nh : 0;
        if (arNat > 0 && Math.abs(Math.log(arRender / arNat)) > 0.35) {
          push(
            `Image aspect ratio differs (natural ${nw}×${nh}, rendered ${Math.round(r.width)}×${Math.round(r.height)}; object-fit: ${cs.objectFit}).`,
            img,
            sectionEl,
          );
          continue;
        }
      }
    }

    return out.slice(0, maxTotal);
  }

  /**
   * measureSectionSpacing — accurate padding/gap measurement that works whether
   * or not the designer used Figma auto-layout.
   *
   * Strategy:
   *   1. CSS computed padding  — getComputedStyle(el).paddingTop etc. This is
   *      accurate for sections that have explicit CSS padding. Always collected.
   *
   *   2. Geometric inner gap  — the visible gap between the section's bounding
   *      box edge and the nearest rendered child's bounding box edge.
   *      This catches sections whose "padding" is implemented via margin, min-height,
   *      or negative margins on children, which getComputedStyle misses.
   *      We measure: firstChildGapTop, lastChildGapBottom, firstChildGapLeft,
   *      lastChildGapRight.
   *
   *   3. Best-value padding   — for each side, we pick whichever of (1) or (2)
   *      is larger, because Figma measures from the frame edge to the first
   *      visible content, not just the CSS padding box.
   *
   * All values are in CSS pixels (layout pixels, not device pixels).
   * Security: all computation is local in the page's JS context — nothing leaves the browser.
   */
  function measureSectionSpacing(el) {
    const cs = getComputedStyle(el);
    const boxSizing = cs.boxSizing;

    // CSS computed padding (may be 0 even when visual space exists)
    const cssPT = parseFloat(cs.paddingTop) || 0;
    const cssPB = parseFloat(cs.paddingBottom) || 0;
    const cssPL = parseFloat(cs.paddingLeft) || 0;
    const cssPR = parseFloat(cs.paddingRight) || 0;

    // Geometric measurement: find first/last visible direct child
    const elRect = el.getBoundingClientRect();
    const elTop = elRect.top + window.scrollY;
    const elBottom = elRect.bottom + window.scrollY;
    const elLeft = elRect.left + window.scrollX;
    const elRight = elRect.right + window.scrollX;

    let geoTop = null;
    let geoBottom = null;
    let geoLeft = null;
    let geoRight = null;

    const directChildren = [...el.children].filter((c) => {
      const t = c.tagName;
      if (t === "SCRIPT" || t === "STYLE" || t === "NOSCRIPT") return false;
      if (c.closest(`#${OVERLAY_ID}`)) return false;
      // Skip absolutely/fixed positioned children — they don't contribute to flow padding
      const pos = getComputedStyle(c).position;
      if (pos === "absolute" || pos === "fixed") return false;
      const r = c.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });

    if (directChildren.length > 0) {
      // Top: gap from section top to first child top
      const firstChild = directChildren[0];
      const firstR = firstChild.getBoundingClientRect();
      const firstTop = firstR.top + window.scrollY;
      geoTop = Math.max(0, Math.round(firstTop - elTop));

      // Bottom: gap from last child bottom to section bottom
      const lastChild = directChildren[directChildren.length - 1];
      const lastR = lastChild.getBoundingClientRect();
      const lastBottom = lastR.bottom + window.scrollY;
      geoBottom = Math.max(0, Math.round(elBottom - lastBottom));

      // Left: gap from section left to leftmost child left
      let minChildLeft = Infinity;
      let maxChildRight = -Infinity;
      for (const child of directChildren) {
        const cr = child.getBoundingClientRect();
        const cLeft = cr.left + window.scrollX;
        const cRight = cr.right + window.scrollX;
        if (cLeft < minChildLeft) minChildLeft = cLeft;
        if (cRight > maxChildRight) maxChildRight = cRight;
      }
      if (minChildLeft !== Infinity) geoLeft = Math.max(0, Math.round(minChildLeft - elLeft));
      if (maxChildRight !== -Infinity) geoRight = Math.max(0, Math.round(elRight - maxChildRight));
    }

    // Best-value: for each side, take the larger of CSS and geometric.
    // This matches how Figma measures — from frame edge to visible content edge.
    const bestTop = geoTop !== null ? Math.max(cssPT, geoTop) : cssPT;
    const bestBottom = geoBottom !== null ? Math.max(cssPB, geoBottom) : cssPB;
    const bestLeft = geoLeft !== null ? Math.max(cssPL, geoLeft) : cssPL;
    const bestRight = geoRight !== null ? Math.max(cssPR, geoRight) : cssPR;

    return {
      // CSS computed values (raw)
      css: {
        top: cs.paddingTop,
        right: cs.paddingRight,
        bottom: cs.paddingBottom,
        left: cs.paddingLeft,
      },
      // Geometric measured values (from child bounding boxes)
      geo: {
        top: geoTop !== null ? `${geoTop}px` : null,
        right: geoRight !== null ? `${geoRight}px` : null,
        bottom: geoBottom !== null ? `${geoBottom}px` : null,
        left: geoLeft !== null ? `${geoLeft}px` : null,
      },
      // Best-value (what background.js should compare against Figma)
      // These are the numbers buildSpacingIssues() uses via ps.padding.*
      top: `${bestTop}px`,
      right: `${bestRight}px`,
      bottom: `${bestBottom}px`,
      left: `${bestLeft}px`,
      boxSizing,
    };
  }

  function collectPageQaData(opts = {}) {
    const limitSections = Number.isFinite(opts.limitSections) ? Math.max(1, Math.floor(opts.limitSections)) : 45;
    const favicon = collectFaviconInfo();
    const challenge = detectBrowserChallengePage();
    const sectionEls = findSectionElements(limitSections);
    let sections = sectionEls.map((el, index) => {
      const cs = getComputedStyle(el);
      const contentFull = (el.innerText || "").trim().replace(/\s+/g, " ");
      const r = el.getBoundingClientRect();
      const rectDoc = {
        top: r.top + window.scrollY,
        left: r.left + window.scrollX,
        width: r.width,
        height: r.height,
      };
      return {
        index,
        order: index + 1,
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        rectDoc,
        className: typeof el.className === "string" ? el.className.slice(0, 160) : null,
        // padding: measured using the improved measureSectionSpacing() above.
        // background.js reads ps.padding.top / .bottom / .left / .right (the best-value strings).
        padding: measureSectionSpacing(el),
        margin: {
          top: cs.marginTop,
          right: cs.marginRight,
          bottom: cs.marginBottom,
          left: cs.marginLeft,
        },
        layout: {
          display: cs.display,
          flexDirection: cs.flexDirection,
          justifyContent: cs.justifyContent,
          alignItems: cs.alignItems,
          gap: cs.gap,
          rowGap: cs.rowGap,
          columnGap: cs.columnGap,
        },
        verticalGapsBetweenDirectChildrenPx: measureVerticalGapsBetweenDirectChildren(el),
        boxSizing: cs.boxSizing,
        typographySamples: sampleTypography(el),
        contentSample: contentFull.slice(0, 900),
      };
    });

    if (!challenge.likely) {
      sections = sections.filter((s) => !isChallengeOnlySection(s.contentSample));
    }
    sections = sections.map((s, i) => ({ ...s, index: i, order: i + 1 }));

    const betweenSectionGapsPx = [];
    for (let i = 0; i < sections.length - 1; i++) {
      const ra = sections[i].rectDoc;
      const rb = sections[i + 1].rectDoc;
      betweenSectionGapsPx.push(Math.round(Math.max(0, rb.top - ra.top - ra.height) * 10) / 10);
    }

    return {
      pageUrl: location.href,
      pageTitle: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      favicon,
      betweenSectionGapsPx,
      sectionCount: sections.length,
      pageSignals: {
        browserChallengeLikely: challenge.likely,
        browserChallengeReason: challenge.reason || "",
      },
      functionalFindings: collectFunctionalFindings(),
      imageFindings: collectImageFindings(),
      sections,
    };
  }

  function tabElementVisible(el) {
    if (!el || el.closest(`#${OVERLAY_ID}`)) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    return r.width > 0 && r.height > 0;
  }

  /** ARIA tablists / tabs only (custom tabs without roles are not auto-detected). */
  function getTabElements() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('[role="tablist"]').forEach((tablist) => {
      if (tablist.closest(`#${OVERLAY_ID}`)) return;
      tablist.querySelectorAll(":scope > [role=\"tab\"], :scope [role=\"tab\"]").forEach((el) => {
        if (!tabElementVisible(el) || seen.has(el)) return;
        seen.add(el);
        out.push(el);
      });
    });
    if (!out.length) {
      document.querySelectorAll('button[role="tab"], a[role="tab"]').forEach((el) => {
        if (!tabElementVisible(el) || seen.has(el)) return;
        seen.add(el);
        out.push(el);
      });
    }
    return out;
  }

  /** Map a point on the stitched full-page bitmap to approximate document coordinates. */
  function stitchedPointToDoc(ix, iy, iw, ih, scrollW, scrollH, segments) {
    const sw = Math.max(1, Number(scrollW) || 1);
    const sh = Math.max(1, Number(scrollH) || 1);
    const docX = Math.max(0, Math.min(sw, (Number(ix) / Math.max(1, iw)) * sw));
    let docY;
    const segs = Array.isArray(segments) ? segments : [];
    if (segs.length > 0) {
      for (let si = 0; si < segs.length; si++) {
        const seg = segs[si];
        const last = si === segs.length - 1;
        const topOk = Number(iy) >= seg.imgTop;
        const bottomOk = last ? Number(iy) <= seg.imgBottom : Number(iy) < seg.imgBottom;
        if (topOk && bottomOk) {
          const t = (Number(iy) - seg.imgTop) / Math.max(1e-6, seg.imgBottom - seg.imgTop);
          docY = seg.docTop + t * (seg.docBottom - seg.docTop);
          break;
        }
      }
    }
    if (docY == null) docY = (Number(iy) / Math.max(1, ih)) * sh;
    docY = Math.max(0, Math.min(sh, docY));
    return { docX, docY };
  }

  // Some pages expose a non-extension `window.chrome` object without `runtime`.
  // In content-script extension context, `chrome.runtime` exists; guard to avoid crashing on unusual hosts.
  if (!globalThis.chrome?.runtime?.onMessage?.addListener) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "DOM_RECT_FROM_STITCHED_POINT") {
      try {
        const ix = Number(msg.imageX);
        const iy = Number(msg.imageY);
        const iw = Number(msg.imageWidth);
        const ih = Number(msg.imageHeight);
        const scrollW = Number(msg.scrollWidth);
        const scrollH = Number(msg.scrollHeight);
        const { docX, docY } = stitchedPointToDoc(ix, iy, iw, ih, scrollW, scrollH, msg.stitchSegments);
        const targetY = Math.max(0, docY - window.innerHeight * 0.32);
        window.scrollTo({ top: targetY, left: 0, behavior: "instant" });
        const vx = docX - window.scrollX;
        const vy = docY - window.scrollY;
        const px = Math.max(1, Math.min(window.innerWidth - 2, vx));
        const py = Math.max(1, Math.min(window.innerHeight - 2, vy));
        const pts = document.elementsFromPoint(px, py);
        let el = null;
        for (const e of pts) {
          if (e.closest?.(`#${OVERLAY_ID}`)) continue;
          el = e;
          break;
        }
        if (!el) {
          sendResponse({ ok: false, error: "no_element" });
          return false;
        }
        const skip = new Set(["HTML", "BODY", "SCRIPT", "STYLE", "HEAD", "META", "LINK"]);
        let cur = el;
        let best = el;
        for (let depth = 0; depth < 16 && cur; depth++) {
          if (cur.closest?.(`#${OVERLAY_ID}`)) break;
          if (!skip.has(cur.tagName)) {
            const r = cur.getBoundingClientRect();
            if (r.width >= 18 && r.height >= 10) {
              best = cur;
              if (
                r.width >= 56 &&
                r.height >= 32 &&
                /^(SECTION|ARTICLE|MAIN|ASIDE|HEADER|NAV|FORM|UL|OL|FIGURE|BUTTON|A|H1|H2|H3|P)$/i.test(cur.tagName)
              ) {
                best = cur;
                break;
              }
            }
          }
          cur = cur.parentElement;
        }
        const r = best.getBoundingClientRect();
        const rectDoc = {
          top: r.top + window.scrollY,
          left: r.left + window.scrollX,
          width: Math.max(4, r.width),
          height: Math.max(4, r.height),
        };
        let hint = best.tagName.toLowerCase();
        if (best.id) hint += `#${best.id}`;
        else if (typeof best.className === "string" && best.className.trim())
          hint += `.${best.className.trim().split(/\s+/)[0]}`;
        sendResponse({ ok: true, rectDoc, elementHint: hint.slice(0, 80) });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    if (msg.type === "LIST_PAGE_TABS") {
      try {
        const els = getTabElements();
        const tabs = els.map((el, i) => ({
          index: i,
          label:
            (el.textContent || el.getAttribute("aria-label") || "")
              .trim()
              .replace(/\s+/g, " ")
              .slice(0, 100) || `Tab ${i + 1}`,
        }));
        sendResponse({ ok: true, tabs });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    if (msg.type === "ACTIVATE_PAGE_TAB_INDEX") {
      try {
        const els = getTabElements();
        const idx = Math.max(0, Math.min(els.length - 1, parseInt(String(msg.index), 10) || 0));
        const el = els[idx];
        if (!el) {
          sendResponse({ ok: false, error: "no_tab" });
          return false;
        }
        el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        el.focus?.();
        el.click();
        sendResponse({ ok: true, index: idx });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    if (msg.type === "COLLECT_PAGE_QA") {
      try {
        const data = collectPageQaData({ limitSections: msg.limitSections });
        sendResponse({ ok: true, data });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    if (msg.type === "GET_PAGE_SCROLL_METRICS") {
      try {
        const scrollHeight = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight || 0,
          window.innerHeight,
        );
        const scrollWidth = Math.max(
          document.documentElement.scrollWidth,
          document.body?.scrollWidth || 0,
          window.innerWidth,
        );
        sendResponse({
          ok: true,
          scrollHeight,
          scrollWidth,
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    if (msg.type === "SCROLL_PAGE_Y") {
      try {
        window.scrollTo({ top: Number(msg.y) || 0, left: 0, behavior: "instant" });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    /**
     * During stitched full-page capture, hide position:fixed/sticky elements on slices after the first
     * so headers/nav are not repeated in every band (matches “single” nav in the design).
     */
    if (msg.type === "SET_CAPTURE_HIDE_FIXED") {
      try {
        const hidden = !!msg.hidden;
        if (!hidden) {
          for (const el of document.querySelectorAll('[data-fce-capture-hidden="1"]')) {
            el.style.removeProperty("visibility");
            el.removeAttribute("data-fce-capture-hidden");
          }
          sendResponse({ ok: true });
          return false;
        }
        const nodes = document.body ? document.body.querySelectorAll("*") : [];
        let n = 0;
        for (const el of nodes) {
          if (n++ > 4500) break;
          if (el.closest(`#${OVERLAY_ID}`)) continue;
          try {
            const p = getComputedStyle(el).position;
            if (p === "fixed" || p === "sticky") {
              el.setAttribute("data-fce-capture-hidden", "1");
              el.style.setProperty("visibility", "hidden", "important");
            }
          } catch {
            /* ignore */
          }
        }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    /**
     * Hide common chatbot / feedback widgets during capture (chat bubbles pollute stitched screenshots).
     * Best-effort heuristics; reversible via the same restore logic.
     */
    if (msg.type === "SET_CAPTURE_HIDE_CHATBOTS") {
      try {
        const hidden = !!msg.hidden;
        if (!hidden) {
          for (const el of document.querySelectorAll('[data-fce-bot-hidden="1"]')) {
            el.style.removeProperty("visibility");
            el.style.removeProperty("pointer-events");
            el.removeAttribute("data-fce-bot-hidden");
          }
          sendResponse({ ok: true });
          return false;
        }

        const likelyBot = (el) => {
          const id = String(el.id || "").toLowerCase();
          const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
          const aria = String(el.getAttribute?.("aria-label") || "").toLowerCase();
          const title = String(el.getAttribute?.("title") || "").toLowerCase();
          const dataAttrs = [
            String(el.getAttribute?.("data-testid") || "").toLowerCase(),
            String(el.getAttribute?.("data-test") || "").toLowerCase(),
            String(el.getAttribute?.("data-widget") || "").toLowerCase(),
          ].join(" ");
          const hay = `${id} ${cls} ${aria} ${title} ${dataAttrs}`;
          return (
            /intercom|drift|crisp|zendesk|tawk|livechat|freshchat|helpscout|chatra|kommunicate|whatsapp|messenger|chatbot|support chat/.test(
              hay,
            ) ||
            (el.tagName === "IFRAME" && /intercom|drift|crisp|zendesk|tawk|chat/.test(hay))
          );
        };

        const nodes = document.body ? document.body.querySelectorAll("iframe,div,button,a,section,aside") : [];
        let n = 0;
        for (const el of nodes) {
          if (n++ > 1600) break;
          if (el.closest?.(`#${OVERLAY_ID}`)) continue;
          try {
            if (!likelyBot(el)) continue;
            el.setAttribute("data-fce-bot-hidden", "1");
            el.style.setProperty("visibility", "hidden", "important");
            el.style.setProperty("pointer-events", "none", "important");
          } catch {
            /* ignore */
          }
        }

        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return false;
    }

    // Async handler must *always* eventually call sendResponse when we return true,
    // otherwise Chrome logs: "message channel closed before a response was received".
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

    (async () => {
      try {
        await loadState();

        switch (msg.type) {
          case "GET_STATE": {
            sendOnce({ ok: true, state: { ...state } });
            break;
          }
          case "SET_STATE": {
            Object.assign(state, msg.patch || {});
            saveState();
            applyToDom();
            sendOnce({ ok: true, state: { ...state } });
            break;
          }
          case "SET_IMAGE": {
            state.imageSrc = msg.dataUrl || "";
            saveState();
            applyToDom();
            sendOnce({ ok: true, state: { ...state } });
            break;
          }
          case "TOGGLE_OVERLAY": {
            if (!state.imageSrc) {
              sendOnce({ ok: false, error: "no_image" });
              break;
            }
            state.visible = !state.visible;
            saveState();
            applyToDom();
            sendOnce({ ok: true, state: { ...state } });
            break;
          }
          case "NUDGE": {
            const d = msg.delta || {};
            state.offsetX += d.x || 0;
            state.offsetY += d.y || 0;
            saveState();
            applyToDom();
            sendOnce({ ok: true, state: { ...state } });
            break;
          }
          case "INTERACTIVE": {
            setInteractive(!!msg.value);
            sendOnce({ ok: true });
            break;
          }
          default:
            sendOnce({ ok: false, error: "unknown" });
        }
      } catch (err) {
        sendOnce({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  });

  loadState().then(() => applyToDom());

  window.addEventListener("keydown", (e) => {
    if (!state.visible || !state.imageSrc) return;
    const target = e.target;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

    let dx = 0;
    let dy = 0;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else return;

    e.preventDefault();
    e.stopPropagation();
    state.offsetX += dx;
    state.offsetY += dy;
    saveState();
    applyToDom();
  });
})();
