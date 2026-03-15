from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


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


class WorkflowCreate(BaseModel):
    name: str
    description: Optional[str] = None
    source_url: Optional[str] = None
    raw_steps: List[RawStepCreate]


class ProcessWorkflowRequest(BaseModel):
    force_reprocess: bool = True


class RunWorkflowRequest(BaseModel):
    simulated_dom: Optional[List[Dict[str, Any]]] = None
    use_live_browser: bool = False


class RawStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)
    id: int
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
    metadata: Optional[Dict[str, Any]] = Field(default=None, alias="step_metadata")
    created_at: datetime


class WorkflowStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    order_index: int
    action: str
    name: Optional[str] = None
    reasoning: Optional[str] = None
    target_url: Optional[str] = None
    selector: Optional[str] = None
    fallback_selectors: Optional[List[str]] = None
    selector_candidates: Optional[List[Dict[str, Any]]] = None
    selector_is_unique: bool = False
    text: Optional[str] = None
    value: Optional[str] = None
    element_context: Optional[Dict[str, Any]] = None
    confidence: int
    status: str
    llm_metadata: Optional[Dict[str, Any]] = None


class GhostPreviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    step_id: int
    predicted_selector: Optional[str] = None
    confidence: int
    match_reason: Optional[str] = None
    preview_metadata: Optional[Dict[str, Any]] = None


class StepExecutionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    workflow_step_id: int
    status: str
    used_selector: Optional[str] = None
    provider: str
    error: Optional[str] = None
    execution_metadata: Optional[Dict[str, Any]] = None
    created_at: datetime


class ExecutionRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    provider: str
    started_at: datetime
    completed_at: Optional[datetime] = None
    run_metadata: Optional[Dict[str, Any]] = None
    step_executions: List[StepExecutionOut] = []


class WorkflowOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    description: Optional[str] = None
    source_url: Optional[str] = None
    status: str
    created_at: datetime
    raw_steps: List[RawStepOut] = []
    steps: List[WorkflowStepOut] = []
    previews: List[GhostPreviewOut] = []
    execution_runs: List[ExecutionRunOut] = []
