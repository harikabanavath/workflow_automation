import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type FieldType = "text" | "dropdown" | "file" | "approver-picker";
type RuleEffect = "show" | "hide" | "require" | "skip";
type Operator = "equals" | "not_equals" | "in" | "not_in" | "exists" | "contains";

type WorkflowField = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  accept?: string[];
  multiple?: boolean;
};

type WorkflowRule = {
  id: string;
  when: Array<{ field: string; operator: Operator; value?: unknown }>;
  effect: RuleEffect;
  target: string;
  match?: "all" | "any";
};

type ApprovalStep = {
  id: string;
  name: string;
  approver_field?: string;
  approver_role?: string;
  approver_user?: string;
  order: number;
};

type WorkflowTemplate = {
  id?: string;
  key: string;
  name: string;
  version: number;
  description?: string;
  fields: WorkflowField[];
  rules?: WorkflowRule[];
  approval_steps: ApprovalStep[];
};

type TemplateRecord = {
  id: string;
  template: Omit<WorkflowTemplate, "id">;
  created_at: string;
};

type RuntimeApproval = {
  step_id: string;
  step_name: string;
  approver?: string | null;
  status: "pending" | "approved" | "rejected";
  decided_by?: string | null;
  comment?: string | null;
};

type WorkflowInstance = {
  id: string;
  template_key: string;
  template_version: number;
  submission: Record<string, unknown>;
  status: "submitted" | "pending_approval" | "approved" | "rejected" | "completed";
  current_approval_index?: number | null;
  approvals: RuntimeApproval[];
  rejection_reason?: string | null;
};

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

const fallbackTemplate: WorkflowTemplate = {
  key: "equipment-request",
  name: "Equipment Request",
  version: 1,
  description: "Request equipment with budget-aware approval routing.",
  fields: [
    { key: "request_title", label: "Request title", type: "text", required: true, placeholder: "New laptop for design team" },
    {
      key: "equipment_type",
      label: "Equipment type",
      type: "dropdown",
      required: true,
      options: [
        { value: "laptop", label: "Laptop" },
        { value: "monitor", label: "Monitor" },
        { value: "phone", label: "Phone" },
        { value: "other", label: "Other" },
      ],
    },
    {
      key: "estimated_cost",
      label: "Estimated cost",
      type: "dropdown",
      required: true,
      options: [
        { value: "under-1000", label: "Under $1,000" },
        { value: "over-1000", label: "Over $1,000" },
      ],
    },
    { key: "justification", label: "Business justification", type: "text", required: true },
    { key: "quote", label: "Vendor quote", type: "file", accept: ["application/pdf", "image/*"] },
    { key: "manager_approver", label: "Manager approver", type: "approver-picker", required: true },
    { key: "finance_approver", label: "Finance approver", type: "approver-picker" },
  ],
  rules: [
    {
      id: "quote-for-expensive-equipment",
      when: [{ field: "estimated_cost", operator: "equals", value: "over-1000" }],
      effect: "require",
      target: "quote",
    },
    {
      id: "finance-approval-for-expensive-equipment",
      when: [{ field: "estimated_cost", operator: "equals", value: "over-1000" }],
      effect: "show",
      target: "finance_approver",
    },
  ],
  approval_steps: [
    { id: "manager-review", name: "Manager review", approver_field: "manager_approver", order: 1 },
    { id: "finance-review", name: "Finance review", approver_field: "finance_approver", order: 2 },
  ],
};

const approvers = ["alice", "bob", "casey", "drew", "finance-team"];
const roles = ["manager", "finance", "security", "legal"];
const actorOptions = [...approvers, ...roles];

function conditionMatches(value: unknown, operator: Operator, expected: unknown) {
  if (operator === "equals") return value === expected;
  if (operator === "not_equals") return value !== expected;
  if (operator === "in") return Array.isArray(expected) && expected.includes(value);
  if (operator === "not_in") return Array.isArray(expected) && !expected.includes(value);
  if (operator === "exists") return value !== undefined && value !== null && value !== "";
  if (operator === "contains") return Array.isArray(value) ? value.includes(expected) : String(value ?? "").includes(String(expected ?? ""));
  return false;
}

function ruleMatches(rule: WorkflowRule, values: Record<string, unknown>) {
  const results = rule.when.map((condition) => conditionMatches(values[condition.field], condition.operator, condition.value));
  return (rule.match ?? "all") === "any" ? results.some(Boolean) : results.every(Boolean);
}

function fieldState(field: WorkflowField, rules: WorkflowRule[], values: Record<string, unknown>) {
  let visible = !rules.some((rule) => rule.target === field.key && rule.effect === "show");
  let required = Boolean(field.required);

  for (const rule of rules.filter((item) => item.target === field.key)) {
    const matched = ruleMatches(rule, values);
    if (rule.effect === "show" && matched) visible = true;
    if ((rule.effect === "hide" || rule.effect === "skip") && matched) visible = false;
    if (rule.effect === "require" && matched) required = true;
  }

  return { visible, required };
}

function submissionValue(value: unknown) {
  if (value && typeof value === "object" && "name" in value) {
    return String((value as { name: string }).name);
  }
  return String(value ?? "");
}

function App() {
  const [role, setRole] = useState<"requester" | "approver" | "admin">("requester");
  const [actor, setActor] = useState("alice");
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([fallbackTemplate]);
  const [selectedKey, setSelectedKey] = useState(fallbackTemplate.key);
  const [builderTemplate, setBuilderTemplate] = useState<WorkflowTemplate>(fallbackTemplate);
  const [draggedFieldKey, setDraggedFieldKey] = useState<string | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [pending, setPending] = useState<WorkflowInstance[]>([]);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("Using sample workflow until the API has templates.");

  const selectedTemplate = templates.find((template) => template.key === selectedKey) ?? templates[0];
  const rules = selectedTemplate.rules ?? [];

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/templates`, { headers: authHeaders("requester", actor) })
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((records: TemplateRecord[]) => {
        const loaded = records.map((record) => ({ ...record.template, id: record.id }));
        if (loaded.length > 0) {
          setTemplates(loaded);
          setSelectedKey(loaded[0].key);
          setNotice("Loaded workflow templates from the API.");
        }
      })
      .catch(() => setNotice("API unavailable or empty. You can still try the sample workflow locally."));
  }, [actor]);

  useEffect(() => {
    if (role === "approver" || role === "admin") {
      refreshPending(role, actor).then(setPending).catch(() => setPending([]));
    }
  }, [role, actor]);

  const visibleFields = useMemo(
    () => selectedTemplate.fields.filter((field) => fieldState(field, rules, values).visible),
    [selectedTemplate, rules, values],
  );

  useEffect(() => {
    setBuilderTemplate(JSON.parse(JSON.stringify(selectedTemplate)) as WorkflowTemplate);
  }, [selectedTemplate]);

  function updateValue(key: string, value: unknown) {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submitWorkflow(event: React.FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    const submission: Record<string, unknown> = {};

    for (const field of selectedTemplate.fields) {
      const state = fieldState(field, rules, values);
      if (!state.visible) continue;
      const value = values[field.key];
      if (state.required && (value === undefined || value === "" || value === null)) {
        nextErrors[field.key] = "Required by this workflow";
      } else if (value !== undefined && value !== "") {
        submission[field.key] = value;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    if (!selectedTemplate.id) {
      const localInstance = makeLocalInstance(selectedTemplate, submission);
      setInstances((current) => [localInstance, ...current]);
      setNotice("Sample submission created locally. Create the template through the API to submit to FastAPI.");
      return;
    }

    const response = await fetch(`${apiBaseUrl}/api/templates/${selectedTemplate.id}/instances`, {
      method: "POST",
      headers: { ...authHeaders("requester", actor), "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ submission }),
    });
    if (!response.ok) {
      setNotice(`Submission failed: ${await response.text()}`);
      return;
    }
    const instance = await response.json();
    setInstances((current) => [instance, ...current]);
    setValues({});
    setNotice("Workflow submitted and routed to the first approver.");
  }

  async function decide(instanceId: string, action: "approve" | "reject") {
    const response = await fetch(`${apiBaseUrl}/api/instances/${instanceId}/${action}`, {
      method: "POST",
      headers: { ...authHeaders(role, actor), "Content-Type": "application/json" },
      body: JSON.stringify({ comment: comments[instanceId] ?? "" }),
    });
    if (!response.ok) {
      setNotice(`${action} failed: ${await response.text()}`);
      return;
    }
    setPending(await refreshPending(role, actor));
    setComments((current) => ({ ...current, [instanceId]: "" }));
    setNotice(`Approval ${action} recorded.`);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <p className="eyebrow">Workflow Builder</p>
        <h1>Dynamic workflow console</h1>
        <label>
          Role
          <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
            <option value="requester">Requester</option>
            <option value="approver">Approver</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <label>
          Logged-in user
          <select value={actor} onChange={(event) => setActor(event.target.value)}>
            {actorOptions.map((person) => <option key={person} value={person}>{person}</option>)}
          </select>
        </label>
        <p className="notice">{notice}</p>
      </aside>

      <section className="workspace">
        {role === "admin" && (
          <TemplateBuilder
            template={builderTemplate}
            liveTemplateId={selectedTemplate.id}
            draggedFieldKey={draggedFieldKey}
            onDragStart={setDraggedFieldKey}
            onChange={setBuilderTemplate}
            onSave={async () => {
              const saved = await saveTemplate(builderTemplate, selectedTemplate.id, actor);
              if (!saved) {
                setNotice("Template save failed. Check that the backend is running and the schema is valid.");
                return;
              }
              const next = { ...saved.template, id: saved.id };
              setTemplates((current) => [next, ...current.filter((template) => template.id !== next.id)]);
              setSelectedKey(next.key);
              setNotice(`${next.name} saved as version ${next.version}. In-flight instances continue on their original version.`);
            }}
          />
        )}

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Submission</p>
              <h2>{selectedTemplate.name}</h2>
            </div>
            <select value={selectedKey} onChange={(event) => setSelectedKey(event.target.value)}>
              {templates.map((template) => <option key={template.key} value={template.key}>{template.name}</option>)}
            </select>
          </div>

          <form className="dynamic-form" onSubmit={submitWorkflow}>
            {visibleFields.map((field) => {
              const state = fieldState(field, rules, values);
              return (
                <div className="field" key={field.key}>
                  <label htmlFor={field.key}>
                    {field.label}
                    {state.required && <span>Required</span>}
                  </label>
                  <FieldControl field={field} value={values[field.key]} onChange={(value) => updateValue(field.key, value)} />
                  {field.description && <p className="hint">{field.description}</p>}
                  {errors[field.key] && <p className="error">{errors[field.key]}</p>}
                </div>
              );
            })}
            <button type="submit">Submit workflow</button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Approvals</p>
              <h2>Pending for {actor}</h2>
            </div>
            <button type="button" className="secondary" onClick={() => refreshPending(role, actor).then(setPending)}>Refresh</button>
          </div>
          <div className="approval-list">
            {pending.length === 0 && <p className="empty">No pending approvals assigned to this user.</p>}
            {pending.map((instance) => {
              const current = instance.current_approval_index == null ? undefined : instance.approvals[instance.current_approval_index];
              return (
                <article className="approval-card" key={instance.id}>
                  <header>
                    <div>
                      <strong>{current?.step_name ?? "Approval"}</strong>
                      <p>{instance.template_key} v{instance.template_version}</p>
                    </div>
                    <span>{instance.status}</span>
                  </header>
                  <dl>
                    {Object.entries(instance.submission).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key.replaceAll("_", " ")}</dt>
                        <dd>{submissionValue(value)}</dd>
                      </div>
                    ))}
                  </dl>
                  <textarea
                    placeholder="Decision comment"
                    value={comments[instance.id] ?? ""}
                    onChange={(event) => setComments((current) => ({ ...current, [instance.id]: event.target.value }))}
                  />
                  <div className="decision-row">
                    <button type="button" onClick={() => decide(instance.id, "approve")}>Approve</button>
                    <button type="button" className="danger" onClick={() => decide(instance.id, "reject")}>Reject</button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel full">
          <p className="eyebrow">Recent local submissions</p>
          <div className="status-list">
            {instances.length === 0 && <p className="empty">Submitted workflows appear here.</p>}
            {instances.map((instance) => (
              <div className="status-row" key={instance.id}>
                <span>{instance.template_key}</span>
                <strong>{instance.status}</strong>
                <small>{instance.id}</small>
              </div>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function FieldControl({ field, value, onChange }: { field: WorkflowField; value: unknown; onChange: (value: unknown) => void }) {
  if (field.type === "dropdown") {
    return (
      <select id={field.key} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select an option</option>
        {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }

    if (field.type === "file") {
    const fileText = Array.isArray(value)
      ? value.map((item) => submissionValue(item)).join(", ")
      : submissionValue(value);
    return (
      <div className="file-input">
        <input
          id={field.key}
          type="file"
          multiple={field.multiple}
          accept={(field.accept ?? []).join(",")}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []).map((file) => ({ name: file.name, size: file.size, type: file.type }));
            onChange(field.multiple ? files : files[0]);
          }}
        />
        <span>{fileText || "Choose file"}</span>
      </div>
    );
  }

  if (field.type === "approver-picker") {
    return (
      <select id={field.key} value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose approver</option>
        {approvers.map((person) => <option key={person} value={person}>{person}</option>)}
      </select>
    );
  }

  return (
    <input
      id={field.key}
      type="text"
      value={String(value ?? "")}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function authHeaders(role: "requester" | "approver" | "admin", actor: string) {
  return { "X-Role": role, "X-Actor": actor };
}

async function refreshPending(role: "requester" | "approver" | "admin", actor: string) {
  const response = await fetch(`${apiBaseUrl}/api/approvals/pending`, { headers: authHeaders(role, actor) });
  if (!response.ok) return [];
  return response.json() as Promise<WorkflowInstance[]>;
}

function makeLocalInstance(template: WorkflowTemplate, submission: Record<string, unknown>): WorkflowInstance {
  return {
    id: crypto.randomUUID(),
    template_key: template.key,
    template_version: template.version,
    submission,
    status: "pending_approval",
    current_approval_index: 0,
    approvals: template.approval_steps.map((step) => ({
      step_id: step.id,
      step_name: step.name,
      order: step.order,
      approver: step.approver_field ? String(submission[step.approver_field] ?? "") : step.approver_user,
      approver_role: step.approver_role,
      status: "pending",
    })),
  };
}

function TemplateBuilder({
  template,
  liveTemplateId,
  draggedFieldKey,
  onDragStart,
  onChange,
  onSave,
}: {
  template: WorkflowTemplate;
  liveTemplateId?: string;
  draggedFieldKey: string | null;
  onDragStart: (key: string | null) => void;
  onChange: (template: WorkflowTemplate) => void;
  onSave: () => void;
}) {
  const rules = template.rules ?? [];
  const fieldOptions = template.fields.map((field) => ({ value: field.key, label: field.label || field.key }));

  function patchTemplate(patch: Partial<WorkflowTemplate>) {
    onChange({ ...template, ...patch });
  }

  function patchField(key: string, patch: Partial<WorkflowField>) {
    patchTemplate({
      fields: template.fields.map((field) => normalizeField(field.key === key ? { ...field, ...patch } : field)),
    });
  }

  function addField(type: FieldType) {
    const count = template.fields.length + 1;
    const key = `${type.replace("-", "_")}_${count}`;
    const base: WorkflowField = { key, label: `New ${type.replace("-", " ")} field`, type, required: false };
    patchTemplate({ fields: [...template.fields, normalizeField(base)] });
  }

  function removeField(key: string) {
    patchTemplate({
      fields: template.fields.filter((field) => field.key !== key),
      rules: rules.filter((rule) => rule.target !== key && rule.when.every((condition) => condition.field !== key)),
      approval_steps: template.approval_steps.filter((step) => step.approver_field !== key),
    });
  }

  function moveField(targetKey: string) {
    if (!draggedFieldKey || draggedFieldKey === targetKey) return;
    const current = [...template.fields];
    const from = current.findIndex((field) => field.key === draggedFieldKey);
    const to = current.findIndex((field) => field.key === targetKey);
    if (from < 0 || to < 0) return;
    const [moved] = current.splice(from, 1);
    current.splice(to, 0, moved);
    patchTemplate({ fields: current });
    onDragStart(null);
  }

  function patchRule(id: string, patch: Partial<WorkflowRule>) {
    patchTemplate({ rules: rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)) });
  }

  function addRule() {
    const first = template.fields[0]?.key ?? "field";
    patchTemplate({
      rules: [
        ...rules,
        {
          id: `rule_${rules.length + 1}`,
          target: first,
          effect: "show",
          match: "all",
          when: [{ field: first, operator: "equals", value: "" }],
        },
      ],
    });
  }

  function patchStep(id: string, patch: Partial<ApprovalStep>) {
    patchTemplate({ approval_steps: renumberSteps(template.approval_steps.map((step) => normalizeStep(step.id === id ? { ...step, ...patch } : step))) });
  }

  function addStep(parallelWithPrevious: boolean) {
    const nextOrder = parallelWithPrevious
      ? Math.max(1, ...template.approval_steps.map((step) => step.order))
      : Math.max(0, ...template.approval_steps.map((step) => step.order)) + 1;
    patchTemplate({
      approval_steps: [
        ...template.approval_steps,
        { id: `approval_${template.approval_steps.length + 1}`, name: "Approval step", approver_user: approvers[0], order: nextOrder },
      ],
    });
  }

  return (
    <section className="panel full builder">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Admin builder</p>
          <h2>Template designer</h2>
        </div>
        <button type="button" onClick={onSave}>{liveTemplateId ? "Save new version" : "Save template"}</button>
      </div>

      <div className="builder-grid">
        <section className="builder-column">
          <h3>Template</h3>
          <label>Name<input value={template.name} onChange={(event) => patchTemplate({ name: event.target.value })} /></label>
          <label>Key<input value={template.key} onChange={(event) => patchTemplate({ key: slugify(event.target.value) })} disabled={Boolean(liveTemplateId)} /></label>
          <label>Description<textarea value={template.description ?? ""} onChange={(event) => patchTemplate({ description: event.target.value })} /></label>
          <div className="button-row">
            {(["text", "dropdown", "file", "approver-picker"] as FieldType[]).map((type) => (
              <button className="secondary" type="button" key={type} onClick={() => addField(type)}>Add {type}</button>
            ))}
          </div>
        </section>

        <section className="builder-column wide">
          <h3>Fields</h3>
          <div className="builder-list">
            {template.fields.map((field) => (
              <article
                className="builder-item"
                key={field.key}
                draggable
                onDragStart={() => onDragStart(field.key)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => moveField(field.key)}
              >
                <div className="item-heading">
                  <strong>{field.label}</strong>
                  <button type="button" className="secondary compact" onClick={() => removeField(field.key)}>Remove</button>
                </div>
                <div className="editor-grid">
                  <label>Label<input value={field.label} onChange={(event) => patchField(field.key, { label: event.target.value })} /></label>
                  <label>Key<input value={field.key} onChange={(event) => patchField(field.key, { key: slugify(event.target.value) })} /></label>
                  <label>Type
                    <select value={field.type} onChange={(event) => patchField(field.key, { type: event.target.value as FieldType })}>
                      <option value="text">Text</option>
                      <option value="dropdown">Dropdown</option>
                      <option value="file">File upload</option>
                      <option value="approver-picker">Approver picker</option>
                    </select>
                  </label>
                  <label className="check-row"><input type="checkbox" checked={Boolean(field.required)} onChange={(event) => patchField(field.key, { required: event.target.checked })} /> Required</label>
                  {field.type === "dropdown" && (
                    <label className="span-2">Options, one value per line
                      <textarea value={(field.options ?? []).map((option) => option.value).join("\n")} onChange={(event) => patchField(field.key, { options: optionLines(event.target.value) })} />
                    </label>
                  )}
                  {field.type === "file" && (
                    <label className="span-2">Accepted MIME types
                      <input value={(field.accept ?? []).join(", ")} onChange={(event) => patchField(field.key, { accept: csv(event.target.value) })} />
                    </label>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="builder-column">
          <div className="item-heading">
            <h3>Conditional logic</h3>
            <button type="button" className="secondary compact" onClick={addRule}>Add rule</button>
          </div>
          <div className="builder-list">
            {rules.map((rule) => (
              <article className="builder-item" key={rule.id}>
                <label>When field
                  <select value={rule.when[0]?.field ?? ""} onChange={(event) => patchRule(rule.id, { when: [{ ...(rule.when[0] ?? {}), field: event.target.value, operator: rule.when[0]?.operator ?? "equals" }] })}>
                    {fieldOptions.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
                  </select>
                </label>
                <label>Operator
                  <select value={rule.when[0]?.operator ?? "equals"} onChange={(event) => patchRule(rule.id, { when: [{ ...(rule.when[0] ?? {}), operator: event.target.value as Operator }] })}>
                    <option value="equals">Equals</option>
                    <option value="not_equals">Does not equal</option>
                    <option value="exists">Exists</option>
                    <option value="contains">Contains</option>
                  </select>
                </label>
                <label>Value<input value={String(rule.when[0]?.value ?? "")} onChange={(event) => patchRule(rule.id, { when: [{ ...(rule.when[0] ?? {}), value: event.target.value }] })} /></label>
                <label>Effect
                  <select value={rule.effect} onChange={(event) => patchRule(rule.id, { effect: event.target.value as RuleEffect })}>
                    <option value="show">Show</option>
                    <option value="hide">Hide</option>
                    <option value="require">Require</option>
                    <option value="skip">Skip</option>
                  </select>
                </label>
                <label>Target
                  <select value={rule.target} onChange={(event) => patchRule(rule.id, { target: event.target.value })}>
                    {fieldOptions.map((field) => <option key={field.value} value={field.value}>{field.label}</option>)}
                  </select>
                </label>
              </article>
            ))}
          </div>
        </section>

        <section className="builder-column wide">
          <div className="item-heading">
            <h3>Approval chain</h3>
            <div className="button-row tight">
              <button type="button" className="secondary compact" onClick={() => addStep(false)}>Add stage</button>
              <button type="button" className="secondary compact" onClick={() => addStep(true)}>Add parallel</button>
            </div>
          </div>
          <div className="approval-chain">
            {approvalGroups(template.approval_steps).map(([order, steps]) => (
              <div className="approval-stage" key={order}>
                <span>Stage {order}</span>
                {steps.map((step) => (
                  <article className="builder-item" key={step.id}>
                    <input value={step.name} onChange={(event) => patchStep(step.id, { name: event.target.value })} />
                    <div className="editor-grid">
                      <label>Assignment
                        <select value={step.approver_user ? "person" : step.approver_role ? "role" : "field"} onChange={(event) => patchStep(step.id, resetStepAssignment(step, event.target.value))}>
                          <option value="person">Person</option>
                          <option value="role">Role</option>
                          <option value="field">Form approver field</option>
                        </select>
                      </label>
                      {step.approver_user && (
                        <label>Person
                          <select value={step.approver_user} onChange={(event) => patchStep(step.id, { approver_user: event.target.value })}>
                            {approvers.map((person) => <option key={person} value={person}>{person}</option>)}
                          </select>
                        </label>
                      )}
                      {step.approver_role && (
                        <label>Role
                          <select value={step.approver_role} onChange={(event) => patchStep(step.id, { approver_role: event.target.value })}>
                            {roles.map((item) => <option key={item} value={item}>{item}</option>)}
                          </select>
                        </label>
                      )}
                      {step.approver_field && (
                        <label>Approver field
                          <select value={step.approver_field} onChange={(event) => patchStep(step.id, { approver_field: event.target.value })}>
                            {template.fields.filter((field) => field.type === "approver-picker").map((field) => <option key={field.key} value={field.key}>{field.label}</option>)}
                          </select>
                        </label>
                      )}
                      <label>Stage order<input type="number" min="1" value={step.order} onChange={(event) => patchStep(step.id, { order: Number(event.target.value) })} /></label>
                    </div>
                  </article>
                ))}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="schema-preview">
        <p className="eyebrow">Generated JSON schema</p>
        <pre>{JSON.stringify(cleanTemplate(template), null, 2)}</pre>
      </section>
    </section>
  );
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "field";
}

function optionLines(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => ({ value: slugify(line), label: line }));
}

function csv(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeField(field: WorkflowField): WorkflowField {
  if (field.type === "dropdown" && (!field.options || field.options.length === 0)) {
    return { ...field, options: [{ value: "option_1", label: "Option 1" }] };
  }
  if (field.type !== "dropdown") {
    const { options: _options, ...rest } = field;
    return rest;
  }
  return field;
}

function normalizeStep(step: ApprovalStep): ApprovalStep {
  const sources = [step.approver_user, step.approver_role, step.approver_field].filter(Boolean);
  if (sources.length === 1) return step;
  return { id: step.id, name: step.name, order: step.order, approver_user: approvers[0] };
}

function resetStepAssignment(step: ApprovalStep, assignment: string): Partial<ApprovalStep> {
  const base = { approver_field: undefined, approver_role: undefined, approver_user: undefined };
  if (assignment === "role") return { ...base, approver_role: roles[0] };
  if (assignment === "field") return { ...base, approver_field: "manager_approver" };
  return { ...base, approver_user: approvers[0] };
}

function renumberSteps(steps: ApprovalStep[]) {
  const orders = [...new Set(steps.map((step) => Math.max(1, step.order)))].sort((a, b) => a - b);
  const orderMap = new Map(orders.map((order, index) => [order, index + 1]));
  return steps.map((step) => ({ ...step, order: orderMap.get(step.order) ?? step.order })).sort((a, b) => a.order - b.order);
}

function approvalGroups(steps: ApprovalStep[]) {
  const groups = new Map<number, ApprovalStep[]>();
  for (const step of renumberSteps(steps)) {
    groups.set(step.order, [...(groups.get(step.order) ?? []), step]);
  }
  return [...groups.entries()];
}

function cleanTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return {
    key: template.key,
    name: template.name,
    version: template.version,
    description: template.description,
    fields: template.fields.map(normalizeField),
    rules: template.rules ?? [],
    approval_steps: renumberSteps(template.approval_steps).map(normalizeStep),
  };
}

async function saveTemplate(template: WorkflowTemplate, liveTemplateId: string | undefined, actor: string) {
  const response = await fetch(`${apiBaseUrl}/api/templates${liveTemplateId ? `/${liveTemplateId}` : ""}`, {
    method: liveTemplateId ? "PUT" : "POST",
    headers: { ...authHeaders("admin", actor), "Content-Type": "application/json" },
    body: JSON.stringify(cleanTemplate(template)),
  });
  if (!response.ok) return null;
  return response.json() as Promise<TemplateRecord>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
