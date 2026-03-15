from __future__ import annotations

from typing import Any, Dict, List

import httpx

from app.core.config import get_settings


class NovaActService:
    def __init__(self) -> None:
        self.settings = get_settings()

    def execute_workflow(self, workflow: Dict[str, Any]) -> Dict[str, Any]:
        if self.settings.nova_mode == "aws" and self.settings.nova_act_endpoint:
            return self._execute_with_aws(workflow)
        return self._execute_demo(workflow)

    def _execute_demo(self, workflow: Dict[str, Any]) -> Dict[str, Any]:
        results = []
        for step in workflow.get("steps", []):
            results.append(
                {
                    "step_id": step["id"],
                    "status": "success",
                    "used_selector": step.get("selector") or (step.get("fallback_selectors") or [None])[0],
                    "provider": "demo-nova-act",
                    "metadata": {"message": "Simulated Nova Act execution"},
                }
            )
        return {"status": "success", "results": results, "provider": "demo-nova-act"}

    def _execute_with_aws(self, workflow: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Content-Type": "application/json"}
        if self.settings.nova_act_api_key:
            headers["Authorization"] = f"Bearer {self.settings.nova_act_api_key}"

        payload = {
            "workflowName": workflow["name"],
            "steps": workflow["steps"],
            "metadata": {"source": "ScreenCoPilot"},
        }
        with httpx.Client(timeout=30) as client:
            response = client.post(self.settings.nova_act_endpoint, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
        return {"status": "success", "results": data.get("results", []), "provider": "nova-act"}
