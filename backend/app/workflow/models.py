from enum import Enum
from typing import Any, Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator


class FieldType(str, Enum):
    TEXT = "text"
    DROPDOWN = "dropdown"
    FILE = "file"
    APPROVER_PICKER = "approver-picker"


class DropdownOption(BaseModel):
    value: str
    label: str


class FormField(BaseModel):
    key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    label: str
    type: FieldType
    required: bool = False
    description: str | None = None
    placeholder: str | None = None
    options: list[DropdownOption] = Field(default_factory=list)
    accept: list[str] = Field(default_factory=list)
    multiple: bool = False

    @model_validator(mode="after")
    def validate_type_specific_properties(self) -> "FormField":
        if self.type == FieldType.DROPDOWN and not self.options:
            raise ValueError("dropdown fields must define at least one option")
        if self.type != FieldType.DROPDOWN and self.options:
            raise ValueError("options are only supported for dropdown fields")
        if self.type != FieldType.FILE and self.accept:
            raise ValueError("accept is only supported for file fields")
        return self


class Condition(BaseModel):
    field: str
    operator: Literal["equals", "not_equals", "in", "not_in", "exists", "contains"]
    value: Any = None


class ConditionalRule(BaseModel):
    id: str
    when: list[Condition] = Field(min_length=1)
    effect: Literal["show", "hide", "require", "skip"]
    target: str
    match: Literal["all", "any"] = "all"


class ApprovalStep(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    name: str
    approver_field: str | None = None
    approver_role: str | None = None
    approver_user: str | None = None
    required: bool = True
    order: int = Field(ge=1)

    @model_validator(mode="after")
    def require_approver_source(self) -> "ApprovalStep":
        sources = [self.approver_field, self.approver_role, self.approver_user]
        if sum(source is not None for source in sources) != 1:
            raise ValueError("approval steps need exactly one approver_field, approver_role, or approver_user")
        return self


class WorkflowTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str
    name: str
    version: int = Field(ge=1)
    description: str | None = None
    fields: list[FormField] = Field(min_length=1)
    rules: list[ConditionalRule] = Field(default_factory=list)
    approval_steps: list[ApprovalStep] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_references_and_order(self) -> "WorkflowTemplate":
        field_keys = {field.key for field in self.fields}
        if len(field_keys) != len(self.fields):
            raise ValueError("form field keys must be unique")
        for rule in self.rules:
            if rule.target not in field_keys:
                raise ValueError(f"conditional rule target does not exist: {rule.target}")
            for condition in rule.when:
                if condition.field not in field_keys:
                    raise ValueError(f"conditional rule field does not exist: {condition.field}")
        orders = sorted({step.order for step in self.approval_steps})
        if orders != list(range(1, len(orders) + 1)):
            raise ValueError("approval step order groups must be contiguous starting at 1")
        step_ids = {step.id for step in self.approval_steps}
        if len(step_ids) != len(self.approval_steps):
            raise ValueError("approval step ids must be unique")
        for step in self.approval_steps:
            if step.approver_field and step.approver_field not in field_keys:
                raise ValueError(f"approval step field does not exist: {step.approver_field}")
        return self


class WorkflowStatus(str, Enum):
    SUBMITTED = "submitted"
    PENDING_APPROVAL = "pending_approval"
    APPROVED = "approved"
    REJECTED = "rejected"
    COMPLETED = "completed"


class RuntimeApproval(BaseModel):
    step_id: str
    step_name: str
    order: int
    approver: str | None = None
    approver_role: str | None = None
    status: Literal["pending", "approved", "rejected"] = "pending"
    decided_by: str | None = None
    comment: str | None = None


class WorkflowInstance(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    template_key: str
    template_version: int
    submission: dict[str, Any]
    status: WorkflowStatus = WorkflowStatus.SUBMITTED
    current_approval_index: int | None = None
    approvals: list[RuntimeApproval] = Field(default_factory=list)
    rejection_reason: str | None = None
