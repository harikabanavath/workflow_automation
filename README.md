# Workflow Automation Builder

Monorepo starter for a workflow automation builder with a React frontend, FastAPI backend, and PostgreSQL persistence.

## Architecture

```text
Browser -> React/Vite frontend (:5173)
              |
              v
       FastAPI backend (:8000) -> PostgreSQL (:5432)
```

- `apps/frontend`: React + TypeScript UI shell, served by Vite in development.
- `apps/backend`: FastAPI application with health endpoints and a small API structure ready for workflow APIs.
- `apps/backend/app/workflow`: Pydantic template models and the in-memory workflow state machine.
- `apps/backend/schemas/workflow-template.schema.json`: language-neutral JSON Schema for workflow templates.
- `db/migrations`: SQL migrations for the workflow engine schema.
- `docker-compose.yml`: local development services and a persistent Postgres volume.

## Schema relationships

- `workflow_templates` represents a logical workflow and its immutable versions. `template_key` groups versions; `version` is unique within that key.
- `workflow_instances` is a running submission of one template version. It references `workflow_templates` through `template_id` and `template_version` so a run remains tied to the exact definition used.
- `workflow_steps` materializes the configured steps for an instance. Each row belongs to an instance and can optionally reference a `parent_step_id` for nested or branching flows.
- `approvals` belongs to a workflow step and stores the approval request, reviewer, decision, and timestamps. A step may have multiple approval records.
- `audit_log` is append-only. Every event belongs to an instance and may optionally point to a step or approval, while still supporting instance-level events.

The migration uses UUID primary keys, JSONB for workflow definitions and runtime payloads, explicit status checks, UTC timestamps, indexes for common engine queries, and foreign keys with conservative delete behavior.

## Workflow template and state machine

Templates contain `fields`, `rules`, and ordered `approval_steps`. Supported field types are `text`, `dropdown`, `file`, and `approver-picker`. The backend models validate field references, dropdown options, approval ordering, and required submission values.

`create_workflow_instance(template, submission)` validates a submission and creates an instance in `submitted`. `transition_state(instance, action, actor=..., comment=...)` validates and applies `submit`, `approve`, `reject`, or `complete` actions. A multi-step approval remains in `pending_approval` until each assigned approver has approved; the final approval moves it to `approved`, after which it can be completed.

Unit tests live in `apps/backend/tests/test_state_machine.py` and cover the happy path, invalid transitions, approver authorization, rejection, multi-step approval ordering, and submission validation.

## Run locally with Docker Compose

```bash
docker compose up --build
```

Then open:

- Frontend: http://localhost:5173
- API docs: http://localhost:8000/docs
- Health: http://localhost:8000/health
- Database health: http://localhost:8000/health/db

The backend runs the SQL migrations at startup. PostgreSQL data is stored in the `postgres_data` Docker volume.

## Run without Docker

```bash
# backend
cd apps/backend
python -m venv .venv
.venv\\Scripts\\activate  # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload

# frontend, in another terminal
cd apps/frontend
npm install
npm run dev
```

Set `DATABASE_URL` if the backend should connect to a non-default database. The default local value is `postgresql://workflow:workflow@localhost:5432/workflow`.

## Project layout

```text
workflow-automation/
├── apps/
│   ├── backend/
│   │   ├── app/
│   │   │   ├── main.py
│   │   │   └── settings.py
│   │   ├── Dockerfile
│   │   └── requirements.txt
│   └── frontend/
│       ├── src/
│       ├── Dockerfile
│       ├── package.json
│       └── vite.config.ts
├── db/migrations/001_initial_schema.sql
├── docker-compose.yml
└── README.md
```
