from __future__ import annotations

from typing import Any, Dict, List, Tuple

from app.core.config import get_settings
from app.services.utils import compact_text


class NovaEmbeddingsService:
    def __init__(self) -> None:
        self.settings = get_settings()

    def build_embedding_document(self, raw_or_step: Dict[str, Any]) -> Dict[str, Any]:
        ctx = raw_or_step.get("element_context") or {}
        document = {
            "selector": raw_or_step.get("selector"),
            "fallback_selectors": raw_or_step.get("fallback_selectors") or [],
            "text": compact_text(raw_or_step.get("text")),
            "tag": ctx.get("tag") or raw_or_step.get("tag"),
            "name": ctx.get("name") or raw_or_step.get("element_name"),
            "classes": ctx.get("classes") or [],
            "attributes": (ctx.get("attributes") or {}),
            "rect": ctx.get("rect") or {},
        }
        document["embedding_text"] = " | ".join(
            filter(
                None,
                [
                    document["selector"] or "",
                    document["text"] or "",
                    document["tag"] or "",
                    document["name"] or "",
                    " ".join(document["classes"]) if document["classes"] else "",
                    " ".join(f"{k}={v}" for k, v in document["attributes"].items()),
                ],
            )
        )
        return document

    def score_match(self, recorded_doc: Dict[str, Any], candidate_dom: Dict[str, Any]) -> Tuple[int, str]:
        score = 0
        reasons: List[str] = []

        rec_text = compact_text(recorded_doc.get("text")).lower()
        cand_text = compact_text(candidate_dom.get("text")).lower()
        if rec_text and cand_text and rec_text == cand_text:
            score += 35
            reasons.append("exact text match")
        elif rec_text and cand_text and (rec_text in cand_text or cand_text in rec_text):
            score += 22
            reasons.append("partial text match")

        rec_tag = (recorded_doc.get("tag") or "").lower()
        cand_tag = (candidate_dom.get("tag") or "").lower()
        if rec_tag and rec_tag == cand_tag:
            score += 18
            reasons.append("same tag")

        rec_name = (recorded_doc.get("name") or "").lower()
        cand_name = (candidate_dom.get("name") or "").lower()
        if rec_name and cand_name and rec_name == cand_name:
            score += 15
            reasons.append("same name")

        rec_classes = set(recorded_doc.get("classes") or [])
        cand_classes = set(candidate_dom.get("classes") or [])
        overlap = len(rec_classes.intersection(cand_classes))
        if overlap:
            score += min(18, overlap * 6)
            reasons.append(f"class overlap={overlap}")

        rec_attrs = recorded_doc.get("attributes") or {}
        cand_attrs = candidate_dom.get("attributes") or {}
        shared_attrs = [k for k, v in rec_attrs.items() if cand_attrs.get(k) == v and v]
        if shared_attrs:
            score += min(25, 8 * len(shared_attrs))
            reasons.append(f"shared attrs: {', '.join(shared_attrs[:3])}")

        rec_selector = recorded_doc.get("selector") or ""
        cand_selector = candidate_dom.get("selector") or ""
        if rec_selector and cand_selector and rec_selector == cand_selector:
            score += 25
            reasons.append("same selector")

        return min(score, 100), ", ".join(reasons) if reasons else "weak semantic fallback"

    def find_best_match(self, recorded_doc: Dict[str, Any], dom_snapshot: List[Dict[str, Any]]) -> Dict[str, Any] | None:
        best = None
        best_score = -1
        best_reason = ""
        for candidate in dom_snapshot:
            score, reason = self.score_match(recorded_doc, candidate)
            if score > best_score:
                best = candidate
                best_score = score
                best_reason = reason
        if not best:
            return None
        return {
            "selector": best.get("selector"),
            "confidence": best_score,
            "reason": best_reason,
            "candidate": best,
            "provider": "bedrock-simulated" if self.settings.nova_mode == "bedrock" else "demo",
            "model": self.settings.bedrock_nova_embed_model_id if self.settings.nova_mode == "bedrock" else "heuristic-match",
        }
