import pytest

from app.workflow import (
    ApprovalStep,
    FormField,
    InvalidTransitionError,
    SubmissionValidationError,
    WorkflowTemplate,
    WorkflowStatus,
    create_workflow_instance,
    transition_state,
)


def template_with_approvers(*approvers: str) -> WorkflowTemplate:
    return WorkflowTemplate(
        key="equipment-request",
        name="Equipment Request",
        version=1,
        fields=[
            FormField(key="request_title", label="Title", type="text", required=True),
            FormField(key="equipment_type", label="Type", type="text", required=True),
            *[
                FormField(key=approver, label=approver, type="approver-picker", required=True)
                for approver in approvers
            ],
        ],
        approval_steps=[
            ApprovalStep(id=f"step-{index}", name=f"Review {index}", approver_field=approver, order=index)
            for index, approver in enumerate(approvers, start=1)
        ],
    )


def make_instance() -> object:
    template = template_with_approvers("manager")
    return create_workflow_instance(
        template,
        {"request_title": "Laptop", "equipment_type": "laptop", "manager": "alice"},
    )


def test_valid_single_step_lifecycle() -> None:
    instance = make_instance()
    assert instance.status == WorkflowStatus.SUBMITTED

    transition_state(instance, "submit")
    assert instance.status == WorkflowStatus.PENDING_APPROVAL
    assert instance.current_approval_index == 0

    transition_state(instance, "approve", actor="alice", comment="Looks good")
    assert instance.status == WorkflowStatus.APPROVED

    transition_state(instance, "complete")
    assert instance.status == WorkflowStatus.COMPLETED


def test_invalid_transitions_are_rejected() -> None:
    instance = make_instance()
    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "approve", actor="alice")

    transition_state(instance, "submit")
    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "complete")
    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "approve", actor="mallory")

    transition_state(instance, "reject", actor="alice", comment="Insufficient justification")
    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "complete")
    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "submit")


def test_multi_step_chain_requires_each_approver_in_order() -> None:
    template = template_with_approvers("manager", "finance")
    instance = create_workflow_instance(
        template,
        {
            "request_title": "Workstation",
            "equipment_type": "laptop",
            "manager": "alice",
            "finance": "bob",
        },
    )
    transition_state(instance, "submit")

    transition_state(instance, "approve", actor="alice")
    assert instance.status == WorkflowStatus.PENDING_APPROVAL
    assert instance.current_approval_index == 1
    assert instance.approvals[0].status == "approved"

    with pytest.raises(InvalidTransitionError):
        transition_state(instance, "approve", actor="alice")

    transition_state(instance, "approve", actor="bob")
    assert instance.status == WorkflowStatus.APPROVED
    assert [approval.status for approval in instance.approvals] == ["approved", "approved"]


def test_rejection_stops_a_multi_step_chain() -> None:
    template = template_with_approvers("manager", "finance")
    instance = create_workflow_instance(
        template,
        {
            "request_title": "Monitor",
            "equipment_type": "monitor",
            "manager": "alice",
            "finance": "bob",
        },
    )
    transition_state(instance, "submit")
    transition_state(instance, "reject", actor="alice", comment="Use existing inventory")
    assert instance.status == WorkflowStatus.REJECTED
    assert instance.approvals[1].status == "pending"


def test_submission_validation_catches_required_and_conditional_fields() -> None:
    template = template_with_approvers("manager")
    with pytest.raises(SubmissionValidationError):
        create_workflow_instance(template, {"equipment_type": "laptop", "manager": "alice"})


def test_parallel_approval_stage_waits_for_all_approvers() -> None:
    template = WorkflowTemplate(
        key="access-request",
        name="Access Request",
        version=1,
        fields=[
            FormField(key="title", label="Title", type="text", required=True),
        ],
        approval_steps=[
            ApprovalStep(id="security", name="Security", approver_user="alice", order=1),
            ApprovalStep(id="systems", name="Systems", approver_user="bob", order=1),
            ApprovalStep(id="owner", name="Owner", approver_user="casey", order=2),
        ],
    )
    instance = create_workflow_instance(template, {"title": "VPN"})
    transition_state(instance, "submit")

    transition_state(instance, "approve", actor="alice")
    assert instance.status == WorkflowStatus.PENDING_APPROVAL
    assert instance.current_approval_index == 1

    transition_state(instance, "approve", actor="bob")
    assert instance.status == WorkflowStatus.PENDING_APPROVAL
    assert instance.current_approval_index == 2

    transition_state(instance, "approve", actor="casey")
    assert instance.status == WorkflowStatus.APPROVED
