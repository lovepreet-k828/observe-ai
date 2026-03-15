from __future__ import annotations

from typing import Any, Dict, Iterable, List


def compact_text(value: str | None, limit: int = 140) -> str:
    if not value:
        return ""
    return " ".join(str(value).split())[:limit]


def score_selector(selector: str | None) -> int:
    if not selector:
        return 20
    score = 20
    if selector.startswith("#"):
        score += 45
    if "data-testid" in selector or "data-test" in selector or "data-cy" in selector:
        score += 35
    if "aria-label" in selector or "name=" in selector:
        score += 14
    if ":nth-of-type" in selector:
        score -= 5
    if selector.count(">") > 2:
        score -= 8
    if "." in selector:
        score += 8
    return max(0, min(score, 100))


def merge_metadata(*parts: Dict[str, Any] | None) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for part in parts:
        if part:
            out.update(part)
    return out


def best_recorded_label(step: Dict[str, Any]) -> str:
    ctx = step.get("element_context") or {}
    return compact_text(
        step.get("text")
        or ctx.get("direct_text")
        or ctx.get("text")
        or ctx.get("name")
        or step.get("element_name")
        or step.get("placeholder")
        or step.get("selector")
        or "element",
        60,
    )


def unique_strings(values: Iterable[str | None]) -> List[str]:
    seen = set()
    out: List[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out
