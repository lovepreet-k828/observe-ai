from datetime import datetime

from sqlalchemy import JSON, Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class Workflow(Base):
    __tablename__ = "workflows"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    description = Column(Text, nullable=True)
    source_url = Column(Text, nullable=True)
    status = Column(String, nullable=False, default="recorded")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    raw_steps = relationship(
        "RawStep",
        back_populates="workflow",
        cascade="all, delete-orphan",
        order_by="RawStep.id",
    )
    steps = relationship(
        "WorkflowStep",
        back_populates="workflow",
        cascade="all, delete-orphan",
        order_by="WorkflowStep.order_index",
    )
    execution_runs = relationship(
        "ExecutionRun",
        back_populates="workflow",
        cascade="all, delete-orphan",
        order_by="ExecutionRun.started_at",
    )


class RawStep(Base):
    __tablename__ = "raw_steps"

    id = Column(Integer, primary_key=True, index=True)
    workflow_id = Column(Integer, ForeignKey("workflows.id"), nullable=False, index=True)

    action = Column(String, nullable=False)
    url = Column(Text, nullable=True)
    selector = Column(Text, nullable=True)
    selector_candidates = Column(JSON, nullable=True)
    fallback_selectors = Column(JSON, nullable=True)
    selector_is_unique = Column(Boolean, nullable=False, default=False)
    tag = Column(String, nullable=True)
    text = Column(Text, nullable=True)
    value = Column(Text, nullable=True)
    placeholder = Column(Text, nullable=True)
    element_name = Column(String, nullable=True)
    element_context = Column(JSON, nullable=True)
    step_metadata = Column("metadata", JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    workflow = relationship("Workflow", back_populates="raw_steps")


class WorkflowStep(Base):
    __tablename__ = "workflow_steps"

    id = Column(Integer, primary_key=True, index=True)
    workflow_id = Column(Integer, ForeignKey("workflows.id"), nullable=False, index=True)
    order_index = Column(Integer, nullable=False)
    action = Column(String, nullable=False)
    name = Column(Text, nullable=True)
    target_url = Column(Text, nullable=True)
    selector = Column(Text, nullable=True)
    fallback_selectors = Column(JSON, nullable=True)
    selector_candidates = Column(JSON, nullable=True)
    selector_is_unique = Column(Boolean, nullable=False, default=False)
    text = Column(Text, nullable=True)
    value = Column(Text, nullable=True)
    element_context = Column(JSON, nullable=True)
    confidence = Column(Integer, nullable=True)
    llm_metadata = Column(JSON, nullable=True)
    status = Column(String, nullable=False, default="ready")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    workflow = relationship("Workflow", back_populates="steps")
    step_executions = relationship(
        "StepExecution",
        back_populates="workflow_step",
        cascade="all, delete-orphan",
    )


class ExecutionRun(Base):
    __tablename__ = "execution_runs"

    id = Column(Integer, primary_key=True, index=True)
    workflow_id = Column(Integer, ForeignKey("workflows.id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="pending")
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    run_metadata = Column(JSON, nullable=True)

    workflow = relationship("Workflow", back_populates="execution_runs")
    step_executions = relationship(
        "StepExecution",
        back_populates="execution_run",
        cascade="all, delete-orphan",
        order_by="StepExecution.id",
    )


class StepExecution(Base):
    __tablename__ = "step_executions"

    id = Column(Integer, primary_key=True, index=True)
    execution_run_id = Column(Integer, ForeignKey("execution_runs.id"), nullable=False, index=True)
    workflow_step_id = Column(Integer, ForeignKey("workflow_steps.id"), nullable=False, index=True)
    status = Column(String, nullable=False, default="pending")
    used_selector = Column(Text, nullable=True)
    error = Column(Text, nullable=True)
    execution_metadata = Column(JSON, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    execution_run = relationship("ExecutionRun", back_populates="step_executions")
    workflow_step = relationship("WorkflowStep", back_populates="step_executions")
