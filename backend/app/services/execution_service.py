from __future__ import annotations

from typing import Any, Dict, List

from sqlalchemy.orm import Session

from app.models.workflow import Workflow
from app.services.ghost_service import GhostService
from app.services.local_browser_executor import run_workflow_in_browser


class ExecutionService:
    def __init__(self) -> None:
        self.ghost_service = GhostService()

    def refresh_preview(self, workflow: Workflow, dom_snapshot: List[Dict[str, Any]] | None = None):
        step_payloads = [
            {
                "id": step.id,
                "action": step.action,
                "selector": step.selector,
                "fallback_selectors": step.fallback_selectors or [],
                "selector_candidates": step.selector_candidates or [],
                "text": step.text,
                "element_context": step.element_context or {},
            }
            for step in workflow.steps
        ]
        return self.ghost_service.build_preview(step_payloads, dom_snapshot)

    def run_workflow(self, db: Session, workflow: Workflow, use_live_browser: bool = True):
        return run_workflow_in_browser(db=db, workflow=workflow, use_live_browser=use_live_browser, simulated_dom=[])
