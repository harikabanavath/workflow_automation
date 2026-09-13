from typing import Any

from .models import (
    Condition,
    WorkflowInstance,
    WorkflowStatus,
    WorkflowTemplate,
)


class InvalidTransitionError(ValueError):
    """Raised when an action is not allowed from the instance's current state."""


class SubmissionValidationError(ValueError):
    """Raised when a submission does not satisfy its workflow template."""


def _condition_matches(condition: Condition, submission: dict[str, Any]) -> bool:
    present = condition.field in submission and submission[condition.field] not in (None, "")
    actual = submission.get(condition.field)
    if condition.operator == "exists":
        return present == bool(condition.value if condition.value is not None else True)
    if condition.operator == "equals":
        return actual == condition.value
    if condition.operator == "not_equals":
        return actual != condition.value
    if condition.operator == "in":
        return actual in condition.value
    if condition.operator == "not_in":
        return actual not in condition.value
    if condition.operator == "contains":
        return present and condition.value in actual
    raise SubmissionValidationError(f"unsupported condition operator: {condition.operator}")


def _validate_submission(template: WorkflowTemplate, submission: dict[str, Any]) -> None:
    field_map = {field.key: field for field in template.fields}
    unknown_fields = set(submission) - field_map.keys()
    if unknown_fields:
        raise SubmissionValidationError(f"unknown submission fields: {sorted(unknown_fields)}")

    for field in template.fields:
        if field.required and field.key not in submission:
            raise SubmissionValidationError(f"required field is missing: {field.key}")
        if field.type.value == "dropdown" and field.key in submission:
            allowed = {option.value for option in field.options}
            values = submission[field.key] if field.multiple else [submission[field.key]]
            if any(value not in allowed for value in values):
                raise SubmissionValidationError(f"invalid option for field: {field.key}")

    for rule in template.rules:
        matches = [_condition_matches(condition, submission) for condition in rule.when]
        active = all(matches) if rule.match == "all" else any(matches)
        if active and rule.effect == "require" and rule.target not in submission:
            raise SubmissionValidationError(f"conditional field is required: {rule.target}")


def create_workflow_instance(
    template: WorkflowTemplate,
    submission: dict[str, Any],
) -> WorkflowInstance:
    """Validate a submission and materialize a new instance in ``submitted``."""
    _validate_submission(template, submission)
    ordered_steps = sorted(template.approval_steps, key=lambda step: step.order)
    return WorkflowInstance(
        template_key=template.key,
        template_version=template.version,
        submission=submission,
        approvals=[
            {
                "step_id": step.id,
                "step_name": step.name,
                "approver": submission.get(step.approver_field) if step.approver_field else step.approver_role,
            }
            for step in ordered_steps
        ],
    )


def transition_state(
    instance: WorkflowInstance,
    action: str,
    *,
    actor: str | None = None,
    comment: str | None = None,
) -> WorkflowInstance:
    """Apply one validated action and return the same mutated instance."""
    if action == "submit":
        if instance.status != WorkflowStatus.SUBMITTED:
            raise InvalidTransitionError("only submitted workflows can be submitted")
        instance.status = WorkflowStatus.PENDING_APPROVAL
        instance.current_approval_index = 0
        return instance

    if action == "approve":
        if instance.status != WorkflowStatus.PENDING_APPROVAL:
            raise InvalidTransitionError("only pending approvals can be approved")
        if not actor:
            raise InvalidTransitionError("an approver identity is required")
        approval = instance.approvals[instance.current_approval_index or 0]
        if approval.approver and approval.approver != actor:
            raise InvalidTransitionError("actor is not the assigned approver")
        approval.status = "approved"
        approval.decided_by = actor
        approval.comment = comment
        next_index = (instance.current_approval_index or 0) + 1
        if next_index < len(instance.approvals):
            instance.current_approval_index = next_index
        else:
            instance.current_approval_index = None
            instance.status = WorkflowStatus.APPROVED
        return instance

    if action == "reject":
        if instance.status != WorkflowStatus.PENDING_APPROVAL:
            raise InvalidTransitionError("only pending approvals can be rejected")
        if not actor:
            raise InvalidTransitionError("a reviewer identity is required")
        approval = instance.approvals[instance.current_approval_index or 0]
        if approval.approver and approval.approver != actor:
            raise InvalidTransitionError("actor is not the assigned approver")
        approval.status = "rejected"
        approval.decided_by = actor
        approval.comment = comment
        instance.rejection_reason = comment
        instance.current_approval_index = None
        instance.status = WorkflowStatus.REJECTED
        return instance

    if action == "complete":
        if instance.status != WorkflowStatus.APPROVED:
            raise InvalidTransitionError("only approved workflows can be completed")
        instance.status = WorkflowStatus.COMPLETED
        return instance

    raise InvalidTransitionError(f"unknown workflow action: {action}")
