from __future__ import annotations

import os
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from sqlalchemy.orm import Session

from app.models.workflow import ExecutionRun, StepExecution, Workflow, WorkflowStep


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_str(name: str, default: str = "") -> str:
    value = os.getenv(name)
    return value if value is not None else default


def _dedupe(values: List[str]) -> List[str]:
    seen = set()
    out = []
    for v in values:
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def _text_hint(step: WorkflowStep) -> Optional[str]:
    ctx = step.element_context or {}
    return ctx.get("direct_text") or ctx.get("text") or step.text


def _tag_hint(step: WorkflowStep) -> Optional[str]:
    ctx = step.element_context or {}
    return ctx.get("tag")


def _role_hint(step: WorkflowStep) -> Optional[str]:
    ctx = step.element_context or {}
    attrs = ctx.get("attributes") or {}
    return attrs.get("role")


def _value_for_input(step: WorkflowStep) -> str:
    return step.value or step.text or ""


def _collect_selectors(step: WorkflowStep) -> List[str]:
    selectors: List[str] = []
    if step.selector:
        selectors.append(step.selector)
    selectors.extend(step.fallback_selectors or [])
    for item in step.selector_candidates or []:
        if isinstance(item, dict) and item.get("selector"):
            selectors.append(item["selector"])
        elif isinstance(item, str):
            selectors.append(item)
    return _dedupe(selectors)


def _same_page(current: str, target: str) -> bool:
    if not current or not target:
        return False
    c = urlparse(current)
    t = urlparse(target)
    return (c.scheme, c.netloc, c.path) == (t.scheme, t.netloc, t.path)


def _try_locator(page, selector: str, timeout_ms: int = 2500):
    try:
        locator = page.locator(selector).first
        locator.wait_for(state="visible", timeout=timeout_ms)
        return locator
    except Exception:
        return None


def _resolve_locator(page, step: WorkflowStep) -> Tuple[Any, Optional[str]]:
    for selector in _collect_selectors(step):
        locator = _try_locator(page, selector)
        if locator:
            return locator, selector

    role_hint = _role_hint(step)
    text_hint = _text_hint(step)
    tag_hint = _tag_hint(step)

    if role_hint and text_hint:
        try:
            locator = page.get_by_role(role_hint, name=text_hint).first
            locator.wait_for(state="visible", timeout=2500)
            return locator, f"role={role_hint},name={text_hint}"
        except Exception:
            pass

    if tag_hint in {"button", "a", "label", "span"} and text_hint:
        try:
            locator = page.locator(tag_hint).filter(has_text=text_hint).first
            locator.wait_for(state="visible", timeout=2500)
            return locator, f"{tag_hint}:text({text_hint})"
        except Exception:
            pass

    if text_hint:
        try:
            locator = page.get_by_text(text_hint, exact=False).first
            locator.wait_for(state="visible", timeout=2500)
            return locator, f"text={text_hint}"
        except Exception:
            pass

    raise RuntimeError(f"Could not resolve element for step {step.id}: {step.name}")


def _determine_start_url(workflow: Workflow) -> Optional[str]:
    steps = sorted(workflow.steps, key=lambda s: s.order_index)
    for step in steps:
        if step.action == "navigate" and step.target_url:
            return step.target_url
    if workflow.source_url:
        return workflow.source_url
    raw_steps = sorted(workflow.raw_steps, key=lambda s: s.id)
    for raw in raw_steps:
        if raw.url:
            return raw.url
    return None


def _create_run(db: Session, workflow: Workflow, provider: str) -> ExecutionRun:
    run = ExecutionRun(workflow_id=workflow.id, status="running", run_metadata={"provider": provider})
    db.add(run)
    db.flush()
    return run


def _create_step_execution(
    db: Session,
    run: ExecutionRun,
    step: WorkflowStep,
    status: str,
    used_selector: Optional[str] = None,
    error: Optional[str] = None,
    provider: str = "playwright",
):
    db.add(
        StepExecution(
            execution_run_id=run.id,
            workflow_step_id=step.id,
            status=status,
            used_selector=used_selector,
            error=error,
            execution_metadata={"provider": provider},
        )
    )
    db.flush()


def _run_demo(db: Session, workflow: Workflow) -> Dict[str, Any]:
    run = _create_run(db, workflow, provider="demo-browser")
    for step in sorted(workflow.steps, key=lambda s: s.order_index):
        _create_step_execution(db, run, step, "success", used_selector=step.selector, provider="demo-browser")
    run.status = "success"
    run.completed_at = datetime.utcnow()
    workflow.status = "executed"
    db.commit()
    return {"provider": "demo-browser", "status": "success", "run_id": run.id}


def run_workflow_in_browser(
    db: Session,
    workflow: Workflow,
    use_live_browser: bool = True,
    simulated_dom: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    mode = _env_str("BROWSER_EXECUTION_MODE", "playwright").strip().lower()
    headless = _env_bool("PLAYWRIGHT_HEADLESS", False)

    if not use_live_browser or mode != "playwright":
        return _run_demo(db, workflow)

    run = _create_run(db, workflow, provider="playwright")
    steps = sorted(workflow.steps, key=lambda s: s.order_index)
    start_url = _determine_start_url(workflow)
    if not start_url:
        run.status = "failed"
        run.completed_at = datetime.utcnow()
        workflow.status = "failed"
        db.commit()
        raise RuntimeError("No start URL found for workflow execution")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=headless)
            context = browser.new_context()
            page = context.new_page()
            page.goto(start_url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(1)

            first_navigation_consumed = False
            for step in steps:
                try:
                    if step.action == "navigate":
                        target = step.target_url
                        if not first_navigation_consumed and target == start_url:
                            first_navigation_consumed = True
                            _create_step_execution(db, run, step, "success", provider="playwright")
                            continue
                        if target:
                            page.goto(target, wait_until="domcontentloaded", timeout=30000)
                            time.sleep(1)
                            _create_step_execution(db, run, step, "success", provider="playwright")
                            continue

                    # If step belongs to another page and we're not there, recover by navigating first.
                    if step.target_url and not _same_page(page.url, step.target_url):
                        page.goto(step.target_url, wait_until="domcontentloaded", timeout=30000)
                        time.sleep(1)

                    try:
                        locator, used_selector = _resolve_locator(page, step)
                    except Exception:
                        if step.target_url and page.url != step.target_url:
                            page.goto(step.target_url, wait_until="domcontentloaded", timeout=30000)
                            time.sleep(1)
                            locator, used_selector = _resolve_locator(page, step)
                        else:
                            raise

                    if step.action == "click":
                        locator.click(timeout=10000)
                    elif step.action == "input":
                        locator.fill(_value_for_input(step), timeout=10000)
                    elif step.action == "upload":
                        if not step.value:
                            raise RuntimeError("Upload step missing file path")
                        locator.set_input_files(step.value, timeout=10000)
                    elif step.action == "select":
                        locator.select_option(label=step.value or "", timeout=10000)
                    else:
                        raise RuntimeError(f"Unsupported action: {step.action}")

                    time.sleep(0.8)
                    _create_step_execution(db, run, step, "success", used_selector=used_selector, provider="playwright")
                except Exception as step_err:
                    _create_step_execution(db, run, step, "failed", error=str(step_err), provider="playwright")
                    run.status = "failed"
                    run.completed_at = datetime.utcnow()
                    workflow.status = "failed"
                    db.commit()
                    raise

            run.status = "success"
            run.completed_at = datetime.utcnow()
            workflow.status = "executed"
            db.commit()
            context.close()
            browser.close()
            return {"provider": "playwright", "status": "success", "run_id": run.id, "start_url": start_url}
    except PlaywrightTimeoutError as exc:
        run.status = "failed"
        run.completed_at = datetime.utcnow()
        workflow.status = "failed"
        db.commit()
        raise RuntimeError(f"Playwright timeout: {exc}") from exc
