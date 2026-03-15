# ObserveAI

**From observation to automation: your AI assistant for repetitive digital tasks.**

ObserveAI learns a browser workflow by watching a user perform it once, converts that observation into a reusable automation plan, previews the plan in a transparent **Ghost Mode**, and then executes it either locally in the user’s browser or through a managed automation path.

This project was built around the idea that users should not have to write brittle scripts or maintain fragile RPA bots just to automate repetitive web tasks.

---

## Inspiration

Modern work increasingly happens through web interfaces: expense portals, CRMs, internal dashboards, government forms, support tools, and admin panels. These systems promise efficiency, yet people still spend hours repeating the same manual sequences.

Traditional automation and RPA tools can work, but they are often fragile and break when the UI changes.

We wanted to explore a different idea:

> **What if AI could simply watch you perform a task once and then automate it for you?**

---

## What ObserveAI does

ObserveAI records what a user does in the browser and turns that recording into a reusable workflow.

It combines:

- recorded browser actions
- DOM structure and selector context
- AI-based workflow normalization
- Ghost Mode preview for trust and transparency
- local browser execution inside the user’s own Chrome session

In practice, the system can:

- record actions such as clicks, navigation, typing, selection, and file-related events
- store the raw browser trace
- process noisy raw events into cleaner executable workflow steps
- preview the generated steps before running them
- execute the workflow later in the user’s browser
- stay more resilient than simple selector-only automation by preserving fallback selectors and element context

---

## Key features

### 1. Observe once, automate later
A Chrome extension records user actions directly from the browser.

### 2. AI-powered workflow processing
Recorded steps are normalized into a cleaner workflow using **Amazon Nova Lite** and rule-based preprocessing.

### 3. Ghost Mode preview
ObserveAI can generate a step-by-step preview before execution so users can inspect the planned automation.

### 4. Local execution in the client browser
Workflows can run directly inside the user’s Chrome session through the extension, which is useful for workflows that depend on the user’s own cookies, sessions, and permissions.

### 5. Player-style execution controls
The extension supports controls such as:

- Play / Resume
- Pause
- Stop
- Next step
- Previous step
- Jump to step
- configurable delay between steps

### 6. Adaptive selector strategy
Each recorded interaction stores:

- a primary selector
- fallback selectors
- selector candidates with match counts
- DOM and text context

This makes replay more robust than using a single brittle CSS selector.

---

## How it works

### High-level flow

1. **Record** a task in the browser using the extension.
2. **Upload** the raw steps to the backend.
3. **Process** the raw steps into a replayable workflow.
4. **Preview** the workflow through Ghost Mode.
5. **Run** the workflow locally from the extension.

### Example

A user performs a repetitive task such as:

- open a portal
- click login
- type into fields
- navigate to a page
- submit or continue

ObserveAI records those actions once and later replays them as a structured workflow.

---

## Architecture

This repository currently contains two main parts:

### 1. Backend (`backend/`)
FastAPI backend that:

- stores workflows and raw steps
- processes steps into executable workflow steps
- exposes preview and execution APIs
- integrates with Amazon Nova services where available
- stores data in SQLite by default

### 2. Chrome Extension (`extension/`)
Browser extension that:

- records user actions
- uploads and auto-processes workflows
- runs workflows locally in the browser
- provides player controls for step-by-step execution

---

## AI and automation stack

ObserveAI is designed around the Amazon Nova ecosystem plus browser automation tooling.

### Amazon Nova Lite
Used for workflow reasoning and normalization:

- converts raw browser recordings into cleaner workflow steps
- preserves selectors and action order
- assigns confidence and metadata
- helps clean noisy input sequences

### Amazon Nova Multimodal Embeddings
Used for UI similarity and matching logic in Ghost Mode / fallback matching workflows.

### Nova Act
The project vision includes Nova Act for reliable browser actions, but the current practical implementation in this repository executes workflows primarily through the Chrome extension and browser-side automation logic. This choice keeps the demo reliable and accessible in environments where Nova Act access may be limited.

### Browser execution
Current execution is performed in the browser through the extension using:

- `chrome.tabs`
- `chrome.scripting.executeScript`
- DOM interaction logic in the active page

This gives the product a more realistic user-side automation model.

---

## Repository structure

```text
.
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   ├── db/
│   │   ├── models/
│   │   ├── schemas/
│   │   └── services/
│   └── requirements.txt
└── extension/
    ├── manifest.json
    ├── background.js
    ├── popup.html
    ├── popup.js
    └── recorder.js
```

---

## Backend setup

### Requirements

- Python 3.11+ or 3.12+
- pip / virtual environment
- Chromium installed for Playwright-based backend runs if you choose that mode
- AWS credentials if using Bedrock mode

### Install

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

If needed for browser-based backend execution:

```bash
playwright install chromium
```

### Environment file

Create `backend/.env`:

```env
APP_ENV=development
DATABASE_URL=sqlite:///./screencopilot.db
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000

NOVA_MODE=bedrock
AWS_REGION=us-east-1
BEDROCK_NOVA_LITE_MODEL_ID=amazon.nova-lite-v1:0
BEDROCK_NOVA_EMBED_MODEL_ID=amazon.nova-multimodal-embeddings-v1:0
AWS_ACCESS_KEY_ID=YOUR_IAM_USER_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=YOUR_IAM_USER_SECRET_KEY

BROWSER_EXECUTION_MODE=playwright
PLAYWRIGHT_HEADLESS=false
```

### Run backend

```bash
uvicorn app.main:app --reload --port 8000
```

Backend will run at:

```text
http://127.0.0.1:8000
```

---

## Extension setup

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder
5. Pin the extension if needed

### Main extension actions

- **Start Recording**
- **Stop & Upload**
- **Run Locally**
- **Play / Pause / Stop**
- **Prev / Next / Jump To Step**
- configurable delay after each step

---

## Typical demo flow

### Record and run a workflow

1. Open the target site.
2. Click **Start Recording** in the extension.
3. Perform the workflow once.
4. Click **Stop & Upload**.
5. The extension shows progress such as:
   - workflow is uploading
   - workflow is processing
   - workflow uploaded and processed successfully
6. Use the returned workflow ID.
7. Click **Run Locally**.
8. Control the automation with Play, Pause, Next, Prev, or Jump.

---

## Processing pipeline

When the workflow is sent to the backend, ObserveAI processes it automatically.

### What happens during processing

- raw browser events are loaded
- repeated noisy input events are merged
- duplicate navigation events are reduced
- Google-result-page clicks can be rewritten into direct navigations when grounded by recorded href values
- a better start URL is chosen
- Nova Lite converts raw steps into cleaner workflow steps
- processed steps are stored and made available for preview or execution

This helps transform a noisy browser trace into a more reusable automation plan.

---

## Ghost Mode preview

A major design goal of ObserveAI is **trust**.

Instead of blindly executing everything, the system can preview:

- the ordered workflow steps
- intended actions
- selectors and fallback selectors
- confidence values
- reasoning metadata

This allows users to inspect what the automation is about to do before committing to execution.

---

## API overview

Main backend endpoints include:

- `POST /api/v1/workflows`  
  Record and auto-process a workflow.

- `GET /api/v1/workflows/{workflow_id}`  
  Get workflow details.

- `GET /api/v1/workflows/{workflow_id}/executable`  
  Return executable processed steps for the extension.

- `POST /api/v1/workflows/{workflow_id}/preview`  
  Generate preview / Ghost Mode output.

- `POST /api/v1/workflows/{workflow_id}/run`  
  Run workflow via backend-controlled execution path.

- `GET /api/v1/debug/workflows`  
  Debug full workflow state.

- `GET /api/v1/health`  
  Health check.

---

## Why local browser execution matters

A big design choice in ObserveAI is that workflows can run **inside the user’s browser**, not only on a server.

This matters because:

- the user’s own login session is available
- cookies and current browser state can be reused
- browser-side automation feels more trustworthy
- it avoids depending entirely on a remote browser session

This makes ObserveAI closer to a real assistant than a hidden backend bot.

---

## Challenges we ran into

One of the biggest challenges was balancing **automation** with **user trust**.

Fully autonomous automation can feel risky, especially on real interfaces. To address that, we designed Ghost Mode so users can review steps before execution.

Another challenge was converting raw browser interactions into meaningful workflow steps that an AI model can interpret and execute reliably.

We also had to handle practical issues such as:

- noisy repeated input events
- unstable selectors
- navigation timing
- page transitions after clicks
- browser-side control logic for pause, resume, next, previous, and jump

---

## What we are proud of

- We built a system that can watch a workflow once and replay it later.
- We added Ghost Mode to improve user trust and transparency.
- We combined browser recording, DOM context, and AI-based normalization into one workflow automation pipeline.
- We added client-side playback controls so the automation can be inspected like a timeline.

---

## What we learned

We learned that combining visual and structured UI understanding with DOM context makes automation more reliable.

We also learned that users trust automation more when they can:

- preview actions
- step through the workflow
- pause execution
- validate what the system is about to do

---

## Current limitations

- Some websites with aggressive anti-bot systems are not ideal demo targets.
- File upload flows may require additional handling in client-side execution.
- “Previous step” is implemented through replay-from-checkpoint logic rather than true undo.
- The current repository includes backend and extension; a separate full dashboard UI is not included here.

---

## Best demo targets

ObserveAI works best in demos on:

- docs/search pages like Wikipedia
- internal dashboards
- portals with stable forms
- support and admin flows
- sites where automation is not blocked by aggressive anti-bot protections

For demos, it is better to avoid starting from search-engine results pages and instead begin from the target application directly.

---

## What’s next for ObserveAI

We see ObserveAI evolving into a full AI workflow assistant capable of learning more complex tasks across different applications and platforms.

Potential next steps include:

- stronger multimodal screen understanding
- voice-driven workflow commands
- adaptive learning from user feedback
- enterprise integrations for CRM, finance, and HR systems
- better checkpoints and recovery strategies
- stronger semantic matching using embeddings and visual context

---

## Tech stack

- **FastAPI**
- **SQLAlchemy**
- **SQLite**
- **Chrome Extension (Manifest V3)**
- **JavaScript**
- **Amazon Bedrock**
- **Amazon Nova Lite**
- **Amazon Nova Multimodal Embeddings**
- **Playwright**

---

## Quick start

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Extension

- Load unpacked extension from `extension/`
- Start recording
- Perform workflow once
- Stop & Upload
- Run locally

---

## Project tagline

> **ObserveAI turns observed browser behavior into trustworthy, reusable automation.**

