const API_BASE = "http://127.0.0.1:8000/api/v1";
const DEFAULT_STEP_DELAY_MS = 1000;

const playerState = {
  workflowId: null,
  tabId: null,
  steps: [],
  status: "idle",
  currentStepIndex: 0,
  totalSteps: 0,
  isLoopActive: false,
  runToken: 0,
  controlLock: false,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(typeof data === "string" ? data : data?.detail || data?.message || `HTTP ${response.status}`);
  }
  return data;
}

function sortSteps(steps) {
  return (Array.isArray(steps) ? steps : []).slice().sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
}

async function getPlayerConfig() {
  const data = await chrome.storage.local.get(["playerConfig"]);
  return {
    stepDelayMs: Number.isFinite(data.playerConfig?.stepDelayMs) ? data.playerConfig.stepDelayMs : DEFAULT_STEP_DELAY_MS,
  };
}

async function setPlayerConfig(config) {
  const current = await getPlayerConfig();
  const safeDelay = Number.isFinite(config?.stepDelayMs) && config.stepDelayMs >= 0 ? config.stepDelayMs : current.stepDelayMs;
  const next = { ...current, ...config, stepDelayMs: safeDelay };
  await chrome.storage.local.set({ playerConfig: next });
  return next;
}

async function setRunStatus(status) {
  await chrome.storage.local.set({ localRunStatus: { ...status, updatedAt: Date.now() } });
}

async function getRunStatus() {
  const data = await chrome.storage.local.get(["localRunStatus"]);
  return data.localRunStatus || null;
}

async function updateRunStatus(partial) {
  const current = (await getRunStatus()) || {};
  await setRunStatus({ ...current, ...partial });
}

function samePage(currentUrl, targetUrl) {
  try {
    const a = new URL(currentUrl);
    const b = new URL(targetUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return currentUrl === targetUrl;
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await delay(700);
      return tab;
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for tab to finish loading");
}

function invalidateRunningLoop() {
  playerState.runToken += 1;
}

async function waitForLoopToStop(timeoutMs = 15000) {
  const start = Date.now();
  while (playerState.isLoopActive) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for current run loop to stop.");
    await delay(50);
  }
}

async function withControlLock(fn) {
  if (playerState.controlLock) throw new Error("Another player action is already in progress.");
  playerState.controlLock = true;
  try {
    return await fn();
  } finally {
    playerState.controlLock = false;
  }
}

async function pauseLoopIfRunning(message = "Workflow paused.") {
  if (playerState.status === "running") {
    playerState.status = "paused";
    invalidateRunningLoop();
    await waitForLoopToStop();
    await updateRunStatus({
      phase: "paused",
      message,
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
      completedSteps: playerState.currentStepIndex,
    });
  }
}

async function injectPageHelper(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      if (window.__observeAiHelperInjected) return;
      window.__observeAiHelperInjected = true;

      function dedupe(values) {
        const out = [];
        const seen = new Set();
        for (const value of values || []) {
          if (value && !seen.has(value)) {
            seen.add(value);
            out.push(value);
          }
        }
        return out;
      }

      function textOf(el) {
        return (el?.innerText || el?.textContent || el?.value || "").trim().replace(/\s+/g, " ");
      }

      function safeQueryAll(selector) {
        try {
          return Array.from(document.querySelectorAll(selector));
        } catch {
          return [];
        }
      }

      function isVisible(el) {
        if (!el || !(el instanceof Element)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0.02 && rect.width > 1 && rect.height > 1;
      }

      function normalize(value) {
        return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
      }

      function attributeValue(el, name) {
        return normalize(el?.getAttribute?.(name));
      }

      function similarityScore(a, b) {
        const left = normalize(a);
        const right = normalize(b);
        if (!left || !right) return 0;
        if (left === right) return 40;
        if (left.includes(right) || right.includes(left)) return 26;
        const leftWords = new Set(left.split(/[^a-z0-9]+/).filter(Boolean));
        const rightWords = new Set(right.split(/[^a-z0-9]+/).filter(Boolean));
        if (!leftWords.size || !rightWords.size) return 0;
        let overlap = 0;
        for (const word of leftWords) if (rightWords.has(word)) overlap += 1;
        return Math.round((overlap / Math.max(leftWords.size, rightWords.size)) * 22);
      }

      function getInteractiveLabel(el) {
        if (!el) return "";
        const labels = [];
        const ariaLabel = el.getAttribute?.("aria-label");
        const placeholder = el.getAttribute?.("placeholder");
        const name = el.getAttribute?.("name");
        const title = el.getAttribute?.("title");
        const id = el.getAttribute?.("id");
        if (ariaLabel) labels.push(ariaLabel);
        if (placeholder) labels.push(placeholder);
        if (name) labels.push(name);
        if (title) labels.push(title);
        if (id) labels.push(id);
        const labelByFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        if (labelByFor) labels.push(textOf(labelByFor));
        if (el.closest) {
          const wrappingLabel = el.closest("label");
          if (wrappingLabel) labels.push(textOf(wrappingLabel));
        }
        const prev = el.previousElementSibling;
        if (prev && ["LABEL", "SPAN", "DIV", "P"].includes(prev.tagName)) labels.push(textOf(prev));
        const parent = el.parentElement;
        if (parent) {
          const parentLabel = parent.querySelector?.("label");
          if (parentLabel) labels.push(textOf(parentLabel));
        }
        return labels.filter(Boolean).join(" | ");
      }

      function scoreElement(stepObj, el, usedSelector) {
        if (!el) return -Infinity;
        const ctx = stepObj.element_context || {};
        const action = stepObj.action || "click";
        const rect = el.getBoundingClientRect();
        let score = 0;
        if (isVisible(el)) score += 45;
        else score -= 75;

        if (rect.width >= 12 && rect.height >= 12) score += 8;
        if (rect.top >= 0 && rect.bottom <= window.innerHeight + 4) score += 6;

        const tag = normalize(el.tagName);
        const expectedTag = normalize(ctx.tag);
        if (expectedTag && tag === expectedTag) score += 20;

        const type = attributeValue(el, "type");
        const expectedType = normalize(ctx.type);
        if (expectedType && type === expectedType) score += 10;

        const placeholder = attributeValue(el, "placeholder");
        const expectedPlaceholder = normalize(ctx.placeholder || stepObj.placeholder);
        score += similarityScore(placeholder, expectedPlaceholder);

        const nameAttr = attributeValue(el, "name");
        const expectedName = normalize(ctx.name || stepObj.element_name);
        score += similarityScore(nameAttr, expectedName);

        const aria = attributeValue(el, "aria-label");
        const expectedAria = normalize((ctx.attributes || {})["aria-label"]);
        score += similarityScore(aria, expectedAria);

        const href = attributeValue(el, "href");
        const expectedHref = normalize((ctx.attributes || {}).href);
        score += similarityScore(href, expectedHref);

        const elementText = textOf(el);
        const expectedText = ctx.direct_text || ctx.text || stepObj.text || stepObj.name || "";
        score += similarityScore(elementText, expectedText);

        const labelText = getInteractiveLabel(el);
        score += Math.round(similarityScore(labelText, expectedText) * 0.85);
        score += Math.round(similarityScore(labelText, expectedName || expectedPlaceholder || expectedAria) * 0.9);

        if (action === "input") {
          if (["input", "textarea"].includes(tag)) score += 24;
          if (el.isContentEditable) score += 18;
          if (["button", "a", "select"].includes(tag)) score -= 24;
        }

        if (action === "select") {
          if (tag === "select") score += 28;
          else if (el.getAttribute?.("role") === "combobox") score += 22;
          else score -= 20;
        }

        if (action === "click") {
          if (["button", "a", "label", "summary"].includes(tag)) score += 14;
          if (["input", "textarea"].includes(tag)) score += 5;
        }

        if (action === "upload") {
          if (type === "file") score += 30;
          else score -= 22;
        }

        if (usedSelector === stepObj.preview?.predicted_selector) score += 16;
        if (usedSelector === stepObj.selector) score += 12;
        if ((stepObj.fallback_selectors || []).includes(usedSelector)) score += 5;

        return score;
      }

      function gatherSelectorCandidates(stepObj) {
        const selectors = [];
        if (stepObj.preview?.predicted_selector) selectors.push(stepObj.preview.predicted_selector);
        if (stepObj.selector) selectors.push(stepObj.selector);
        selectors.push(...(stepObj.fallback_selectors || []));
        for (const item of stepObj.selector_candidates || []) {
          if (typeof item === "string") selectors.push(item);
          else if (item?.selector) selectors.push(item.selector);
        }
        return dedupe(selectors);
      }

      function fallbackElementsForAction(stepObj) {
        const action = stepObj.action || "click";
        if (action === "input") return Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"));
        if (action === "select") return Array.from(document.querySelectorAll("select, [role='combobox']"));
        if (action === "upload") return Array.from(document.querySelectorAll("input[type='file']"));
        return Array.from(document.querySelectorAll("a, button, input, textarea, select, label, [role='button'], [role='link'], [tabindex], div, span"));
      }

      function resolveElement(stepObj) {
        const selectorCandidates = gatherSelectorCandidates(stepObj);
        const scored = [];

        for (const selector of selectorCandidates) {
          const nodes = safeQueryAll(selector);
          for (const el of nodes) {
            scored.push({ el, usedSelector: selector, score: scoreElement(stepObj, el, selector) });
          }
        }

        if (!scored.length) {
          for (const el of fallbackElementsForAction(stepObj)) {
            scored.push({ el, usedSelector: "heuristic", score: scoreElement(stepObj, el, "heuristic") });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (!best || best.score < 8) return null;
        return best;
      }

      function getOverlayRoot() {
        let root = document.getElementById("observe-ai-overlay-root");
        if (root) return root;
        root = document.createElement("div");
        root.id = "observe-ai-overlay-root";
        root.style.position = "fixed";
        root.style.inset = "0";
        root.style.pointerEvents = "none";
        root.style.zIndex = "2147483647";
        document.documentElement.appendChild(root);
        return root;
      }

      function clearHighlight() {
        const existing = document.getElementById("observe-ai-overlay-root");
        if (existing) existing.remove();
      }

      function createArrow(x, y, rotationDeg, delayMs) {
        const arrow = document.createElement("div");
        arrow.style.position = "fixed";
        arrow.style.left = `${x}px`;
        arrow.style.top = `${y}px`;
        arrow.style.width = "40px";
        arrow.style.height = "40px";
        arrow.style.transform = `rotate(${rotationDeg}deg)`;
        arrow.style.transformOrigin = "50% 50%";
        arrow.style.opacity = "0.96";
        arrow.style.filter = "drop-shadow(0 0 10px rgba(79,124,255,0.5))";
        arrow.style.animation = `observeAiArrowPulse 1.4s ease-in-out ${delayMs}ms infinite`;
        arrow.innerHTML = `
          <svg viewBox="0 0 64 64" width="40" height="40" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 32H44" stroke="#93c5fd" stroke-width="7" stroke-linecap="round"/>
            <path d="M32 20L48 32L32 44" stroke="#ffffff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        `;
        return arrow;
      }

      function wait(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      }

      async function waitForStableRect(el, attempts = 8) {
        let prev = null;
        for (let i = 0; i < attempts; i += 1) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const rect = el.getBoundingClientRect();
          if (
            prev &&
            Math.abs(prev.top - rect.top) < 1 &&
            Math.abs(prev.left - rect.left) < 1 &&
            Math.abs(prev.width - rect.width) < 1 &&
            Math.abs(prev.height - rect.height) < 1
          ) {
            return rect;
          }
          prev = rect;
        }
        return el.getBoundingClientRect();
      }

      function ensureKeyframes() {
        if (document.getElementById("observe-ai-highlight-style")) return;
        const style = document.createElement("style");
        style.id = "observe-ai-highlight-style";
        style.textContent = `
          @keyframes observeAiPulseRing {
            0% { transform: scale(0.98); box-shadow: 0 0 0 0 rgba(79,124,255,0.45), 0 0 0 9999px rgba(2,6,23,0.22); }
            70% { transform: scale(1.01); box-shadow: 0 0 0 16px rgba(79,124,255,0.0), 0 0 0 9999px rgba(2,6,23,0.22); }
            100% { transform: scale(0.99); box-shadow: 0 0 0 0 rgba(79,124,255,0.0), 0 0 0 9999px rgba(2,6,23,0.22); }
          }
          @keyframes observeAiGlowBorder {
            0%, 100% { border-color: rgba(147,197,253,0.95); }
            50% { border-color: rgba(255,255,255,1); }
          }
          @keyframes observeAiArrowPulse {
            0%, 100% { transform: translateY(0) scale(0.98); opacity: 0.72; }
            50% { transform: translateY(-6px) scale(1.06); opacity: 1; }
          }
          @keyframes observeAiLabelFloat {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-2px); }
          }
        `;
        document.documentElement.appendChild(style);
      }

      function rectsOverlap(a, b, padding = 0) {
        return !(a.right + padding < b.left || a.left - padding > b.right || a.bottom + padding < b.top || a.top - padding > b.bottom);
      }

      function chooseLabelPlacement(focusRect, labelRect) {
        const viewportPadding = 12;
        const gap = 16;
        const candidates = [
          { side: "top", left: focusRect.left, top: focusRect.top - labelRect.height - gap, score: 4 },
          { side: "bottom", left: focusRect.left, top: focusRect.bottom + gap, score: 3 },
          { side: "right", left: focusRect.right + gap, top: focusRect.top + Math.max((focusRect.height - labelRect.height) / 2, -focusRect.height * 0.2), score: 2 },
          { side: "left", left: focusRect.left - labelRect.width - gap, top: focusRect.top + Math.max((focusRect.height - labelRect.height) / 2, -focusRect.height * 0.2), score: 1 },
        ].map((item) => {
          const maxLeft = Math.max(viewportPadding, window.innerWidth - labelRect.width - viewportPadding);
          const maxTop = Math.max(viewportPadding, window.innerHeight - labelRect.height - viewportPadding);
          const left = Math.min(Math.max(item.left, viewportPadding), maxLeft);
          const top = Math.min(Math.max(item.top, viewportPadding), maxTop);
          const rect = { left, top, right: left + labelRect.width, bottom: top + labelRect.height, width: labelRect.width, height: labelRect.height };
          const overlaps = rectsOverlap(rect, focusRect, 10);
          const clipped = left <= viewportPadding || top <= viewportPadding || rect.right >= window.innerWidth - viewportPadding || rect.bottom >= window.innerHeight - viewportPadding;
          return { ...item, left, top, rect, overlaps, clipped, rank: item.score + (overlaps ? -10 : 0) + (clipped ? -2 : 0) };
        });
        candidates.sort((a, b) => b.rank - a.rank);
        return candidates[0];
      }

      function arrowConfigsForPlacement(focusRect, placement, labelRect) {
        const configsBySide = {
          top: [
            { x: focusRect.left - 52, y: focusRect.top + Math.max(focusRect.height * 0.2, 8), rot: 0, delay: 0 },
            { x: focusRect.right + 12, y: focusRect.top + Math.max(focusRect.height * 0.68, 10), rot: 180, delay: 180 },
          ],
          bottom: [
            { x: focusRect.left - 52, y: focusRect.top + Math.max(focusRect.height * 0.25, 8), rot: 0, delay: 0 },
            { x: focusRect.right + 12, y: focusRect.top + Math.max(focusRect.height * 0.62, 10), rot: 180, delay: 180 },
          ],
          left: [
            { x: focusRect.right + 12, y: focusRect.top + Math.max(focusRect.height * 0.4, 10), rot: 180, delay: 0 },
            { x: focusRect.left + Math.max(focusRect.width * 0.25, 8), y: focusRect.top - 52, rot: 90, delay: 180 },
          ],
          right: [
            { x: focusRect.left - 52, y: focusRect.top + Math.max(focusRect.height * 0.4, 10), rot: 0, delay: 0 },
            { x: focusRect.left + Math.max(focusRect.width * 0.25, 8), y: focusRect.top - 52, rot: 90, delay: 180 },
          ],
        };
        const candidates = configsBySide[placement.side] || configsBySide.top;
        return candidates.filter((cfg) => {
          const arrowRect = { left: cfg.x, top: cfg.y, right: cfg.x + 40, bottom: cfg.y + 40 };
          return cfg.x > -46 && cfg.y > -46 && cfg.x < window.innerWidth + 20 && cfg.y < window.innerHeight + 20 && !rectsOverlap(arrowRect, labelRect, 12);
        });
      }

      async function highlightStep(stepObj) {
        clearHighlight();
        if (stepObj.action === "navigate") {
          return { ok: true, usedSelector: null, message: `Navigate to ${stepObj.target_url || "page"}` };
        }

        const resolved = resolveElement(stepObj);
        if (!resolved?.el) throw new Error(`Could not resolve element for ${stepObj.action}`);

        resolved.el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
        await wait(30);
        const rect = await waitForStableRect(resolved.el, 10);
        ensureKeyframes();
        const root = getOverlayRoot();

        const focusRect = {
          left: Math.max(rect.left - 8, 0),
          top: Math.max(rect.top - 8, 0),
          width: Math.max(rect.width + 16, 28),
          height: Math.max(rect.height + 16, 28),
        };
        focusRect.right = focusRect.left + focusRect.width;
        focusRect.bottom = focusRect.top + focusRect.height;

        const focus = document.createElement("div");
        focus.style.position = "fixed";
        focus.style.left = `${focusRect.left}px`;
        focus.style.top = `${focusRect.top}px`;
        focus.style.width = `${focusRect.width}px`;
        focus.style.height = `${focusRect.height}px`;
        focus.style.border = "3px solid rgba(147,197,253,0.96)";
        focus.style.borderRadius = "14px";
        focus.style.background = "rgba(96,165,250,0.10)";
        focus.style.animation = "observeAiPulseRing 1.6s ease-out infinite, observeAiGlowBorder 1.2s ease-in-out infinite";
        focus.style.backdropFilter = "blur(1px)";
        root.appendChild(focus);

        const innerGlow = document.createElement("div");
        innerGlow.style.position = "fixed";
        innerGlow.style.left = `${Math.max(rect.left - 3, 0)}px`;
        innerGlow.style.top = `${Math.max(rect.top - 3, 0)}px`;
        innerGlow.style.width = `${Math.max(rect.width + 6, 24)}px`;
        innerGlow.style.height = `${Math.max(rect.height + 6, 24)}px`;
        innerGlow.style.borderRadius = "12px";
        innerGlow.style.border = "1px solid rgba(255,255,255,0.85)";
        innerGlow.style.boxShadow = "0 0 24px rgba(96,165,250,0.45), inset 0 0 18px rgba(255,255,255,0.15)";
        root.appendChild(innerGlow);

        const confidence = stepObj.preview?.confidence ?? stepObj.confidence ?? "?";
        const label = document.createElement("div");
        label.style.position = "fixed";
        label.style.maxWidth = "320px";
        label.style.padding = "12px 14px";
        label.style.borderRadius = "16px";
        label.style.background = "linear-gradient(135deg, rgba(8,15,30,0.95), rgba(17,24,39,0.96))";
        label.style.border = "1px solid rgba(148,163,184,0.24)";
        label.style.color = "white";
        label.style.boxShadow = "0 18px 45px rgba(2,8,23,0.45)";
        label.style.fontFamily = "Inter, Arial, sans-serif";
        label.style.animation = "observeAiLabelFloat 1.6s ease-in-out infinite";
        label.style.visibility = "hidden";
        label.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
            <span style="display:inline-flex; align-items:center; padding:4px 8px; border-radius:999px; background:rgba(79,124,255,0.18); color:#dbeafe; font-size:11px; font-weight:800; letter-spacing:0.02em;">${String(stepObj.action || "step").toUpperCase()}</span>
            <span style="display:inline-flex; align-items:center; padding:4px 8px; border-radius:999px; background:rgba(34,197,94,0.16); color:#dcfce7; font-size:11px; font-weight:800;">${confidence}% confidence</span>
          </div>
          <div style="font-size:13px; font-weight:700; line-height:1.35; color:#f8fbff;">${stepObj.name || resolved.usedSelector || "Selected target"}</div>
          <div style="margin-top:5px; font-size:11px; line-height:1.45; color:#bfd1ee; word-break:break-word;">${resolved.usedSelector || "Heuristic match"}</div>
        `;
        root.appendChild(label);
        const labelBounds = label.getBoundingClientRect();
        const placement = chooseLabelPlacement(focusRect, labelBounds);
        label.style.left = `${placement.left}px`;
        label.style.top = `${placement.top}px`;
        label.style.visibility = "visible";

        for (const cfg of arrowConfigsForPlacement(focusRect, placement, placement.rect)) {
          root.appendChild(createArrow(cfg.x, cfg.y, cfg.rot, cfg.delay));
        }

        return {
          ok: true,
          usedSelector: resolved.usedSelector,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          score: resolved.score,
          labelPlacement: placement.side,
        };
      }

      function setNativeValue(el, value) {
        const tag = el.tagName?.toLowerCase();
        if (tag === "input") {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
          return;
        }
        if (tag === "textarea") {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, value);
          return;
        }
        el.value = value;
      }

      function dispatchInputEvents(el) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      async function executeStep(stepObj) {
        if (stepObj.action === "navigate") return { ok: true, usedSelector: null };
        const resolved = resolveElement(stepObj);
        if (!resolved?.el) throw new Error(`Could not resolve element for ${stepObj.action}`);
        const el = resolved.el;
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        el.focus?.();
        if (stepObj.action === "click") {
          el.click();
        } else if (stepObj.action === "input") {
          setNativeValue(el, stepObj.value ?? "");
          dispatchInputEvents(el);
        } else if (stepObj.action === "select") {
          el.value = stepObj.value ?? "";
          dispatchInputEvents(el);
        } else if (stepObj.action === "upload") {
          throw new Error("Local popup execution does not support file uploads yet.");
        } else {
          throw new Error(`Unsupported local action: ${stepObj.action}`);
        }
        return { ok: true, usedSelector: resolved.usedSelector, score: resolved.score };
      }

      window.__observeAiResolveStep = resolveElement;
      window.__observeAiHighlightStep = highlightStep;
      window.__observeAiClearHighlight = clearHighlight;
      window.__observeAiExecuteStep = executeStep;
    },
  });
}

async function ensureStepPage(tabId, step) {
  if (!step?.target_url || step.action === "navigate") return;
  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.url || "";
  if (!samePage(currentUrl, step.target_url)) {
    await chrome.tabs.update(tabId, { url: step.target_url });
    await waitForTabComplete(tabId);
  }
}

async function runInPage(tabId, fnName, step) {
  await injectPageHelper(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (name, payload) => {
      const fn = window[name];
      if (typeof fn !== "function") throw new Error(`${name} is not available in page context`);
      return await fn(payload);
    },
    args: [fnName, step],
  });
  return result;
}

async function clearPageHighlight(tabId) {
  if (!tabId) {
    const cached = await chrome.storage.local.get(["currentHighlight"]);
    tabId = cached.currentHighlight?.tabId || null;
  }
  if (!tabId) return;
  try {
    await injectPageHelper(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => window.__observeAiClearHighlight?.(),
    });
  } catch {}
  await chrome.storage.local.remove(["currentHighlight"]);
}

async function getStoredSteps() {
  const data = await chrome.storage.local.get(["steps"]);
  return Array.isArray(data.steps) ? data.steps : [];
}

async function uploadAndProcessWorkflow({ name, description }) {
  const recordedSteps = await getStoredSteps();
  if (!recordedSteps.length) throw new Error("No recorded steps found.");
  await updateRunStatus({ phase: "uploading", message: "Workflow is uploading..." });
  const payload = {
    name: name || "My recorded workflow",
    description: description || "Recorded from Chrome extension",
    source_url: recordedSteps[0]?.url || null,
    raw_steps: recordedSteps,
  };
  const data = await fetchJson(`${API_BASE}/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  await chrome.storage.local.set({ lastWorkflowId: data.workflow_id });
  await updateRunStatus({
    phase: "processed",
    message: "Workflow uploaded and processed successfully.",
    workflowId: data.workflow_id,
    rawStepCount: data.raw_step_count,
    processedStepCount: data.processed_step_count,
  });
  return data;
}

function stepReviewSummary(step) {
  const confidence = step.preview?.confidence ?? step.confidence ?? 0;
  const selector = step.preview?.predicted_selector || step.selector || null;
  return {
    id: step.id,
    order_index: step.order_index,
    action: step.action,
    name: step.name,
    target_url: step.target_url,
    selector: step.selector,
    fallback_selectors: step.fallback_selectors || [],
    selector_candidates: step.selector_candidates || [],
    selector_is_unique: !!step.selector_is_unique,
    text: step.text,
    value: step.value,
    element_context: step.element_context || null,
    confidence,
    llm_metadata: {
      ...(step.llm_metadata || {}),
      preview_selector: selector,
      preview_reason: step.preview?.match_reason,
      preview_provider: step.preview?.preview_metadata?.provider,
    },
    status: step.status || "ready",
    preview: step.preview || null,
  };
}

async function getWorkflowReview(workflowId, { forceRefresh = true } = {}) {
  const cached = (await chrome.storage.local.get(["lastReview"]))?.lastReview;
  if (!forceRefresh && cached?.workflowId === workflowId && Array.isArray(cached?.steps)?.length) {
    return cached;
  }
  const workflow = await fetchJson(`${API_BASE}/workflows/${workflowId}/executable`);
  const preview = await fetchJson(`${API_BASE}/workflows/${workflowId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ simulated_dom: [] }),
  });
  const steps = sortSteps(preview.steps || workflow.steps || []).map(stepReviewSummary);
  const review = {
    workflowId,
    name: workflow.name,
    description: workflow.description,
    status: workflow.status,
    requiresReview: workflow.requires_review,
    sourceUrl: workflow.source_url,
    steps,
  };
  await chrome.storage.local.set({ lastReview: review, lastWorkflowId: workflowId });
  return review;
}

async function saveWorkflowReview(workflowId, steps, markReviewed = true) {
  const payload = {
    mark_reviewed: !!markReviewed,
    steps: sortSteps(steps).map((step, index) => ({
      id: step.id,
      order_index: index,
      action: step.action,
      name: step.name,
      target_url: step.target_url,
      selector: step.selector,
      fallback_selectors: step.fallback_selectors || [],
      selector_candidates: step.selector_candidates || [],
      selector_is_unique: !!step.selector_is_unique,
      text: step.text,
      value: step.value,
      element_context: step.element_context || null,
      confidence: Number(step.confidence ?? step.preview?.confidence ?? 50),
      llm_metadata: step.llm_metadata || {},
      status: step.status || "ready",
    })),
  };
  const result = await fetchJson(`${API_BASE}/workflows/${workflowId}/steps`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const review = {
    workflowId,
    status: result.status,
    requiresReview: result.status !== "reviewed",
    steps: sortSteps(result.steps || []).map(stepReviewSummary),
  };
  const existing = (await chrome.storage.local.get(["lastReview"]))?.lastReview || {};
  await chrome.storage.local.set({ lastReview: { ...existing, ...review } });
  return result;
}

async function loadWorkflowIntoPlayer(workflowId) {
  const workflow = await fetchJson(`${API_BASE}/workflows/${workflowId}/executable`);
  const steps = sortSteps(workflow.steps);
  if (!steps.length) throw new Error("Workflow has no executable steps.");
  const firstNavigate = steps.find((step) => step.action === "navigate" && step.target_url);
  const startUrl = firstNavigate?.target_url || workflow.source_url;
  if (!startUrl) throw new Error("No start URL found for workflow.");

  playerState.status = "loading";
  await updateRunStatus({ phase: "fetching", message: `Loading workflow ${workflowId}...`, workflowId });

  const tab = await chrome.tabs.create({ url: startUrl, active: true });
  await waitForTabComplete(tab.id);
  await injectPageHelper(tab.id);

  playerState.workflowId = workflowId;
  playerState.tabId = tab.id;
  playerState.steps = steps;
  playerState.currentStepIndex = 0;
  playerState.totalSteps = steps.length;
  playerState.status = "paused";

  await updateRunStatus({
    phase: "ready",
    message: workflow.requires_review
      ? "Workflow loaded, but it should be reviewed before running."
      : "Workflow loaded and ready to run.",
    workflowId,
    currentStepIndex: 0,
    totalSteps: steps.length,
  });

  return { workflowId, totalSteps: steps.length, startUrl, status: playerState.status };
}

async function highlightWorkflowStep(workflowId, stepIndex) {
  const review = await getWorkflowReview(workflowId, { forceRefresh: false });
  const step = review.steps[stepIndex];
  if (!step) throw new Error("Step not found.");

  let tabId = playerState.tabId;
  if (!tabId) {
    const startUrl = step.target_url || review.sourceUrl || review.steps.find((item) => item.action === "navigate")?.target_url;
    const tab = await chrome.tabs.create({ url: startUrl || "about:blank", active: true });
    tabId = tab.id;
    playerState.tabId = tabId;
    await waitForTabComplete(tabId);
  }

  if (step.target_url && step.action !== "navigate") await ensureStepPage(tabId, step);
  const result = await runInPage(tabId, "__observeAiHighlightStep", step);
  const currentHighlight = {
    workflowId,
    stepIndex,
    tabId,
    stepId: step.id,
    stepName: step.name || step.action,
    updatedAt: Date.now(),
  };
  await chrome.storage.local.set({ currentHighlight });
  await updateRunStatus({
    phase: "reviewing",
    workflowId,
    currentStepIndex: stepIndex,
    totalSteps: review.steps.length,
    currentStep: step,
    message: result?.message || `Highlighted step ${stepIndex + 1}.`,
  });
  return { workflowId, stepIndex, step, highlight: result, currentHighlight };
}

async function executeCurrentStep(step) {
  if (!playerState.tabId) throw new Error("No active workflow tab.");
  if (step.action === "navigate") {
    if (step.target_url) {
      await chrome.tabs.update(playerState.tabId, { url: step.target_url });
      await waitForTabComplete(playerState.tabId);
    }
    return { ok: true, usedSelector: null };
  }
  await ensureStepPage(playerState.tabId, step);
  return await runInPage(playerState.tabId, "__observeAiExecuteStep", step);
}

async function runLoop(fromCurrent = true) {
  const currentToken = ++playerState.runToken;
  playerState.isLoopActive = true;
  playerState.status = "running";
  const { stepDelayMs } = await getPlayerConfig();
  try {
    for (let index = fromCurrent ? playerState.currentStepIndex : 0; index < playerState.steps.length; index += 1) {
      if (playerState.runToken !== currentToken) break;
      const step = playerState.steps[index];
      playerState.currentStepIndex = index;
      await updateRunStatus({
        phase: "running",
        workflowId: playerState.workflowId,
        currentStepIndex: index,
        totalSteps: playerState.totalSteps,
        currentStep: step,
        message: `Running step ${index + 1}: ${step.name || step.action}`,
      });
      await clearPageHighlight(playerState.tabId);
      await executeCurrentStep(step);
      await delay(stepDelayMs);
    }
    if (playerState.runToken === currentToken && playerState.currentStepIndex >= playerState.steps.length - 1) {
      playerState.status = "finished";
      await updateRunStatus({
        phase: "finished",
        workflowId: playerState.workflowId,
        currentStepIndex: playerState.steps.length - 1,
        totalSteps: playerState.totalSteps,
        completedSteps: playerState.totalSteps,
        message: "Workflow finished.",
      });
    }
  } finally {
    playerState.isLoopActive = false;
  }
}

async function resetPlayer() {
  invalidateRunningLoop();
  await waitForLoopToStop().catch(() => {});
  await clearPageHighlight(playerState.tabId);
  playerState.status = "idle";
  playerState.currentStepIndex = 0;
  playerState.totalSteps = playerState.steps.length;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "RECORDED_STEP": {
        const storage = await chrome.storage.local.get(["recording", "steps"]);
        if (!storage.recording) return sendResponse({ ok: true, ignored: true });
        const steps = Array.isArray(storage.steps) ? storage.steps : [];
        steps.push(message.payload);
        await chrome.storage.local.set({ steps });
        return sendResponse({ ok: true, stepCount: steps.length });
      }
      case "START_RECORDING": {
        await chrome.storage.local.set({ recording: true, steps: [], localRunStatus: null });
        return sendResponse({ ok: true });
      }
      case "STOP_RECORDING": {
        await chrome.storage.local.set({ recording: false });
        return sendResponse({ ok: true });
      }
      case "GET_RECORDING_STATE": {
        const data = await chrome.storage.local.get(["recording", "steps", "lastWorkflowId"]);
        return sendResponse({
          ok: true,
          data: {
            recording: !!data.recording,
            stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
            lastWorkflowId: data.lastWorkflowId || null,
          },
        });
      }
      case "UPLOAD_AND_PROCESS_WORKFLOW": {
        const data = await uploadAndProcessWorkflow(message.payload || {});
        return sendResponse({ ok: true, data });
      }
      case "GET_LOCAL_RUN_STATUS": {
        return sendResponse({ ok: true, data: await getRunStatus() });
      }
      case "GET_PLAYER_CONFIG": {
        return sendResponse({ ok: true, data: await getPlayerConfig() });
      }
      case "SET_PLAYER_CONFIG": {
        return sendResponse({ ok: true, data: await setPlayerConfig(message.config || {}) });
      }
      case "GET_WORKFLOW_REVIEW": {
        const data = await getWorkflowReview(Number(message.workflowId));
        return sendResponse({ ok: true, data });
      }
      case "GET_CACHED_REVIEW_STATE": {
        const data = await chrome.storage.local.get(["lastReview", "currentHighlight", "lastWorkflowId"]);
        return sendResponse({ ok: true, data });
      }
      case "SAVE_WORKFLOW_REVIEW": {
        const data = await saveWorkflowReview(Number(message.workflowId), message.steps || [], !!message.markReviewed);
        return sendResponse({ ok: true, data });
      }
      case "HIGHLIGHT_REVIEW_STEP": {
        const data = await highlightWorkflowStep(Number(message.workflowId), Number(message.stepIndex || 0));
        return sendResponse({ ok: true, data });
      }
      case "CLEAR_HIGHLIGHT": {
        await clearPageHighlight(playerState.tabId);
        return sendResponse({ ok: true });
      }
      case "RUN_WORKFLOW_LOCALLY": {
        const workflowId = Number(message.workflowId);
        const review = await getWorkflowReview(workflowId);
        if (review.requiresReview) {
          return sendResponse({ ok: false, error: "Review and approve the workflow before running it." });
        }
        const data = await loadWorkflowIntoPlayer(workflowId);
        return sendResponse({ ok: true, data });
      }
      case "APPROVE_AND_RUN_WORKFLOW": {
        const workflowId = Number(message.workflowId);
        await saveWorkflowReview(workflowId, message.steps || [], true);
        const data = await loadWorkflowIntoPlayer(workflowId);
        return sendResponse({ ok: true, data });
      }
      case "PLAYER_PLAY": {
        return sendResponse({ ok: true, data: await withControlLock(async () => {
          if (!playerState.steps.length) throw new Error("Load a workflow first.");
          await pauseLoopIfRunning();
          runLoop(true);
          return { status: "running" };
        }) });
      }
      case "PLAYER_PAUSE": {
        await withControlLock(() => pauseLoopIfRunning());
        return sendResponse({ ok: true });
      }
      case "PLAYER_STOP": {
        await withControlLock(async () => {
          await resetPlayer();
          await updateRunStatus({ phase: "stopped", workflowId: playerState.workflowId, message: "Workflow stopped." });
        });
        return sendResponse({ ok: true });
      }
      case "PLAYER_NEXT": {
        await withControlLock(async () => {
          await pauseLoopIfRunning();
          if (!playerState.steps.length) throw new Error("Load a workflow first.");
          const index = Math.min(playerState.currentStepIndex, playerState.steps.length - 1);
          const step = playerState.steps[index];
          playerState.currentStepIndex = index;
          await executeCurrentStep(step);
          await updateRunStatus({ phase: "paused", workflowId: playerState.workflowId, currentStepIndex: index, totalSteps: playerState.totalSteps, currentStep: step, message: `Executed step ${index + 1}.` });
          playerState.currentStepIndex = Math.min(index + 1, playerState.steps.length - 1);
        });
        return sendResponse({ ok: true });
      }
      case "PLAYER_PREV": {
        await withControlLock(async () => {
          await pauseLoopIfRunning();
          if (!playerState.steps.length) throw new Error("Load a workflow first.");
          playerState.currentStepIndex = Math.max(playerState.currentStepIndex - 1, 0);
          await updateRunStatus({ phase: "paused", workflowId: playerState.workflowId, currentStepIndex: playerState.currentStepIndex, totalSteps: playerState.totalSteps, currentStep: playerState.steps[playerState.currentStepIndex], message: `Moved to step ${playerState.currentStepIndex + 1}.` });
        });
        return sendResponse({ ok: true });
      }
      case "PLAYER_JUMP": {
        await withControlLock(async () => {
          await pauseLoopIfRunning();
          if (!playerState.steps.length) throw new Error("Load a workflow first.");
          const index = Math.max(0, Math.min(Number(message.stepIndex || 0), playerState.steps.length - 1));
          playerState.currentStepIndex = index;
          await updateRunStatus({ phase: "jumping", workflowId: playerState.workflowId, currentStepIndex: index, totalSteps: playerState.totalSteps, currentStep: playerState.steps[index], message: `Jumped to step ${index + 1}.` });
        });
        return sendResponse({ ok: true });
      }
      default:
        return sendResponse({ ok: false, error: "Unknown message type." });
    }
  })().catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
