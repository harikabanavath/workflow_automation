from fastapi.testclient import TestClient

from app.api import store
from app.main import app


client = TestClient(app)


def setup_function() -> None:
    store.templates.clear()
    store.instances.clear()
    store.idempotency.clear()


def template_payload() -> dict:
    return {
        "key": "laptop-request",
        "name": "Laptop request",
        "version": 1,
        "fields": [
            {"key": "title", "label": "Title", "type": "text", "required": True},
            {"key": "manager", "label": "Manager", "type": "approver-picker", "required": True},
        ],
        "approval_steps": [
            {"id": "manager-review", "name": "Manager review", "approver_field": "manager", "order": 1}
        ],
    }


def test_duplicate_submission_returns_same_instance() -> None:
    template_response = client.post("/api/templates", json=template_payload(), headers={"X-Role": "admin"})
    template_id = template_response.json()["id"]
    headers = {"X-Role": "requester", "X-Actor": "sam", "Idempotency-Key": "form-submit-1"}
    body = {"submission": {"title": "Laptop", "manager": "alice"}}

    first = client.post(f"/api/templates/{template_id}/instances", json=body, headers=headers)
    second = client.post(f"/api/templates/{template_id}/instances", json=body, headers=headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert len(store.instances) == 1


def test_reusing_idempotency_key_with_different_payload_is_rejected() -> None:
    template_id = client.post("/api/templates", json=template_payload(), headers={"X-Role": "admin"}).json()["id"]
    headers = {"X-Role": "requester", "Idempotency-Key": "form-submit-2"}
    client.post(
        f"/api/templates/{template_id}/instances",
        json={"submission": {"title": "Laptop", "manager": "alice"}},
        headers=headers,
    )
    response = client.post(
        f"/api/templates/{template_id}/instances",
        json={"submission": {"title": "Monitor", "manager": "alice"}},
        headers=headers,
    )
    assert response.status_code == 409


def test_rbac_restricts_template_creation_and_approval() -> None:
    forbidden = client.post("/api/templates", json=template_payload(), headers={"X-Role": "requester"})
    assert forbidden.status_code == 403

    template_id = client.post("/api/templates", json=template_payload(), headers={"X-Role": "admin"}).json()["id"]
    instance_id = client.post(
        f"/api/templates/{template_id}/instances",
        json={"submission": {"title": "Laptop", "manager": "alice"}},
        headers={"X-Role": "requester", "X-Actor": "sam", "Idempotency-Key": "form-submit-3"},
    ).json()["id"]
    forbidden_approval = client.post(
        f"/api/instances/{instance_id}/approve",
        json={},
        headers={"X-Role": "requester", "X-Actor": "alice"},
    )
    assert forbidden_approval.status_code == 403
