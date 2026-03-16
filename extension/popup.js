async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

const els = {
  startRecording: document.getElementById("startRecording"),
  stopUpload: document.getElementById("stopUpload"),
  recordingInfo: document.getElementById("recordingInfo"),
  workflowIdInput: document.getElementById("workflowIdInput"),
  loadReview: document.getElementById("loadReview"),
  runLocal: document.getElementById("runLocal"),
  saveReview: document.getElementById("saveReview"),
  approveRun: document.getElementById("approveRun"),
  clearHighlight: document.getElementById("clearHighlight"),
  reviewMeta: document.getElementById("reviewMeta"),
  reviewList: document.getElementById("reviewList"),
  playBtn: document.getElementById("playBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  stopBtn: document.getElementById("stopBtn"),
  jumpStepInput: document.getElementById("jumpStepInput"),
  jumpBtn: document.getElementById("jumpBtn"),
  stepDelayInput: document.getElementById("stepDelayInput"),
  spinnerWrap: document.getElementById("spinnerWrap"),
  status: document.getElementById("status"),
};

let currentReview = null;
let highlightedStepIndex = null;

function setSpinner(show) {
  els.spinnerWrap?.classList.toggle("hidden", !show);
}

function setStatus(text) {
  if (els.status) els.status.textContent = text;
}

function formatRunStatus(data) {
  if (!data) return "Idle.";
  const parts = [];
  if (data.phase) parts.push(`Phase: ${data.phase}`);
  if (data.message) parts.push(data.message);
  if (typeof data.currentStepIndex === "number" && typeof data.totalSteps === "number") {
    parts.push(`Step: ${data.currentStepIndex + 1} / ${data.totalSteps}`);
  } else if (typeof data.completedSteps === "number" && typeof data.totalSteps === "number") {
    parts.push(`Completed: ${data.completedSteps} / ${data.totalSteps}`);
  }
  if (data.workflowId) parts.push(`Workflow ID: ${data.workflowId}`);
  if (data.currentStep?.name) parts.push(`Current: ${data.currentStep.name}`);
  return parts.join("\n");
}

function confidenceClass(confidence) {
  if (confidence >= 80) return "pill pill-high";
  if (confidence >= 60) return "pill pill-mid";
  return "pill pill-low";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function emptyReviewState(message = "Load a workflow review to inspect generated steps.") {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function getWorkflowIdFromInput() {
  return Number(els.workflowIdInput?.value);
}

function collectReviewStepsFromDom() {
  const cards = [...document.querySelectorAll(".review-card")];
  return cards.map((card, index) => {
    const source = currentReview?.steps?.[index] || {};
    const action = card.querySelector(".field-action")?.value || source.action || "click";
    const name = card.querySelector(".field-name")?.value || source.name || "";
    const target_url = card.querySelector(".field-url")?.value || null;
    const selector = card.querySelector(".field-selector")?.value || null;
    const value = card.querySelector(".field-value")?.value || null;
    return {
      ...source,
      order_index: index,
      action,
      name,
      target_url,
      selector,
      value,
      confidence: Number(source.preview?.confidence ?? source.confidence ?? 50),
    };
  });
}

async function persistPopupUiState() {
  await chrome.storage.local.set({ popupUiState: { workflowId: getWorkflowIdFromInput(), highlightedStepIndex, updatedAt: Date.now() } });
}

function applyHighlightedReviewState() {
  document.querySelectorAll(".review-card").forEach((card) => {
    const idx = Number(card.dataset.stepIndex || -1);
    card.classList.toggle("is-highlighted", idx === highlightedStepIndex);
    const btn = card.querySelector(".action-highlight");
    if (btn) btn.textContent = idx === highlightedStepIndex ? "Highlighted on page" : "Highlight";
  });
}

function renderReview(review) {
  currentReview = review;
  if (!review || !Array.isArray(review.steps) || !review.steps.length) {
    els.reviewMeta.textContent = "No workflow loaded.";
    els.reviewList.innerHTML = emptyReviewState();
    return;
  }

  const statusText = review.requiresReview ? "Needs approval" : "Approved";
  els.reviewMeta.textContent = `${review.steps.length} step(s) • ${statusText}${review.sourceUrl ? ` • ${review.sourceUrl}` : ""}`;
  els.reviewList.innerHTML = review.steps
    .map((step, index) => {
      const confidence = step.preview?.confidence ?? step.confidence ?? 0;
      const predictedSelector = step.preview?.predicted_selector || step.selector || "";
      const reason = step.preview?.match_reason || "No match reason available.";
      const provider = step.preview?.preview_metadata?.provider || step.llm_metadata?.provider || "recorded";
      return `
        <div class="review-card" data-step-index="${index}">
          <div class="review-head">
            <div>
              <div class="review-title">#${index + 1} ${escapeHtml(step.name || step.action)}</div>
              <div class="review-meta">
                <span class="meta-chip">${escapeHtml(step.action || "step")}</span>
                <span class="meta-chip">provider: ${escapeHtml(provider)}</span>
                ${step.target_url ? `<span class="meta-chip">page scoped</span>` : ""}
              </div>
            </div>
            <span class="${confidenceClass(confidence)}">${confidence}% confidence</span>
          </div>
          <div class="grid-2">
            <div class="field-wrap">
              <div class="label">Action</div>
              <select class="field-action">
                ${["navigate", "click", "input", "select", "upload"]
                  .map((action) => `<option value="${action}" ${step.action === action ? "selected" : ""}>${action}</option>`)
                  .join("")}
              </select>
            </div>
            <div class="field-wrap">
              <div class="label">Name</div>
              <input class="field-name" value="${escapeHtml(step.name || "")}" />
            </div>
          </div>
          <div class="field-wrap">
            <div class="label">Target URL</div>
            <input class="field-url" value="${escapeHtml(step.target_url || "")}" />
          </div>
          <div class="field-wrap">
            <div class="label">Selector / highlighted element</div>
            <textarea class="field-selector">${escapeHtml(predictedSelector)}</textarea>
          </div>
          <div class="field-wrap">
            <div class="label">Value / text to type</div>
            <input class="field-value" value="${escapeHtml(step.value || step.text || "")}" />
          </div>
          <div class="small-muted">${escapeHtml(reason)}</div>
          <div class="row" style="margin-top:10px; margin-bottom:0;">
            <button class="secondary action-highlight" data-step-index="${index}">Highlight</button>
          </div>
        </div>
      `;
    })
    .join("");

  applyHighlightedReviewState();

  [...document.querySelectorAll(".action-highlight")].forEach((button) => {
    button.addEventListener("click", async () => {
      const stepIndex = Number(button.dataset.stepIndex || 0);
      const workflowId = currentReview?.workflowId || getWorkflowIdFromInput();
      try {
        setSpinner(true);
        const res = await sendMessage({ type: "HIGHLIGHT_REVIEW_STEP", workflowId, stepIndex });
        if (!res?.ok) throw new Error(res?.error || "Could not highlight step.");
        const usedSelector = res.data?.highlight?.usedSelector ? `\nResolved with: ${res.data.highlight.usedSelector}` : "";
        setStatus(`Highlighted step ${stepIndex + 1}.${usedSelector}`);
      } catch (err) {
        setStatus(err?.message || String(err));
      } finally {
        setSpinner(false);
      }
    });
  });
}

async function loadReview() {
  const workflowId = getWorkflowIdFromInput();
  if (!workflowId) {
    setStatus("Enter a workflow ID first.");
    return;
  }
  setSpinner(true);
  try {
    const res = await sendMessage({ type: "GET_WORKFLOW_REVIEW", workflowId });
    if (!res?.ok) throw new Error(res?.error || "Failed to load workflow review.");
    renderReview(res.data);
    await persistPopupUiState();
    setStatus(`Loaded Ghost Mode review for workflow ${workflowId}.`);
  } catch (err) {
    setStatus(err?.message || String(err));
  } finally {
    setSpinner(false);
  }
}

async function saveReview(markReviewed = true, alsoRun = false) {
  const workflowId = getWorkflowIdFromInput();
  if (!workflowId) {
    setStatus("Enter a workflow ID first.");
    return;
  }
  const steps = collectReviewStepsFromDom();
  setSpinner(true);
  try {
    const type = alsoRun ? "APPROVE_AND_RUN_WORKFLOW" : "SAVE_WORKFLOW_REVIEW";
    const res = await sendMessage({ type, workflowId, steps, markReviewed });
    if (!res?.ok) throw new Error(res?.error || "Failed to save workflow review.");
    await loadReview();
    setStatus(
      alsoRun
        ? `Workflow ${workflowId} approved and loaded into player.`
        : markReviewed
          ? `Workflow ${workflowId} approved.`
          : `Workflow ${workflowId} edits saved.`
    );
  } catch (err) {
    setStatus(err?.message || String(err));
  } finally {
    setSpinner(false);
  }
}

async function refreshState() {
  try {
    const recordingRes = await sendMessage({ type: "GET_RECORDING_STATE" });
    if (recordingRes?.ok && els.recordingInfo) {
      const state = recordingRes.data;
      els.recordingInfo.textContent = state.recording
        ? `Recording is active. Captured ${state.stepCount} step(s).`
        : `Recorder idle. Last workflow ID: ${state.lastWorkflowId ?? "none"}`;
      if (els.workflowIdInput && !els.workflowIdInput.value && state.lastWorkflowId) {
        els.workflowIdInput.value = String(state.lastWorkflowId);
      }
    }

    const runStatusRes = await sendMessage({ type: "GET_LOCAL_RUN_STATUS" });
    if (runStatusRes?.ok) {
      const data = runStatusRes.data;
      setStatus(formatRunStatus(data));
      const active = data && ["uploading", "fetching", "starting", "running", "jumping", "reviewing"].includes(data.phase);
      setSpinner(!!active);
    }

    if (els.stepDelayInput && !els.stepDelayInput.value) {
      const configRes = await sendMessage({ type: "GET_PLAYER_CONFIG" });
      if (configRes?.ok) els.stepDelayInput.value = String(configRes.data?.stepDelayMs ?? 1000);
    }
  } catch (err) {
    setStatus(err?.message || String(err));
    setSpinner(false);
  }
}

els.startRecording?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "START_RECORDING" });
  setStatus(res?.ok ? "Recording started." : res?.error || "Failed to start recording.");
  refreshState();
});

els.stopUpload?.addEventListener("click", async () => {
  setSpinner(true);
  try {
    await sendMessage({ type: "STOP_RECORDING" });
    const res = await sendMessage({ type: "UPLOAD_AND_PROCESS_WORKFLOW", payload: { name: "My recorded workflow", description: "Recorded from Chrome extension" } });
    if (!res?.ok) throw new Error(res?.error || "Upload failed");
    const workflowId = res.data?.workflow_id;
    if (workflowId && els.workflowIdInput) els.workflowIdInput.value = String(workflowId);
    setStatus(`Workflow uploaded and processed successfully.\nWorkflow ID: ${workflowId}\nRaw steps: ${res.data?.raw_step_count}\nProcessed steps: ${res.data?.processed_step_count}`);
    await loadReview();
  } catch (err) {
    setStatus(`Error: ${err?.message || String(err)}`);
  } finally {
    setSpinner(false);
    refreshState();
  }
});

els.loadReview?.addEventListener("click", loadReview);
els.saveReview?.addEventListener("click", () => saveReview(false, false));
els.approveRun?.addEventListener("click", () => saveReview(true, true));
els.clearHighlight?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "CLEAR_HIGHLIGHT" });
  if (res?.ok) {
    highlightedStepIndex = null;
    applyHighlightedReviewState();
    await persistPopupUiState();
  }
  setStatus(res?.ok ? "Highlight cleared." : res?.error || "Failed to clear highlight.");
});

els.runLocal?.addEventListener("click", async () => {
  const workflowId = getWorkflowIdFromInput();
  if (!workflowId) return setStatus("Enter a workflow ID first.");
  const res = await sendMessage({ type: "RUN_WORKFLOW_LOCALLY", workflowId });
  setStatus(res?.ok ? `Workflow ${workflowId} loaded into player.` : res?.error || "Failed to load workflow.");
  refreshState();
});

els.playBtn?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "PLAYER_PLAY" });
  if (!res?.ok) setStatus(res?.error || "Failed to play.");
  refreshState();
});
els.pauseBtn?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "PLAYER_PAUSE" });
  if (!res?.ok) setStatus(res?.error || "Failed to pause.");
  refreshState();
});
els.stopBtn?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "PLAYER_STOP" });
  if (!res?.ok) setStatus(res?.error || "Failed to stop.");
  refreshState();
});
els.nextBtn?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "PLAYER_NEXT" });
  if (!res?.ok) setStatus(res?.error || "Failed to step forward.");
  refreshState();
});
els.prevBtn?.addEventListener("click", async () => {
  const res = await sendMessage({ type: "PLAYER_PREV" });
  if (!res?.ok) setStatus(res?.error || "Failed to step backward.");
  refreshState();
});
els.jumpBtn?.addEventListener("click", async () => {
  const stepIndex = Number(els.jumpStepInput?.value);
  if (Number.isNaN(stepIndex)) return setStatus("Enter a valid step index.");
  const res = await sendMessage({ type: "PLAYER_JUMP", stepIndex });
  if (!res?.ok) setStatus(res?.error || "Failed to jump.");
  refreshState();
});
els.stepDelayInput?.addEventListener("change", async () => {
  const delayMs = Number(els.stepDelayInput.value);
  const safeDelay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 1000;
  const res = await sendMessage({ type: "SET_PLAYER_CONFIG", config: { stepDelayMs: safeDelay } });
  setStatus(res?.ok ? `Step delay set to ${safeDelay} ms.` : res?.error || "Failed to save delay.");
});

async function restoreCachedReviewState() {
  try {
    const cache = await sendMessage({ type: "GET_CACHED_REVIEW_STATE" });
    if (!cache?.ok) return;
    const { lastReview, currentHighlight, lastWorkflowId } = cache.data || {};
    const popupState = (await chrome.storage.local.get(["popupUiState"]))?.popupUiState || {};
    const preferredWorkflowId = popupState.workflowId || currentHighlight?.workflowId || lastReview?.workflowId || lastWorkflowId;
    if (els.workflowIdInput && preferredWorkflowId && !els.workflowIdInput.value) {
      els.workflowIdInput.value = String(preferredWorkflowId);
    }
    highlightedStepIndex = Number.isInteger(popupState.highlightedStepIndex) ? popupState.highlightedStepIndex : (Number.isInteger(currentHighlight?.stepIndex) ? currentHighlight.stepIndex : null);
    if (lastReview?.workflowId && String(lastReview.workflowId) === String(preferredWorkflowId)) {
      renderReview(lastReview);
      const msg = highlightedStepIndex !== null
        ? `Restored Ghost Mode review for workflow ${lastReview.workflowId}. Highlighted step ${highlightedStepIndex + 1} is still active on the page.`
        : `Restored Ghost Mode review for workflow ${lastReview.workflowId}.`;
      setStatus(msg);
    }
  } catch (err) {
    console.warn("Failed to restore cached review state", err);
  }
}

(async () => {
  await restoreCachedReviewState();
  await refreshState();
  setInterval(refreshState, 1000);
})();
