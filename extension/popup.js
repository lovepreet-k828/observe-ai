async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

const els = {
  startRecording: document.getElementById("startRecording"),
  stopUpload: document.getElementById("stopUpload"),
  recordingInfo: document.getElementById("recordingInfo"),
  workflowIdInput: document.getElementById("workflowIdInput"),
  runLocal: document.getElementById("runLocal"),
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

function setSpinner(show) {
  if (!els.spinnerWrap) return;
  els.spinnerWrap.classList.toggle("hidden", !show);
}

function setStatus(text) {
  if (!els.status) return;
  els.status.textContent = text;
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

async function refreshState() {
  try {
    const recordingRes = await sendMessage({ type: "GET_RECORDING_STATE" });
    if (recordingRes?.ok && els.recordingInfo) {
      const state = recordingRes.data;
      els.recordingInfo.textContent = state.recording
        ? `Recording... ${state.stepCount} step(s)`
        : `Not recording. Last workflow ID: ${state.lastWorkflowId ?? "none"}`;

      if (els.workflowIdInput && !els.workflowIdInput.value && state.lastWorkflowId) {
        els.workflowIdInput.value = String(state.lastWorkflowId);
      }
    }

    const runStatusRes = await sendMessage({ type: "GET_LOCAL_RUN_STATUS" });
    if (runStatusRes?.ok) {
      const data = runStatusRes.data;
      setStatus(formatRunStatus(data));
      const active =
        data &&
        ["uploading", "fetching", "starting", "running", "jumping"].includes(data.phase);
      setSpinner(!!active);
    }

    if (els.stepDelayInput) {
      const configRes = await sendMessage({ type: "GET_PLAYER_CONFIG" });
      if (configRes?.ok && !els.stepDelayInput.value) {
        els.stepDelayInput.value = String(configRes.data?.stepDelayMs ?? 1000);
      }
    }
  } catch (err) {
    setStatus(err?.message || String(err));
    setSpinner(false);
  }
}

if (els.startRecording) {
  els.startRecording.addEventListener("click", async () => {
    try {
      const res = await sendMessage({ type: "START_RECORDING" });
      if (res?.ok) {
        setStatus("Recording started.");
        await refreshState();
      } else {
        setStatus(res?.error || "Failed to start recording.");
      }
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  });
}

if (els.stopUpload) {
  els.stopUpload.addEventListener("click", async () => {
    try {
      setSpinner(true);
      setStatus("Stopping recording...");
      await sendMessage({ type: "STOP_RECORDING" });

      const res = await sendMessage({
        type: "UPLOAD_AND_PROCESS_WORKFLOW",
        payload: {
          name: "My recorded workflow",
          description: "Recorded from Chrome extension",
        },
      });

      if (!res?.ok) throw new Error(res?.error || "Upload failed");

      const workflowId = res.data?.workflow_id;
      if (workflowId && els.workflowIdInput) {
        els.workflowIdInput.value = String(workflowId);
      }

      setStatus(
        `Workflow uploaded and processed successfully.\nWorkflow ID: ${workflowId}\nRaw steps: ${res.data?.raw_step_count}\nProcessed steps: ${res.data?.processed_step_count}`
      );
    } catch (err) {
      setStatus(`Error: ${err?.message || String(err)}`);
    } finally {
      setSpinner(false);
      refreshState();
    }
  });
}

if (els.runLocal) {
  els.runLocal.addEventListener("click", async () => {
    try {
      const workflowId = Number(els.workflowIdInput?.value);
      if (!workflowId) {
        setStatus("Enter a workflow ID first.");
        return;
      }

      const res = await sendMessage({ type: "RUN_WORKFLOW_LOCALLY", workflowId });
      if (!res?.ok) {
        setStatus(res?.error || "Failed to start local run.");
        return;
      }
      refreshState();
    } catch (err) {
      setStatus(err?.message || String(err));
    }
  });
}

if (els.playBtn) {
  els.playBtn.addEventListener("click", async () => {
    const res = await sendMessage({ type: "PLAYER_PLAY" });
    if (!res?.ok) setStatus(res?.error || "Failed to play.");
    refreshState();
  });
}

if (els.pauseBtn) {
  els.pauseBtn.addEventListener("click", async () => {
    const res = await sendMessage({ type: "PLAYER_PAUSE" });
    if (!res?.ok) setStatus(res?.error || "Failed to pause.");
    refreshState();
  });
}

if (els.stopBtn) {
  els.stopBtn.addEventListener("click", async () => {
    const res = await sendMessage({ type: "PLAYER_STOP" });
    if (!res?.ok) setStatus(res?.error || "Failed to stop.");
    refreshState();
  });
}

if (els.nextBtn) {
  els.nextBtn.addEventListener("click", async () => {
    const res = await sendMessage({ type: "PLAYER_NEXT" });
    if (!res?.ok) setStatus(res?.error || "Failed to step forward.");
    refreshState();
  });
}

if (els.prevBtn) {
  els.prevBtn.addEventListener("click", async () => {
    const res = await sendMessage({ type: "PLAYER_PREV" });
    if (!res?.ok) setStatus(res?.error || "Failed to step backward.");
    refreshState();
  });
}

if (els.jumpBtn) {
  els.jumpBtn.addEventListener("click", async () => {
    const stepIndex = Number(els.jumpStepInput?.value);
    if (Number.isNaN(stepIndex)) {
      setStatus("Enter a valid step index.");
      return;
    }

    const res = await sendMessage({ type: "PLAYER_JUMP", stepIndex });
    if (!res?.ok) setStatus(res?.error || "Failed to jump.");
    refreshState();
  });
}

if (els.stepDelayInput) {
  els.stepDelayInput.addEventListener("change", async () => {
    const delayMs = Number(els.stepDelayInput.value);
    const safeDelay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 1000;

    const res = await sendMessage({
      type: "SET_PLAYER_CONFIG",
      config: { stepDelayMs: safeDelay },
    });

    if (!res?.ok) {
      setStatus(res?.error || "Failed to save delay.");
      return;
    }

    setStatus(`Step delay set to ${safeDelay} ms.`);
  });
}

refreshState();
setInterval(refreshState, 800);
