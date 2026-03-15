(function () {
  let lastInputTs = 0;

  const STABLE_ATTRS = [
    "data-testid",
    "data-test",
    "data-qa",
    "data-cy",
    "data-testid-id",
    "data-test-id",
    "aria-label",
    "title",
    "name",
    "type",
    "placeholder",
    "role",
    "href",
    "alt"
  ];

  let lastRecordedInputSignature = null;

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(String(value));
    }
    return String(value).replace(/["\\#.:()[\]=>+~*^$|/ ]/g, "\\$&");
  }

  function isElement(node) {
    return node && node.nodeType === 1;
  }

  function safeQueryCount(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return Infinity;
    }
  }

  function isUniqueSelector(selector, el) {
    if (!selector || !isElement(el)) return false;
    try {
      const nodes = document.querySelectorAll(selector);
      return nodes.length === 1 && nodes[0] === el;
    } catch {
      return false;
    }
  }

  function getTag(el) {
    return el?.tagName ? el.tagName.toLowerCase() : null;
  }

  function getStableClasses(el) {
    if (!el?.classList) return [];
    return [...el.classList]
      .map((c) => c.trim())
      .filter(Boolean)
      .filter((c) => c.length >= 3)
      .filter((c) => !/^(active|selected|hover|focus|disabled|hidden|open|close|checked|loading|current|expanded)$/i.test(c))
      .filter((c) => !/^\d+$/.test(c))
      .filter((c) => !/^css-[a-z0-9]+$/i.test(c))
      .filter((c) => !/^jsx-\d+$/i.test(c))
      .filter((c) => !/^sc-[a-z0-9]+$/i.test(c))
      .filter((c) => !/^__[a-z0-9_-]{6,}$/i.test(c))
      .filter((c) => !/^[a-f0-9]{6,}$/i.test(c));
  }

  function getText(el) {
    const txt =
      el?.innerText ||
      el?.value ||
      el?.getAttribute?.("aria-label") ||
      el?.getAttribute?.("title") ||
      el?.textContent ||
      "";
    return String(txt).trim().replace(/\s+/g, " ").slice(0, 200);
  }

  function getDirectText(el) {
    if (!isElement(el)) return "";
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        text += ` ${node.textContent.trim()}`;
      }
    }
    return text.trim().replace(/\s+/g, " ").slice(0, 120);
  }

  function getNthOfTypeSelector(el) {
    if (!isElement(el)) return null;
    const tag = getTag(el);
    if (!tag || !el.parentElement) return tag;
    const siblings = [...el.parentElement.children].filter(
      (child) => child.tagName === el.tagName
    );
    const index = siblings.indexOf(el);
    if (index === -1) return tag;
    return `${tag}:nth-of-type(${index + 1})`;
  }

  function buildAbsolutePath(el, maxDepth = 6) {
    if (!isElement(el)) return null;

    const parts = [];
    let current = el;
    let depth = 0;

    while (isElement(current) && current !== document.body && depth < maxDepth) {
      const tag = getTag(current);
      if (!tag) break;

      if (current.id) {
        parts.unshift(`#${cssEscape(current.id)}`);
        return parts.join(" > ");
      }

      const stableClasses = getStableClasses(current);
      let part = tag;

      if (stableClasses.length > 0) {
        const classPart = stableClasses.slice(0, 2).map((c) => `.${cssEscape(c)}`).join("");
        const candidate = `${tag}${classPart}`;
        if (safeQueryCount(candidate) <= 10) {
          part = candidate;
        }
      }

      const nth = getNthOfTypeSelector(current);
      if (nth) {
        part = nth.startsWith(tag) ? nth : `${part}${nth.slice(tag.length)}`;
      }

      parts.unshift(part);
      current = current.parentElement;
      depth += 1;
    }

    return parts.join(" > ");
  }

  function getAttributeCandidates(el) {
    const tag = getTag(el);
    if (!tag) return [];

    const candidates = [];

    if (el.id) {
      candidates.push(`#${cssEscape(el.id)}`);
    }

    for (const attr of STABLE_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (!value) continue;

      const escapedValue = cssEscape(value);

      if (attr === "href") {
        if (value.length < 180) {
          candidates.push(`${tag}[href="${escapedValue}"]`);
        }
        continue;
      }

      candidates.push(`${tag}[${attr}="${escapedValue}"]`);
      candidates.push(`[${attr}="${escapedValue}"]`);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  function getClassCandidates(el) {
    const tag = getTag(el);
    if (!tag) return [];

    const classes = getStableClasses(el);
    const candidates = [];

    if (classes.length >= 1) candidates.push(`${tag}.${cssEscape(classes[0])}`);
    if (classes.length >= 2) {
      candidates.push(`${tag}.${cssEscape(classes[0])}.${cssEscape(classes[1])}`);
      candidates.push(`${tag}.${cssEscape(classes[1])}.${cssEscape(classes[0])}`);
    }
    if (classes.length >= 3) {
      candidates.push(`${tag}.${cssEscape(classes[0])}.${cssEscape(classes[1])}.${cssEscape(classes[2])}`);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  function getTextHintCandidates(el) {
    const tag = getTag(el);
    if (!tag) return [];

    const out = [];
    const aria = el.getAttribute?.("aria-label");
    const title = el.getAttribute?.("title");
    const placeholder = el.getAttribute?.("placeholder");

    if (aria) out.push(`${tag}[aria-label="${cssEscape(aria)}"]`);
    if (title) out.push(`${tag}[title="${cssEscape(title)}"]`);
    if (placeholder) out.push(`${tag}[placeholder="${cssEscape(placeholder)}"]`);

    return [...new Set(out.filter(Boolean))];
  }

  function getParentScopedCandidates(el) {
    if (!isElement(el) || !el.parentElement) return [];
    const tag = getTag(el);
    if (!tag) return [];

    const parent = el.parentElement;
    const parentTag = getTag(parent);
    const candidates = [];

    if (parent.id) {
      candidates.push(`#${cssEscape(parent.id)} > ${getNthOfTypeSelector(el)}`);
      candidates.push(`#${cssEscape(parent.id)} ${getNthOfTypeSelector(el)}`);
    }

    const parentClasses = getStableClasses(parent);
    if (parentClasses.length) {
      const parentSel = `${parentTag}.${cssEscape(parentClasses[0])}`;
      candidates.push(`${parentSel} > ${getNthOfTypeSelector(el)}`);
      candidates.push(`${parentSel} > ${tag}`);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  function rankSelectors(candidates, el) {
    return [...new Set(candidates.filter(Boolean))]
      .map((selector) => ({
        selector,
        unique: isUniqueSelector(selector, el),
        count: safeQueryCount(selector)
      }))
      .sort((a, b) => {
        if (a.unique !== b.unique) return a.unique ? -1 : 1;
        if (a.count !== b.count) return a.count - b.count;
        return a.selector.length - b.selector.length;
      });
  }

  function getBestSelectorBundle(el) {
    if (!isElement(el)) {
      return { primary: null, alternatives: [], all: [], unique: false };
    }

    const tag = getTag(el);
    const candidates = [
      ...getAttributeCandidates(el),
      ...getClassCandidates(el),
      ...getTextHintCandidates(el),
      ...getParentScopedCandidates(el)
    ];

    const name = el.getAttribute?.("name");
    const type = el.getAttribute?.("type");
    const role = el.getAttribute?.("role");
    const aria = el.getAttribute?.("aria-label");
    const placeholder = el.getAttribute?.("placeholder");

    if (tag && name && type) {
      candidates.push(`${tag}[name="${cssEscape(name)}"][type="${cssEscape(type)}"]`);
    }
    if (tag && role && aria) {
      candidates.push(`${tag}[role="${cssEscape(role)}"][aria-label="${cssEscape(aria)}"]`);
    }
    if (tag && name && placeholder) {
      candidates.push(`${tag}[name="${cssEscape(name)}"][placeholder="${cssEscape(placeholder)}"]`);
    }

    const nth = getNthOfTypeSelector(el);
    if (nth) candidates.push(nth);

    const absPath = buildAbsolutePath(el);
    if (absPath) candidates.push(absPath);

    candidates.push(tag);

    const ranked = rankSelectors(candidates, el);
    const primary = ranked[0]?.selector || null;

    return {
      primary,
      alternatives: ranked.slice(1, 6).map((x) => x.selector),
      all: ranked.slice(0, 10).map((x) => ({
        selector: x.selector,
        unique: x.unique,
        match_count: x.count
      })),
      unique: ranked[0]?.unique || false
    };
  }

  function getElementContext(el) {
    if (!isElement(el)) return null;

    const rect = el.getBoundingClientRect();
    const attrs = {};

    for (const attr of STABLE_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (value) attrs[attr] = value;
    }

    return {
      tag: getTag(el),
      id: el.id || null,
      name: el.getAttribute?.("name") || null,
      classes: getStableClasses(el).slice(0, 6),
      text: getText(el),
      direct_text: getDirectText(el),
      placeholder: el.getAttribute?.("placeholder") || null,
      type: el.getAttribute?.("type") || null,
      attributes: attrs,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function sendStep(step) {
    chrome.runtime.sendMessage(
      { type: "RECORDED_STEP", payload: step },
      () => void chrome.runtime.lastError
    );
  }

  function basePayload(action, el) {
    const selectorBundle = getBestSelectorBundle(el);

    return {
      action,
      url: location.href,
      selector: selectorBundle.primary,
      selector_candidates: selectorBundle.all,
      fallback_selectors: selectorBundle.alternatives,
      selector_is_unique: selectorBundle.unique,
      tag: el?.tagName || null,
      text: getText(el),
      value: action === "input" ? (el?.value || "") : null,
      placeholder: el?.placeholder || null,
      element_name: el?.name || null,
      element_context: getElementContext(el),
      metadata: {
        title: document.title,
        timestamp: new Date().toISOString()
      }
    };
  }

  function shouldTrackInput(el) {
    return (
      el &&
      ["INPUT", "TEXTAREA"].includes(el.tagName) &&
      !["checkbox", "radio", "range"].includes((el.type || "").toLowerCase())
    );
  }

  function getInputSignature(el) {
    const payload = basePayload("input", el);
    return JSON.stringify({
      selector: payload.selector,
      url: payload.url,
      value: payload.value
    });
  }

  function recordInputNow(el) {
    if (!shouldTrackInput(el)) return;

    const signature = getInputSignature(el);
    if (signature === lastRecordedInputSignature) return;

    lastRecordedInputSignature = signature;
    sendStep(basePayload("input", el));
  }

  function flushFocusedInputBeforeClick() {
    const active = document.activeElement;
    if (shouldTrackInput(active)) {
      recordInputNow(active);
    }
  }

  window.addEventListener(
    "click",
    (event) => {
      flushFocusedInputBeforeClick();

      const el =
        event.target?.closest?.(
          'button, a, input, textarea, select, option, label, [role="button"], [role="link"], [contenteditable="true"], [tabindex], div, span'
        ) || event.target;

      if (!el) return;
      sendStep(basePayload("click", el));
    },
    true
  );

  window.addEventListener(
    "input",
    (event) => {
      const el = event.target;
      if (!shouldTrackInput(el)) return;

      const now = Date.now();
      if (now - lastInputTs < 250) return;
      lastInputTs = now;

      recordInputNow(el);
    },
    true
  );

  window.addEventListener(
    "change",
    (event) => {
      const el = event.target;
      if (!el) return;

      if (shouldTrackInput(el)) {
        recordInputNow(el);
        return;
      }

      if (el.tagName === "INPUT" && el.type === "file") {
        sendStep(basePayload("upload", el));
      } else if (el.tagName === "SELECT") {
        sendStep(basePayload("select", el));
      }
    },
    true
  );

  window.addEventListener(
    "blur",
    (event) => {
      const el = event.target;
      if (shouldTrackInput(el)) {
        recordInputNow(el);
      }
    },
    true
  );

  let lastHref = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sendStep({
        action: "navigate",
        url: location.href,
        selector: null,
        selector_candidates: [],
        fallback_selectors: [],
        selector_is_unique: false,
        tag: null,
        text: document.title,
        value: null,
        placeholder: null,
        element_name: null,
        element_context: null,
        metadata: {
          title: document.title,
          timestamp: new Date().toISOString()
        }
      });
    }
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true
  });
})();
