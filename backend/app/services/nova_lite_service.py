from __future__ import annotations

from typing import Any, Dict, List

from app.core.config import get_settings
from app.services.bedrock_runtime import BedrockRuntime
from app.services.utils import best_recorded_label, compact_text, score_selector, unique_strings


class NovaLiteService:
    def __init__(self) -> None:
        self.settings = get_settings()
        self.bedrock = BedrockRuntime()

    def process_raw_steps(self, raw_steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        if self.settings.nova_mode == "bedrock":
            aws_result = self._process_with_bedrock(raw_steps)
            if aws_result:
                return aws_result
        return self._process_demo(raw_steps)

    def _process_demo(self, raw_steps: List[Dict[str, Any]]) -> Dict[str, Any]:
        steps: List[Dict[str, Any]] = []
        workflow_name = "Recorded Workflow"
        source_url = next((step.get("url") for step in raw_steps if step.get("url")), None)

        for index, raw in enumerate(raw_steps):
            action = raw.get("action")
            selector = raw.get("selector")
            fallback_selectors = raw.get("fallback_selectors") or []
            selector_candidates = raw.get("selector_candidates") or []
            ctx = raw.get("element_context") or {}
            label = best_recorded_label(raw)

            if action == "navigate":
                name = f"Navigate to {compact_text(raw.get('url'), 60)}"
                confidence = 99
                reasoning = "Navigation uses the recorded destination URL."
            elif action == "input":
                name = f"Type into {label}"
                confidence = min(97, score_selector(selector) + 14)
                reasoning = "Input step inferred from recorded field context and selector strength."
            elif action == "upload":
                name = f"Upload file using {label}"
                confidence = min(93, score_selector(selector) + 10)
                reasoning = "Upload target identified from file input metadata."
            elif action == "select":
                name = f"Choose option in {label}"
                confidence = min(93, score_selector(selector) + 10)
                reasoning = "Select/dropdown action inferred from DOM metadata."
            else:
                name = f"Click {label}"
                confidence = min(95, score_selector(selector) + (6 if raw.get("selector_is_unique") else 0))
                reasoning = "Click intent inferred from selector, text, and surrounding element context."

            steps.append(
                {
                    "order_index": index,
                    "action": action,
                    "name": name,
                    "reasoning": reasoning,
                    "target_url": raw.get("url") if action == "navigate" else None,
                    "selector": selector,
                    "fallback_selectors": unique_strings(fallback_selectors),
                    "selector_candidates": selector_candidates,
                    "selector_is_unique": bool(raw.get("selector_is_unique", False)),
                    "text": compact_text(raw.get("text")),
                    "value": raw.get("value"),
                    "element_context": ctx,
                    "confidence": confidence,
                    "llm_metadata": {
                        "provider": "demo",
                        "model": "nova-lite-demo",
                        "raw_action": action,
                    },
                }
            )

        if source_url:
            workflow_name = f"Workflow from {source_url.split('//')[-1][:40]}"
        return {"workflow_name": workflow_name, "steps": steps}

    def _process_with_bedrock(self, raw_steps: List[Dict[str, Any]]) -> Dict[str, Any] | None:
        payload = {
            "goal": "Convert recorded browser events into a robust executable browser workflow.",
            "input_contract": {
                "raw_steps": raw_steps,
                "notes": [
                    "Each raw step came from a browser recorder.",
                    "Recorded selectors, URLs, values, and element_context are the source of truth.",
                    "The output must improve replayability without inventing data."
                ],
            },
            "transformation_rules": [
                "Preserve the true action sequence unless normalizing noisy consecutive steps.",
                "Allowed output actions: navigate, click, input, select, upload.",
                "Never invent selectors, URLs, text, or values that are not grounded in the input.",
                "Prefer the recorded selector as primary selector.",
                "Preserve fallback_selectors and selector_candidates when present.",
                "If multiple consecutive input steps target the same field on the same page, keep only the latest meaningful value.",
                "If multiple consecutive navigate steps go to the same URL, keep only one.",
                "If a click occurs on a Google search results page and the recorded element_context contains a direct absolute href, rewrite that step as action=navigate with target_url set to that href.",
                "If a click targets a broad container and a more specific meaningful step exists immediately after, you may drop the broad container click.",
                "For non-navigate steps, preserve the recorded page URL as target_url when possible.",
                "If uncertain, keep the step with lower confidence instead of inventing a better step.",
                "Do not omit meaningful steps.",
                "Output strict JSON only."
            ],
            "output_schema": {
                "workflow_name": "string",
                "steps": [
                    {
                        "order_index": "integer",
                        "action": "navigate|click|input|select|upload",
                        "name": "string",
                        "reasoning": "short string",
                        "target_url": "string|null",
                        "selector": "string|null",
                        "fallback_selectors": ["string"],
                        "selector_candidates": [
                            {
                                "selector": "string",
                                "match_count": "integer",
                                "unique": "boolean"
                            }
                        ],
                        "selector_is_unique": "boolean",
                        "text": "string|null",
                        "value": "string|null",
                        "element_context": "object|null",
                        "confidence": "integer 0-100",
                        "llm_metadata": {
                            "provider": "bedrock",
                            "model": "string",
                            "reason_code": "normalized|preserved|rewritten_google_click|merged_input|dropped_noisy_click|uncertain"
                        }
                    }
                ]
            }
        }

        system_prompt = (
            "You are an expert workflow-normalization engine for browser automation. "
            "Your job is to convert recorded browser events into reliable executable steps. "
            "Be conservative. Preserve recorded evidence. Never invent selectors or URLs. "
            "Normalize noisy recordings only when clearly justified. "
            "Return strict JSON only with top-level keys: workflow_name and steps."
        )

        parsed = self.bedrock.converse_json(
            self.settings.bedrock_nova_lite_model_id,
            system_prompt,
            payload,
        )

        if not parsed or not isinstance(parsed, dict) or not isinstance(parsed.get("steps"), list):
            return None

        for idx, item in enumerate(parsed["steps"]):
            item.setdefault("order_index", idx)
            item.setdefault("action", "click")
            item.setdefault("name", f"Step {idx + 1}")
            item.setdefault("reasoning", "Preserved from recording.")
            item.setdefault("target_url", None)
            item.setdefault("selector", None)
            item["fallback_selectors"] = unique_strings(item.get("fallback_selectors") or [])
            item["selector_candidates"] = item.get("selector_candidates") or []
            item["selector_is_unique"] = bool(item.get("selector_is_unique", False))
            item.setdefault("text", None)
            item.setdefault("value", None)
            item.setdefault("element_context", None)

            confidence = item.get("confidence", 50)
            try:
                confidence = int(confidence)
            except Exception:
                confidence = 50
            item["confidence"] = max(0, min(100, confidence))

            item.setdefault("llm_metadata", {})
            item["llm_metadata"]["provider"] = "bedrock"
            item["llm_metadata"]["model"] = self.settings.bedrock_nova_lite_model_id
            item["llm_metadata"].setdefault("reason_code", "preserved")

        return parsed