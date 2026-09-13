CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_key TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    version INTEGER NOT NULL CHECK (version > 0),
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    UNIQUE (template_key, version),
    UNIQUE (id, version)
);

CREATE TABLE IF NOT EXISTS workflow_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE RESTRICT,
    template_version INTEGER NOT NULL,
    submission_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
    started_by TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, template_id),
    FOREIGN KEY (template_id, template_version) REFERENCES workflow_templates(id, version) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,
    name TEXT NOT NULL,
    step_type TEXT NOT NULL,
    parent_step_id UUID REFERENCES workflow_steps(id) ON DELETE SET NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    input_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    output_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'running', 'waiting_approval', 'completed', 'failed', 'skipped')),
    position INTEGER NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instance_id, step_key)
);

CREATE TABLE IF NOT EXISTS approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    step_id UUID NOT NULL REFERENCES workflow_steps(id) ON DELETE CASCADE,
    requested_from TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    comment TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at TIMESTAMPTZ,
    decided_by TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    instance_id UUID NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
    step_id UUID REFERENCES workflow_steps(id) ON DELETE SET NULL,
    approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_key ON workflow_templates(template_key);
CREATE INDEX IF NOT EXISTS idx_workflow_instances_status ON workflow_instances(status);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_instance_status ON workflow_steps(instance_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_step_status ON approvals(step_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_instance_created ON audit_log(instance_id, created_at DESC);
