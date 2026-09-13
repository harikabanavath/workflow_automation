from datetime import datetime, timezone
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel, Field

from .workflow import (
    InvalidTransitionError,
    WorkflowInstance,
    WorkflowStatus,
    WorkflowTemplate,
    create_workflow_instance,
    transition_state,
)


class Role(str, Enum):
    REQUESTER = "requester"
    APPROVER = "approver"
    ADMIN = "admin"


class TemplateRecord(BaseModel):
    id: UUID
    template: WorkflowTemplate
    created_at: datetime


class InstanceRecord(BaseModel):
    instance: WorkflowInstance
    audit: list[dict[str, Any]] = Field(default_factory=list)
    idempotency_key: str | None = None
    submission_fingerprint: str | None = None


class SubmitRequest(BaseModel):
    submission: dict[str, Any]


class TransitionRequest(BaseModel):
    comment: str | None = None


class WorkflowStore:
    """Repository used by the API layer; replace with SQL-backed persistence later."""

    def __init__(self) -> None:
        self.templates: dict[UUID, TemplateRecord] = {}
        self.instances: dict[UUID, InstanceRecord] = {}
        self.idempotency: dict[tuple[str, UUID, str], tuple[str, UUID]] = {}

    def add_template(self, template: WorkflowTemplate) -> TemplateRecord:
        record = TemplateRecord(id=uuid4(), template=template, created_at=datetime.now(timezone.utc))
        self.templates[record.id] = record
        return record

    def get_template(self, template_id: UUID) -> TemplateRecord:
        record = self.templates.get(template_id)
        if not record:
            raise HTTPException(status_code=404, detail="workflow template not found")
        return record

    def find_idempotent(self, requester: str, template_id: UUID, key: str, fingerprint: str) -> UUID | None:
        existing = self.idempotency.get((requester, template_id, key))
        if not existing:
            return None
        existing_fingerprint, instance_id = existing
        if existing_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="idempotency key was reused with a different submission")
        return instance_id


store = WorkflowStore()
router = APIRouter(prefix="/api")


def _record_event(record: InstanceRecord, event_type: str, actor: str, payload: dict[str, Any] | None = None) -> None:
    record.audit.append({
        "id": len(record.audit) + 1,
        "event_type": event_type,
        "actor": actor,
        "payload": payload or {},
        "created_at": datetime.now(timezone.utc).isoformat(),
    })


def _fingerprint(payload: SubmitRequest) -> str:
    import hashlib
    import json

    canonical = json.dumps(payload.submission, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@router.post("/templates", response_model=TemplateRecord, status_code=status.HTTP_201_CREATED)
def create_template(template: WorkflowTemplate, request: Request) -> TemplateRecord:
    record = store.add_template(template)
    return record


@router.get("/templates", response_model=list[TemplateRecord])
def list_templates() -> list[TemplateRecord]:
    return list(store.templates.values())


@router.post("/templates/{template_id}/instances", response_model=WorkflowInstance, status_code=status.HTTP_201_CREATED)
def submit_instance(
    template_id: UUID,
    body: SubmitRequest,
    request: Request,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> WorkflowInstance:
    if not idempotency_key:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    requester = request.state.actor
    template_record = store.get_template(template_id)
    fingerprint = _fingerprint(body)
    existing_id = store.find_idempotent(requester, template_id, idempotency_key, fingerprint)
    if existing_id:
        return store.instances[existing_id].instance

    try:
        instance = create_workflow_instance(template_record.template, body.submission)
        transition_state(instance, "submit")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    record = InstanceRecord(instance=instance, idempotency_key=idempotency_key, submission_fingerprint=fingerprint)
    _record_event(record, "instance_submitted", requester, {"template_id": str(template_id)})
    _record_event(record, "approval_started", requester, {"status": instance.status.value})
    store.instances[instance.id] = record
    store.idempotency[(requester, template_id, idempotency_key)] = (fingerprint, instance.id)
    return instance


@router.get("/instances/{instance_id}", response_model=WorkflowInstance)
def get_instance(instance_id: UUID) -> WorkflowInstance:
    record = store.instances.get(instance_id)
    if not record:
        raise HTTPException(status_code=404, detail="workflow instance not found")
    return record.instance


def _transition(instance_id: UUID, action: str, request: Request, body: TransitionRequest) -> WorkflowInstance:
    record = store.instances.get(instance_id)
    if not record:
        raise HTTPException(status_code=404, detail="workflow instance not found")
    try:
        instance = transition_state(record.instance, action, actor=request.state.actor, comment=body.comment)
    except InvalidTransitionError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _record_event(record, f"approval_{action}", request.state.actor, {"comment": body.comment})
    return instance


@router.post("/instances/{instance_id}/approve", response_model=WorkflowInstance)
def approve_step(instance_id: UUID, body: TransitionRequest, request: Request) -> WorkflowInstance:
    return _transition(instance_id, "approve", request, body)


@router.post("/instances/{instance_id}/reject", response_model=WorkflowInstance)
def reject_step(instance_id: UUID, body: TransitionRequest, request: Request) -> WorkflowInstance:
    return _transition(instance_id, "reject", request, body)


@router.get("/instances/{instance_id}/audit", response_model=list[dict[str, Any]])
def get_audit_log(instance_id: UUID) -> list[dict[str, Any]]:
    record = store.instances.get(instance_id)
    if not record:
        raise HTTPException(status_code=404, detail="workflow instance not found")
    return record.audit


@router.get("/approvals/pending", response_model=list[WorkflowInstance])
def list_pending_approvals(request: Request) -> list[WorkflowInstance]:
    actor = request.state.actor
    role = request.state.role
    pending: list[WorkflowInstance] = []
    for record in store.instances.values():
        instance = record.instance
        if instance.status != WorkflowStatus.PENDING_APPROVAL or instance.current_approval_index is None:
            continue
        current = instance.approvals[instance.current_approval_index]
        if role == Role.ADMIN or current.approver == actor:
            pending.append(instance)
    return pending


ROLE_RULES: dict[str, set[Role]] = {
    "POST /api/templates": {Role.ADMIN},
    "GET /api/templates": {Role.REQUESTER, Role.APPROVER, Role.ADMIN},
    "POST /api/templates/{template_id}/instances": {Role.REQUESTER, Role.ADMIN},
    "GET /api/instances/{instance_id}": {Role.REQUESTER, Role.APPROVER, Role.ADMIN},
    "POST /api/instances/{instance_id}/approve": {Role.APPROVER, Role.ADMIN},
    "POST /api/instances/{instance_id}/reject": {Role.APPROVER, Role.ADMIN},
    "GET /api/instances/{instance_id}/audit": {Role.APPROVER, Role.ADMIN},
    "GET /api/approvals/pending": {Role.APPROVER, Role.ADMIN},
}


def role_for_request(request: Request) -> Role:
    raw_role = request.headers.get("X-Role", "")
    try:
        return Role(raw_role.lower())
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="X-Role must be requester, approver, or admin") from exc


async def rbac_middleware(request: Request, call_next: Any) -> Any:
    if request.url.path in {"/health", "/health/db", "/docs", "/openapi.json", "/redoc"}:
        return await call_next(request)
    key = f"{request.method} {request.url.path}"
    rule = next((allowed for pattern, allowed in ROLE_RULES.items() if _matches(pattern, key)), None)
    if rule is None:
        return await call_next(request)
    try:
        role = role_for_request(request)
    except HTTPException as exc:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    if role not in rule:
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "role is not allowed to call this endpoint"}, status_code=403)
    request.state.actor = request.headers.get("X-Actor", role.value)
    request.state.role = role
    return await call_next(request)


def _matches(pattern: str, actual: str) -> bool:
    pattern_parts = pattern.split(" ", 1)
    actual_parts = actual.split(" ", 1)
    if pattern_parts[0] != actual_parts[0]:
        return False
    pattern_path = pattern_parts[1].split("/")
    actual_path = actual_parts[1].split("/")
    return len(pattern_path) == len(actual_path) and all(
        left == right or left.startswith("{") and left.endswith("}")
        for left, right in zip(pattern_path, actual_path)
    )
