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
  order: number;
};

type WorkflowTemplate = {
  id?: string;
  template?: WorkflowTemplate;
  key: string;
  name: string;
  version: number;
  description?: string;
  fields: WorkflowField[];
  rules?: WorkflowRule[];
  approval_steps: ApprovalStep[];
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
      .then((records: WorkflowTemplate[]) => {
        const loaded = records.map((record) => record.template ?? record);
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
            {approvers.map((person) => <option key={person} value={person}>{person}</option>)}
          </select>
        </label>
        <p className="notice">{notice}</p>
      </aside>

      <section className="workspace">
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
    return (
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
      approver: step.approver_field ? String(submission[step.approver_field] ?? "") : step.approver_role,
      status: "pending",
    })),
  };
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
