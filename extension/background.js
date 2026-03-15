const API_BASE = "http://127.0.0.1:8000/api/v1";
const DEFAULT_STEP_DELAY_MS = 1000;

const playerState = {
  workflowId: null,
  tabId: null,
  steps: [],
  status: "idle", // idle | loading | running | paused | stopped | finished | error | jumping
  currentStepIndex: 0,
  totalSteps: 0,
  isLoopActive: false,
  workflowMeta: null,
  runToken: 0,
  controlLock: false,
};

async function getPlayerConfig() {
  const data = await chrome.storage.local.get(["playerConfig"]);
  return {
    stepDelayMs: Number.isFinite(data.playerConfig?.stepDelayMs)
      ? data.playerConfig.stepDelayMs
      : DEFAULT_STEP_DELAY_MS,
  };
}

async function setPlayerConfig(config) {
  const current = await getPlayerConfig();
  const next = {
    ...current,
    ...config,
    stepDelayMs:
      Number.isFinite(config?.stepDelayMs) && config.stepDelayMs >= 0
        ? config.stepDelayMs
        : current.stepDelayMs,
  };
  await chrome.storage.local.set({ playerConfig: next });
  return next;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setRunStatus(status) {
  return chrome.storage.local.set({ localRunStatus: status });
}

async function getRunStatus() {
  const data = await chrome.storage.local.get(["localRunStatus"]);
  return data.localRunStatus || null;
}

async function updateStepProgress(partial) {
  const current = (await getRunStatus()) || {};
  await setRunStatus({ ...current, ...partial, updatedAt: Date.now() });
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      await delay(800);
      return tab;
    }
    await delay(250);
  }

  throw new Error("Timed out waiting for tab to finish loading");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      typeof data === "string"
        ? data
        : data?.detail || data?.message || `HTTP ${response.status}`
    );
  }

  return data;
}

function sortSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .slice()
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0));
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

async function ensureStepPage(tabId, step) {
  if (!step?.target_url || step.action === "navigate") return;

  const tab = await chrome.tabs.get(tabId);
  const currentUrl = tab.url || "";

  if (!samePage(currentUrl, step.target_url)) {
    await chrome.tabs.update(tabId, { url: step.target_url });
    await waitForTabComplete(tabId);
  }
}

async function resolveAndExecuteInPage(tabId, step) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (stepArg) => {
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
        return (el?.innerText || el?.textContent || el?.value || "").trim();
      }

      function trySelectors(stepObj) {
        const selectors = [];
        if (stepObj.selector) selectors.push(stepObj.selector);
        selectors.push(...(stepObj.fallback_selectors || []));

        for (const item of stepObj.selector_candidates || []) {
          if (typeof item === "string") selectors.push(item);
          else if (item && item.selector) selectors.push(item.selector);
        }

        for (const selector of dedupe(selectors)) {
          try {
            const el = document.querySelector(selector);
            if (el) return { el, usedSelector: selector };
          } catch (_) {}
        }

        return null;
      }

      function tryTextFallback(stepObj) {
        const ctx = stepObj.element_context || {};
        const wantedText = (ctx.direct_text || ctx.text || stepObj.text || "").trim();
        const wantedTag = (ctx.tag || "").toLowerCase();

        if (!wantedText) return null;

        const selector = wantedTag || "a,button,input,label,span,div";
        const candidates = Array.from(document.querySelectorAll(selector));
        const normalizedWanted = wantedText.toLowerCase();

        for (const el of candidates) {
          const actual = textOf(el).toLowerCase();
          if (actual && (actual.includes(normalizedWanted) || normalizedWanted.includes(actual))) {
            return { el, usedSelector: `text:${wantedText}` };
          }
        }
        return null;
      }

      function setNativeValue(el, value) {
        const tag = el.tagName?.toLowerCase();

        if (tag === "input") {
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value"
          );
          descriptor?.set?.call(el, value);
          return;
        }

        if (tag === "textarea") {
          const descriptor = Object.getOwnPropertyDescriptor(
            HTMLTextAreaElement.prototype,
            "value"
          );
          descriptor?.set?.call(el, value);
          return;
        }

        el.value = value;
      }

      function dispatchInputEvents(el) {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
      }

      const action = stepArg.action;
      if (action === "navigate") {
        return { ok: true, usedSelector: null };
      }

      const resolved = trySelectors(stepArg) || tryTextFallback(stepArg);
      if (!resolved || !resolved.el) {
        throw new Error(`Could not resolve element for action ${action}`);
      }

      const el = resolved.el;

      if (action === "click") {
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        el.focus?.();
        el.click();
        return { ok: true, usedSelector: resolved.usedSelector };
      }

      if (action === "input") {
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        el.focus?.();
        setNativeValue(el, stepArg.value ?? "");
        dispatchInputEvents(el);
        return { ok: true, usedSelector: resolved.usedSelector };
      }

      if (action === "select") {
        el.value = stepArg.value ?? "";
        dispatchInputEvents(el);
        return { ok: true, usedSelector: resolved.usedSelector };
      }

      throw new Error(`Unsupported local action: ${action}`);
    },
    args: [step],
  });

  return result;
}

async function uploadAndProcessWorkflow({ name, description }) {
  const { steps = [] } = await chrome.storage.local.get(["steps"]);
  const recordedSteps = Array.isArray(steps) ? steps : [];

  if (!recordedSteps.length) {
    throw new Error("No recorded steps found.");
  }

  const payload = {
    name: name || "My recorded workflow",
    description: description || "Recorded from Chrome extension",
    source_url: recordedSteps[0]?.url || null,
    raw_steps: recordedSteps,
  };

  await updateStepProgress({ phase: "uploading", message: "Workflow is uploading..." });

  const data = await fetchJson(`${API_BASE}/workflows`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  await updateStepProgress({
    phase: "processed",
    message: "Workflow uploaded and processed successfully.",
    workflowId: data.workflow_id,
    processedStepCount: data.processed_step_count,
    rawStepCount: data.raw_step_count,
  });

  await chrome.storage.local.set({ lastWorkflowId: data.workflow_id });
  return data;
}

function invalidateRunningLoop() {
  playerState.runToken += 1;
}

async function waitForLoopToStop(timeoutMs = 15000) {
  const start = Date.now();
  while (playerState.isLoopActive) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for current run loop to stop.");
    }
    await delay(50);
  }
}

async function withControlLock(fn) {
  if (playerState.controlLock) {
    throw new Error("Another player action is already in progress.");
  }

  playerState.controlLock = true;
  try {
    return await fn();
  } finally {
    playerState.controlLock = false;
  }
}

async function pauseLoopIfRunning(pauseMessage = "Workflow paused.") {
  if (playerState.status === "running") {
    playerState.status = "paused";
    invalidateRunningLoop();
    await waitForLoopToStop();
    await updateStepProgress({
      phase: "paused",
      message: pauseMessage,
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
      completedSteps: playerState.currentStepIndex,
    });
  }
}

async function loadWorkflowIntoPlayer(workflowId) {
  const workflow = await fetchJson(`${API_BASE}/workflows/${workflowId}/executable`);
  const steps = sortSteps(workflow.steps);

  if (!steps.length) {
    throw new Error("Workflow has no executable steps.");
  }

  const firstNavigate = steps.find((step) => step.action === "navigate" && step.target_url);
  const startUrl = firstNavigate?.target_url || workflow.source_url;

  if (!startUrl) {
    throw new Error("No start URL found for workflow.");
  }

  playerState.status = "loading";
  await updateStepProgress({
    phase: "fetching",
    message: `Loading workflow ${workflowId}...`,
    workflowId,
  });

  const tab = await chrome.tabs.create({ url: startUrl, active: true });
  await waitForTabComplete(tab.id);

  playerState.workflowId = workflowId;
  playerState.tabId = tab.id;
  playerState.steps = steps;
  playerState.status = "paused";
  playerState.currentStepIndex = 0;
  playerState.totalSteps = steps.length;
  playerState.workflowMeta = workflow;
  invalidateRunningLoop();

  await updateStepProgress({
    phase: "paused",
    message: `Workflow ${workflowId} loaded locally.`,
    workflowId,
    currentStepIndex: 0,
    totalSteps: steps.length,
    completedSteps: 0,
  });

  return { workflowId, totalSteps: steps.length, tabId: tab.id };
}

async function executeStepAtIndex(index, runTokenAtStart = null) {
  if (!playerState.steps.length) {
    throw new Error("No loaded workflow.");
  }
  if (index < 0 || index >= playerState.steps.length) {
    throw new Error("Step index out of range.");
  }
  if (!playerState.tabId) {
    throw new Error("No active workflow tab.");
  }

  const step = playerState.steps[index];

  await updateStepProgress({
    phase: "running",
    message: `Running step ${index + 1} of ${playerState.totalSteps}: ${step.name || step.action}`,
    workflowId: playerState.workflowId,
    currentStepIndex: index,
    totalSteps: playerState.totalSteps,
    currentStep: step,
    completedSteps: index,
  });

  if (runTokenAtStart !== null && runTokenAtStart !== playerState.runToken) {
    return;
  }

  if (step.action === "navigate") {
    if (step.target_url) {
      await chrome.tabs.update(playerState.tabId, { url: step.target_url });
      await waitForTabComplete(playerState.tabId);
    }
  } else {
    await ensureStepPage(playerState.tabId, step);

    const beforeTab = await chrome.tabs.get(playerState.tabId);
    const beforeUrl = beforeTab.url || "";

    if (runTokenAtStart !== null && runTokenAtStart !== playerState.runToken) {
      return;
    }

    await resolveAndExecuteInPage(playerState.tabId, step);

    const { stepDelayMs } = await getPlayerConfig();
    await delay(stepDelayMs);

    const afterTab = await chrome.tabs.get(playerState.tabId);
    const afterUrl = afterTab.url || "";

    if (afterUrl !== beforeUrl) {
      await waitForTabComplete(playerState.tabId);
    }
  }

  const { stepDelayMs } = await getPlayerConfig();
  await delay(stepDelayMs);
}

async function runLoop(runToken) {
  if (playerState.isLoopActive) return;
  playerState.isLoopActive = true;

  try {
    while (playerState.status === "running" && runToken === playerState.runToken) {
      if (playerState.currentStepIndex >= playerState.totalSteps) {
        playerState.status = "finished";
        await updateStepProgress({
          phase: "success",
          message: `Workflow ${playerState.workflowId} completed locally.`,
          workflowId: playerState.workflowId,
          currentStepIndex: playerState.totalSteps,
          totalSteps: playerState.totalSteps,
          completedSteps: playerState.totalSteps,
        });
        break;
      }

      const currentIndex = playerState.currentStepIndex;
      await executeStepAtIndex(currentIndex, runToken);

      if (runToken !== playerState.runToken || playerState.status !== "running") {
        break;
      }

      playerState.currentStepIndex += 1;

      await updateStepProgress({
        phase: "running",
        workflowId: playerState.workflowId,
        currentStepIndex: playerState.currentStepIndex,
        totalSteps: playerState.totalSteps,
        completedSteps: playerState.currentStepIndex,
      });
    }
  } catch (error) {
    playerState.status = "error";
    await updateStepProgress({
      phase: "error",
      message: error?.message || String(error),
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
    });
  } finally {
    playerState.isLoopActive = false;
  }
}

async function replayToStep(targetIndex) {
  if (!playerState.steps.length) throw new Error("No loaded workflow.");
  if (targetIndex < 0 || targetIndex >= playerState.totalSteps) {
    throw new Error("Target step out of range.");
  }
  if (!playerState.tabId) throw new Error("No active workflow tab.");

  await pauseLoopIfRunning("Workflow paused for replay.");

  playerState.status = "jumping";
  invalidateRunningLoop();

  await updateStepProgress({
    phase: "jumping",
    message: `Jumping to step ${targetIndex + 1}...`,
    workflowId: playerState.workflowId,
    currentStepIndex: targetIndex,
    totalSteps: playerState.totalSteps,
    completedSteps: targetIndex,
  });

  const firstNavigate = playerState.steps.find((step) => step.action === "navigate" && step.target_url);
  const startUrl = firstNavigate?.target_url || playerState.workflowMeta?.source_url;
  if (!startUrl) throw new Error("No start URL found for replay.");

  await chrome.tabs.update(playerState.tabId, { url: startUrl });
  await waitForTabComplete(playerState.tabId);

  for (let i = 0; i < targetIndex; i += 1) {
    await executeStepAtIndex(i, null);
  }

  playerState.currentStepIndex = targetIndex;
  playerState.status = "paused";

  await updateStepProgress({
    phase: "paused",
    message: `Paused at step ${targetIndex + 1}.`,
    workflowId: playerState.workflowId,
    currentStepIndex: targetIndex,
    totalSteps: playerState.totalSteps,
    completedSteps: targetIndex,
  });
}

async function startLocalRun(workflowId) {
  return withControlLock(async () => {
    invalidateRunningLoop();
    await waitForLoopToStop().catch(() => {});

    await updateStepProgress({
      phase: "fetching",
      message: `Fetching workflow ${workflowId}...`,
      workflowId,
    });

    await loadWorkflowIntoPlayer(workflowId);

    playerState.status = "running";
    const token = ++playerState.runToken;
    runLoop(token);

    return { workflowId, totalSteps: playerState.totalSteps };
  });
}

async function playerPlay() {
  return withControlLock(async () => {
    if (!playerState.steps.length) throw new Error("No workflow loaded.");

    if (playerState.status === "running") {
      return { ok: true, currentStepIndex: playerState.currentStepIndex };
    }

    if (playerState.status === "finished") {
      playerState.currentStepIndex = 0;
    }

    playerState.status = "running";
    const token = ++playerState.runToken;

    await updateStepProgress({
      phase: "running",
      message: "Resuming workflow execution...",
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
      completedSteps: playerState.currentStepIndex,
    });

    runLoop(token);
    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

async function playerPause() {
  return withControlLock(async () => {
    if (!playerState.steps.length) throw new Error("No workflow loaded.");
    await pauseLoopIfRunning("Workflow paused.");
    playerState.status = "paused";
    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

async function playerStop() {
  return withControlLock(async () => {
    invalidateRunningLoop();
    await waitForLoopToStop().catch(() => {});
    playerState.status = "stopped";

    await updateStepProgress({
      phase: "stopped",
      message: "Workflow stopped.",
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
      completedSteps: playerState.currentStepIndex,
    });

    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

async function playerNext() {
  return withControlLock(async () => {
    if (!playerState.steps.length) throw new Error("No workflow loaded.");
    if (playerState.currentStepIndex >= playerState.totalSteps) {
      throw new Error("Already at the end of the workflow.");
    }

    await pauseLoopIfRunning("Workflow paused before executing next step.");

    playerState.status = "paused";
    await executeStepAtIndex(playerState.currentStepIndex, null);
    playerState.currentStepIndex += 1;

    await updateStepProgress({
      phase: "paused",
      message: "Executed one step.",
      workflowId: playerState.workflowId,
      currentStepIndex: playerState.currentStepIndex,
      totalSteps: playerState.totalSteps,
      completedSteps: playerState.currentStepIndex,
    });

    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

async function playerPrev() {
  return withControlLock(async () => {
    if (!playerState.steps.length) throw new Error("No workflow loaded.");
    const targetIndex = Math.max(0, playerState.currentStepIndex - 1);
    await replayToStep(targetIndex);
    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

async function playerJump(stepIndex) {
  return withControlLock(async () => {
    if (!playerState.steps.length) throw new Error("No workflow loaded.");

    const safeIndex = Number(stepIndex);
    if (!Number.isInteger(safeIndex)) {
      throw new Error("Jump step must be an integer.");
    }

    await replayToStep(safeIndex);
    return { ok: true, currentStepIndex: playerState.currentStepIndex };
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "RECORDED_STEP") {
        const { recording, steps = [] } = await chrome.storage.local.get(["recording", "steps"]);
        if (!recording) {
          sendResponse({ ok: false });
          return;
        }
        const next = [...steps, message.payload];
        await chrome.storage.local.set({ steps: next });
        sendResponse({ ok: true, count: next.length });
        return;
      }

      if (message.type === "START_RECORDING") {
        await chrome.storage.local.set({ recording: true, steps: [], localRunStatus: null });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "STOP_RECORDING") {
        await chrome.storage.local.set({ recording: false });
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "UPLOAD_AND_PROCESS_WORKFLOW") {
        const result = await uploadAndProcessWorkflow(message.payload || {});
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "RUN_WORKFLOW_LOCALLY") {
        const result = await startLocalRun(message.workflowId);
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_PLAY") {
        const result = await playerPlay();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_PAUSE") {
        const result = await playerPause();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_STOP") {
        const result = await playerStop();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_NEXT") {
        const result = await playerNext();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_PREV") {
        const result = await playerPrev();
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "PLAYER_JUMP") {
        const result = await playerJump(Number(message.stepIndex));
        sendResponse({ ok: true, data: result });
        return;
      }

      if (message.type === "GET_LOCAL_RUN_STATUS") {
        sendResponse({ ok: true, data: await getRunStatus() });
        return;
      }

      if (message.type === "GET_RECORDING_STATE") {
        const data = await chrome.storage.local.get(["recording", "steps", "lastWorkflowId"]);
        sendResponse({
          ok: true,
          data: {
            recording: !!data.recording,
            stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
            lastWorkflowId: data.lastWorkflowId || null,
          },
        });
        return;
      }

      if (message.type === "GET_PLAYER_CONFIG") {
        sendResponse({ ok: true, data: await getPlayerConfig() });
        return;
      }

      if (message.type === "SET_PLAYER_CONFIG") {
        const result = await setPlayerConfig(message.config || {});
        sendResponse({ ok: true, data: result });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (error) {
      console.error(error);
      await updateStepProgress({
        phase: "error",
        message: error?.message || "Unknown error",
      });
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});
