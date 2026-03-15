from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from app.db.session import get_db
from app.models.workflow import ExecutionRun, RawStep, Workflow, WorkflowStep
from app.services.ghost_service import GhostService
from app.services.local_browser_executor import run_workflow_in_browser
from app.services.nova_lite_service import NovaLiteService

router = APIRouter()

nova_lite = NovaLiteService()
ghost_service = GhostService()


class RawStepCreate(BaseModel):
    action: str
    url: Optional[str] = None
    selector: Optional[str] = None
    selector_candidates: Optional[List[Dict[str, Any]]] = None
    fallback_selectors: Optional[List[str]] = None
    selector_is_unique: bool = False
    tag: Optional[str] = None
    text: Optional[str] = None
    value: Optional[str] = None
    placeholder: Optional[str] = None
    element_name: Optional[str] = None
    element_context: Optional[Dict[str, Any]] = None
    metadata: Optional[Dict[str, Any]] = None


class CreateWorkflowRequest(BaseModel):
    name: str
    description: Optional[str] = None
    source_url: Optional[str] = None
    raw_steps: List[RawStepCreate]


class PreviewWorkflowRequest(BaseModel):
    simulated_dom: Optional[List[Dict[str, Any]]] = None


class EditableWorkflowStep(BaseModel):
    id: Optional[int] = None
    order_index: int = 0
    action: str
    name: Optional[str] = None
    target_url: Optional[str] = None
    selector: Optional[str] = None
    fallback_selectors: List[str] = Field(default_factory=list)
    selector_candidates: List[Dict[str, Any] | str] = Field(default_factory=list)
    selector_is_unique: bool = False
    text: Optional[str] = None
    value: Optional[str] = None
    element_context: Optional[Dict[str, Any]] = None
    confidence: int = 50
    llm_metadata: Optional[Dict[str, Any]] = None
    status: str = "ready"


class UpdateWorkflowStepsRequest(BaseModel):
    steps: List[EditableWorkflowStep]
    mark_reviewed: bool = True


class RunWorkflowRequest(BaseModel):
    simulated_dom: Optional[List[Dict[str, Any]]] = None
    use_live_browser: bool = True


SAFE_ACTIONS = {"navigate", "click", "input", "select", "upload"}


def _workflow_query(db: Session):
    return db.query(Workflow).options(
        joinedload(Workflow.raw_steps),
        joinedload(Workflow.steps),
        joinedload(Workflow.execution_runs).joinedload(ExecutionRun.step_executions),
    )


def _raw_step_to_dict(s: RawStep) -> Dict[str, Any]:
    return {
        "id": s.id,
        "action": s.action,
        "url": s.url,
        "selector": s.selector,
        "selector_candidates": s.selector_candidates or [],
        "fallback_selectors": s.fallback_selectors or [],
        "selector_is_unique": s.selector_is_unique,
        "tag": s.tag,
        "text": s.text,
        "value": s.value,
        "placeholder": s.placeholder,
        "element_name": s.element_name,
        "element_context": s.element_context,
        "step_metadata": s.step_metadata,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }


def _step_to_dict(s: WorkflowStep) -> Dict[str, Any]:
    return {
        "id": s.id,
        "order_index": s.order_index,
        "action": s.action,
        "name": s.name,
        "target_url": s.target_url,
        "selector": s.selector,
        "fallback_selectors": s.fallback_selectors or [],
        "selector_candidates": s.selector_candidates or [],
        "selector_is_unique": s.selector_is_unique,
        "confidence": s.confidence,
        "text": s.text,
        "value": s.value,
        "element_context": s.element_context,
        "llm_metadata": s.llm_metadata,
        "status": s.status,
    }


def _workflow_to_debug_dict(workflow: Workflow) -> Dict[str, Any]:
    return {
        "id": workflow.id,
        "name": workflow.name,
        "description": workflow.description,
        "source_url": workflow.source_url,
        "status": workflow.status,
        "created_at": workflow.created_at.isoformat() if workflow.created_at else None,
        "raw_steps": [_raw_step_to_dict(s) for s in workflow.raw_steps],
        "steps": [_step_to_dict(s) for s in workflow.steps],
        "runs": [
            {
                "id": r.id,
                "status": r.status,
                "provider": (r.run_metadata or {}).get("provider"),
                "started_at": r.started_at.isoformat() if r.started_at else None,
                "completed_at": r.completed_at.isoformat() if r.completed_at else None,
                "step_executions": [
                    {
                        "step_id": se.workflow_step_id,
                        "status": se.status,
                        "used_selector": se.used_selector,
                        "provider": (se.execution_metadata or {}).get("provider"),
                        "error": se.error,
                    }
                    for se in r.step_executions
                ],
            }
            for r in workflow.execution_runs
        ],
    }


def _clean_text(value: Optional[str]) -> str:
    return (value or "").strip()


def _is_google_search_url(url: Optional[str]) -> bool:
    if not url:
        return False
    lowered = url.lower()
    return "google." in lowered and "/search" in lowered


def _extract_direct_href(raw: RawStep) -> Optional[str]:
    ctx = raw.element_context or {}
    attrs = ctx.get("attributes") or {}
    href = attrs.get("href")
    if href and href.startswith("http"):
        return href
    return None


def _normalize_start_url(raw_steps: List[RawStep], source_url: Optional[str]) -> Optional[str]:
    first_non_google = next((s.url for s in raw_steps if s.url and not _is_google_search_url(s.url)), None)
    first_any = next((s.url for s in raw_steps if s.url), None)
    return first_non_google or first_any or source_url


def _step_display_name_from_raw(raw: RawStep) -> str:
    if raw.action == "navigate":
        return f"Navigate to {raw.url or 'page'}"
    if raw.action == "input":
        ctx = raw.element_context or {}
        label = (
            raw.element_name
            or raw.placeholder
            or (ctx.get("attributes") or {}).get("aria-label")
            or (ctx.get("attributes") or {}).get("name")
            or raw.selector
            or "field"
        )
        return f"Type into {str(label)[:60]}"
    if raw.action == "click":
        ctx = raw.element_context or {}
        txt = _clean_text(raw.text) or _clean_text(ctx.get("direct_text")) or _clean_text(ctx.get("text")) or raw.selector or "element"
        return f"Click {txt[:80]}"
    if raw.action == "upload":
        return "Upload file"
    if raw.action == "select":
        return f"Select {_clean_text(raw.value)[:60] or 'option'}"
    return f"{raw.action.title()} step"


def _step_display_name_from_dict(step: Dict[str, Any]) -> str:
    action = step.get("action")
    if action == "navigate":
        return f"Navigate to {step.get('target_url') or step.get('url') or 'page'}"
    if action == "input":
        label = (
            step.get("element_name")
            or step.get("placeholder")
            or ((step.get("element_context") or {}).get("attributes") or {}).get("aria-label")
            or ((step.get("element_context") or {}).get("attributes") or {}).get("name")
            or step.get("selector")
            or "field"
        )
        return f"Type into {str(label)[:60]}"
    if action == "click":
        ctx = step.get("element_context") or {}
        txt = _clean_text(step.get("text")) or _clean_text(ctx.get("direct_text")) or _clean_text(ctx.get("text")) or step.get("selector") or "element"
        return f"Click {txt[:80]}"
    if action == "upload":
        return "Upload file"
    if action == "select":
        return f"Select {_clean_text(step.get('value'))[:60] or 'option'}"
    return f"{str(action).title()} step"


def _merge_raw_steps(raw_steps: List[RawStep]) -> List[RawStep]:
    merged: List[RawStep] = []
    for step in raw_steps:
        if not merged:
            merged.append(step)
            continue
        prev = merged[-1]
        same_input_target = (
            step.action == "input"
            and prev.action == "input"
            and (step.selector or "") == (prev.selector or "")
            and (step.url or "") == (prev.url or "")
        )
        if same_input_target:
            merged[-1] = step
            continue
        same_navigate_target = step.action == "navigate" and prev.action == "navigate" and (step.url or "") == (prev.url or "")
        if same_navigate_target:
            merged[-1] = step
            continue
        merged.append(step)
    return merged


def _rewrite_google_result_clicks(raw_steps: List[RawStep]) -> List[RawStep]:
    rewritten: List[RawStep] = []
    for raw in raw_steps:
        if raw.action == "click" and _is_google_search_url(raw.url):
            direct_href = _extract_direct_href(raw)
            if direct_href:
                rewritten.append(
                    RawStep(
                        workflow_id=raw.workflow_id,
                        action="navigate",
                        url=direct_href,
                        selector=None,
                        selector_candidates=[],
                        fallback_selectors=[],
                        selector_is_unique=True,
                        tag=None,
                        text=direct_href,
                        value=None,
                        placeholder=None,
                        element_name=None,
                        element_context=None,
                        step_metadata=raw.step_metadata,
                    )
                )
                continue
        rewritten.append(raw)
    return rewritten


def _fallback_process_from_raw(raw_steps: List[RawStep]) -> List[Dict[str, Any]]:
    processed: List[Dict[str, Any]] = []
    for raw in raw_steps:
        confidence = 35
        if raw.action == "navigate":
            confidence = 99
        elif raw.selector_is_unique:
            confidence = 75
        elif raw.fallback_selectors:
            confidence = 55
        processed.append(
            {
                "action": raw.action,
                "name": _step_display_name_from_raw(raw),
                "target_url": raw.url,
                "selector": raw.selector,
                "fallback_selectors": raw.fallback_selectors or [],
                "selector_candidates": raw.selector_candidates or [],
                "selector_is_unique": bool(raw.selector_is_unique),
                "text": raw.text,
                "value": raw.value,
                "element_context": raw.element_context,
                "confidence": confidence,
                "llm_metadata": {"provider": "processor-fallback", "raw_action": raw.action},
            }
        )
    return processed


def _processed_step_target_url(item: Dict[str, Any], raw_steps: List[RawStep]) -> Optional[str]:
    action = item.get("action")
    target_url = item.get("target_url") or item.get("url")
    if action == "navigate":
        return target_url
    if target_url:
        return target_url
    selector = item.get("selector")
    for s in raw_steps:
        if s.action == action and s.selector == selector and s.url:
            return s.url
    for s in raw_steps:
        if s.action == action and s.url:
            return s.url
    return None


def _create_processed_steps(db: Session, workflow: Workflow) -> Workflow:
    db.query(WorkflowStep).filter(WorkflowStep.workflow_id == workflow.id).delete()
    db.flush()

    raw_steps = sorted(workflow.raw_steps, key=lambda x: x.id)
    if not raw_steps:
        raise HTTPException(status_code=400, detail="Workflow has no raw steps")

    raw_steps = _merge_raw_steps(raw_steps)
    raw_steps = _rewrite_google_result_clicks(raw_steps)
    start_url = _normalize_start_url(raw_steps, workflow.source_url)
    raw_payload = [_raw_step_to_dict(s) for s in raw_steps]

    try:
        processed_result = nova_lite.process_raw_steps(raw_payload)
        if isinstance(processed_result, dict):
            generated_steps = processed_result.get("steps", []) or []
        elif isinstance(processed_result, list):
            generated_steps = processed_result
        else:
            generated_steps = []
    except Exception:
        generated_steps = []

    if not generated_steps:
        generated_steps = _fallback_process_from_raw(raw_steps)

    order_index = 0
    if start_url:
        db.add(
            WorkflowStep(
                workflow_id=workflow.id,
                order_index=order_index,
                action="navigate",
                name=f"Navigate to {start_url[:120]}",
                target_url=start_url,
                selector=None,
                fallback_selectors=[],
                selector_candidates=[],
                selector_is_unique=True,
                text=None,
                value=None,
                element_context=None,
                confidence=99,
                llm_metadata={"provider": "processor", "reason": "synthetic_start_navigation"},
                status="ready",
            )
        )
        order_index += 1

    last_navigate = start_url
    for item in generated_steps:
        action = item.get("action")
        if not action:
            continue
        target_url = _processed_step_target_url(item, raw_steps)
        if action == "navigate":
            if not target_url or target_url == last_navigate:
                continue
            last_navigate = target_url
        name = item.get("name") or _step_display_name_from_dict(item)
        db.add(
            WorkflowStep(
                workflow_id=workflow.id,
                order_index=order_index,
                action=action,
                name=name,
                target_url=target_url,
                selector=item.get("selector"),
                fallback_selectors=item.get("fallback_selectors") or [],
                selector_candidates=item.get("selector_candidates") or [],
                selector_is_unique=bool(item.get("selector_is_unique", False)),
                text=item.get("text"),
                value=item.get("value"),
                element_context=item.get("element_context"),
                confidence=item.get("confidence"),
                llm_metadata=item.get("llm_metadata") or {},
                status="ready",
            )
        )
        order_index += 1

    workflow.status = "processed"
    db.commit()
    return _workflow_query(db).filter(Workflow.id == workflow.id).first()


def _replace_workflow_steps(db: Session, workflow: Workflow, steps: List[EditableWorkflowStep], mark_reviewed: bool = True) -> Workflow:
    safe_steps = [step for step in steps if step.action in SAFE_ACTIONS]
    if not safe_steps:
        raise HTTPException(status_code=400, detail="No valid workflow steps were provided")

    db.query(WorkflowStep).filter(WorkflowStep.workflow_id == workflow.id).delete()
    db.flush()

    for order_index, step in enumerate(sorted(safe_steps, key=lambda item: item.order_index)):
        name = step.name or _step_display_name_from_dict(step.model_dump())
        db.add(
            WorkflowStep(
                workflow_id=workflow.id,
                order_index=order_index,
                action=step.action,
                name=name,
                target_url=step.target_url,
                selector=step.selector,
                fallback_selectors=step.fallback_selectors or [],
                selector_candidates=step.selector_candidates or [],
                selector_is_unique=bool(step.selector_is_unique),
                text=step.text,
                value=step.value,
                element_context=step.element_context,
                confidence=max(0, min(100, int(step.confidence))),
                llm_metadata={
                    **(step.llm_metadata or {}),
                    "edited_by_user": True,
                },
                status=step.status or "ready",
            )
        )

    workflow.status = "reviewed" if mark_reviewed else "processed"
    db.commit()
    return _workflow_query(db).filter(Workflow.id == workflow.id).first()


@router.get("/health")
def health():
    return {"ok": True}


@router.post("/workflows")
def create_workflow(payload: CreateWorkflowRequest, db: Session = Depends(get_db)):
    raw_steps = [step for step in payload.raw_steps if step.action in SAFE_ACTIONS]
    if not raw_steps:
        raise HTTPException(status_code=400, detail="No valid recorded steps found")

    source_url = next((s.url for s in raw_steps if s.url), None) or payload.source_url
    workflow = Workflow(name=payload.name, description=payload.description, source_url=source_url, status="recorded")
    db.add(workflow)
    db.flush()

    for raw in raw_steps:
        db.add(
            RawStep(
                workflow_id=workflow.id,
                action=raw.action,
                url=raw.url,
                selector=raw.selector,
                selector_candidates=raw.selector_candidates or [],
                fallback_selectors=raw.fallback_selectors or [],
                selector_is_unique=raw.selector_is_unique,
                tag=raw.tag,
                text=raw.text,
                value=raw.value,
                placeholder=raw.placeholder,
                element_name=raw.element_name,
                element_context=raw.element_context,
                step_metadata=raw.metadata,
            )
        )

    db.commit()
    workflow = _workflow_query(db).filter(Workflow.id == workflow.id).first()
    workflow = _create_processed_steps(db, workflow)

    return {
        "message": "Workflow uploaded and processed successfully",
        "workflow_id": workflow.id,
        "status": workflow.status,
        "raw_step_count": len(raw_steps),
        "processed_step_count": len(workflow.steps),
        "source_url": workflow.source_url,
    }


@router.get("/workflows/{workflow_id}")
def get_workflow(workflow_id: int, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return _workflow_to_debug_dict(workflow)


@router.get("/debug/workflows")
def debug_workflows(db: Session = Depends(get_db)):
    workflows = _workflow_query(db).order_by(Workflow.id.asc()).all()
    return [_workflow_to_debug_dict(wf) for wf in workflows]


@router.post("/workflows/{workflow_id}/process")
def process_workflow(workflow_id: int, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    workflow = _create_processed_steps(db, workflow)
    return _workflow_to_debug_dict(workflow)


@router.get("/workflows/{workflow_id}/executable")
def get_executable_workflow(workflow_id: int, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if not workflow.steps:
        workflow = _create_processed_steps(db, workflow)
    return {
        "workflow_id": workflow.id,
        "name": workflow.name,
        "description": workflow.description,
        "source_url": workflow.source_url,
        "status": workflow.status,
        "requires_review": workflow.status != "reviewed",
        "steps": [_step_to_dict(step) for step in sorted(workflow.steps, key=lambda s: s.order_index)],
    }


@router.put("/workflows/{workflow_id}/steps")
def update_workflow_steps(workflow_id: int, payload: UpdateWorkflowStepsRequest, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    workflow = _replace_workflow_steps(db, workflow, payload.steps, mark_reviewed=payload.mark_reviewed)
    return {
        "message": "Workflow steps updated successfully",
        "workflow_id": workflow.id,
        "status": workflow.status,
        "steps": [_step_to_dict(step) for step in sorted(workflow.steps, key=lambda s: s.order_index)],
    }


@router.post("/workflows/{workflow_id}/preview")
def preview_workflow(workflow_id: int, payload: PreviewWorkflowRequest, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if not workflow.steps:
        workflow = _create_processed_steps(db, workflow)

    step_payloads = [_step_to_dict(step) for step in sorted(workflow.steps, key=lambda s: s.order_index)]
    previews = ghost_service.build_preview(step_payloads, payload.simulated_dom or [])
    preview_by_step = {preview["step_id"]: preview for preview in previews}
    combined_steps = []
    for step in step_payloads:
        combined_steps.append({**step, "preview": preview_by_step.get(step["id"], {})})
    return {
        "workflow_id": workflow.id,
        "status": workflow.status,
        "requires_review": workflow.status != "reviewed",
        "preview_count": len(previews),
        "previews": previews,
        "steps": combined_steps,
    }


@router.post("/workflows/{workflow_id}/run")
def run_workflow(workflow_id: int, payload: RunWorkflowRequest, db: Session = Depends(get_db)):
    workflow = _workflow_query(db).filter(Workflow.id == workflow_id).first()
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    if not workflow.steps:
        workflow = _create_processed_steps(db, workflow)

    try:
        result = run_workflow_in_browser(
            db=db,
            workflow=workflow,
            use_live_browser=payload.use_live_browser,
            simulated_dom=payload.simulated_dom or [],
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    workflow = _workflow_query(db).filter(Workflow.id == workflow.id).first()
    return {"message": "Workflow run completed", "run_result": result, "workflow": _workflow_to_debug_dict(workflow)}
