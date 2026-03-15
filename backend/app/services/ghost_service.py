from __future__ import annotations

from typing import Any, Dict, List

from app.services.nova_embeddings_service import NovaEmbeddingsService
from app.services.utils import score_selector


class GhostService:
    def __init__(self) -> None:
        self.embeddings = NovaEmbeddingsService()

    def build_preview(self, steps: List[Dict[str, Any]], dom_snapshot: List[Dict[str, Any]] | None = None) -> List[Dict[str, Any]]:
        previews: List[Dict[str, Any]] = []
        dom_snapshot = dom_snapshot or []

        for step in steps:
            selector = step.get("selector")
            predicted_selector = selector
            confidence = score_selector(selector)
            match_reason = "Primary selector chosen from recording."
            provider = "recorded-selector"
            rect = ((step.get("element_context") or {}).get("rect") or None)

            if step.get("action") == "navigate":
                confidence = 99
                match_reason = "Navigation step uses the recorded destination URL."
            elif dom_snapshot:
                recorded_doc = self.embeddings.build_embedding_document(step)
                match = self.embeddings.find_best_match(recorded_doc, dom_snapshot)
                if match and match.get("confidence", 0) >= confidence:
                    predicted_selector = match.get("selector") or selector
                    confidence = match["confidence"]
                    match_reason = match["reason"]
                    provider = match.get("provider", provider)

            previews.append(
                {
                    "step_id": step["id"],
                    "predicted_selector": predicted_selector,
                    "confidence": max(35, min(confidence, 99)),
                    "match_reason": match_reason,
                    "preview_metadata": {
                        "fallback_count": len(step.get("fallback_selectors") or []),
                        "selector_candidates": len(step.get("selector_candidates") or []),
                        "provider": provider,
                        "action": step.get("action"),
                        "rect": rect,
                        "target_url": step.get("target_url"),
                    },
                }
            )
        return previews
