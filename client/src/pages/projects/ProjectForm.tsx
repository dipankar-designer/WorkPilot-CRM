import { useRef, useState, type FormEvent } from 'react';
import { PRIORITIES, PRIORITY_LABELS, PROJECT_STATUSES, PROJECT_STATUS_LABELS, type ClientDTO, type MemberDTO, type Priority, type ProjectDTO, type ProjectStatus } from '@workpilot/shared';
import { patch, post } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { focusFirstInvalid, useSubmit } from '../../lib/forms';
import { useAuthed } from '../../lib/session';
import { Button, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';

interface Values {
  name: string;
  description: string;
  clientId: string;
  managerId: string;
  status: ProjectStatus;
  priority: Priority;
  startDate: string;
  deadline: string;
  estimatedHours: string;
  budget: string;
  currency: string;
  clientTaskAccess: boolean;
  clientsCanPost: boolean;
  memberIds: string[];
}

const fromProject = (p: ProjectDTO | null, me: string): Values => ({
  name: p?.name ?? '',
  description: p?.description ?? '',
  clientId: p?.client?.id ?? '',
  managerId: p?.manager?.id ?? me,
  status: p?.status ?? 'active',
  priority: p?.priority ?? 'medium',
  startDate: p?.startDate ?? '',
  deadline: p?.deadline ?? '',
  estimatedHours: p?.estimatedHours?.toString() ?? '',
  budget: p?.budget?.toString() ?? '',
  currency: p?.currency ?? 'INR',
  clientTaskAccess: p?.clientTaskAccess ?? false,
  clientsCanPost: p?.clientsCanPost ?? true,
  memberIds: [],
});

/** Create (no project) or edit (with project) form. */
export function ProjectForm({ project, onSaved, onCancel }: { project: ProjectDTO | null; onSaved: (p: ProjectDTO) => void; onCancel?: () => void }) {
  const session = useAuthed();
  const members = useApi<MemberDTO[]>(session.can('members.view') ? '/org/members' : null);
  const clients = useApi<ClientDTO[]>('/clients');
  const [v, setV] = useState<Values>(() => fromProject(project, session.user.id));
  const form = useRef<HTMLFormElement>(null);
  const s = useSubmit();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));
  const internal = (members.data ?? []).filter((m) => !m.roles.includes('client'));
  const showBudget = session.can('finance.view') || project?.canManage !== false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!v.name.trim()) problems.name = 'Enter the project name.';
    if (v.startDate && v.deadline && v.deadline < v.startDate) problems.deadline = 'The deadline cannot be before the start date.';
    const est = v.estimatedHours.trim() === '' ? null : Number(v.estimatedHours);
    const budget = v.budget.trim() === '' ? null : Number(v.budget);
    if (est !== null && (!Number.isFinite(est) || est < 0)) problems.estimatedHours = 'Enter a number of hours.';
    if (budget !== null && (!Number.isFinite(budget) || budget < 0)) problems.budget = 'Enter an amount.';
    if (Object.keys(problems).length) {
      s.fail(problems);
      return focusFirstInvalid(form.current);
    }
    const body = {
      name: v.name,
      description: v.description || null,
      clientId: v.clientId || null,
      managerId: v.managerId || null,
      status: v.status,
      priority: v.priority,
      startDate: v.startDate || null,
      deadline: v.deadline || null,
      estimatedHours: est,
      ...(showBudget ? { budget, currency: v.currency } : {}),
      clientTaskAccess: v.clientTaskAccess,
      clientsCanPost: v.clientsCanPost,
      ...(project ? {} : { memberIds: v.memberIds }),
    };
    const saved = await s.run(() => (project ? patch<ProjectDTO>(`/projects/${project.id}`, body) : post<ProjectDTO>('/projects', body)));
    if (saved) onSaved(saved);
    else focusFirstInvalid(form.current);
  };

  return (
    <form ref={form} onSubmit={submit} noValidate className="form">
      {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
      <TextField label="Project name" required value={v.name} onChange={(e) => set('name', e.target.value)} error={s.fields.name} />
      <div className="field">
        <label htmlFor="project-description" className="field-label">
          Description
        </label>
        <textarea id="project-description" className="input textarea" rows={3} value={v.description} onChange={(e) => set('description', e.target.value)} />
      </div>
      <div className="form-grid">
        <SelectField label="Client" value={v.clientId} onChange={(e) => set('clientId', e.target.value)} hint={clients.data && !clients.data.length ? 'Add clients on the Clients page.' : undefined}>
          <option value="">No client (internal project)</option>
          {(clients.data ?? []).filter((c) => !c.archived || c.id === v.clientId).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </SelectField>
        <SelectField label="Project manager" value={v.managerId} onChange={(e) => set('managerId', e.target.value)} error={s.fields.managerId}>
          {!internal.some((m) => m.userId === v.managerId) && <option value={v.managerId}>{project?.manager?.name ?? session.user.fullName}</option>}
          {internal.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.fullName}
            </option>
          ))}
        </SelectField>
        <SelectField label="Status" value={v.status} onChange={(e) => set('status', e.target.value as ProjectStatus)}>
          {PROJECT_STATUSES.map((st) => (
            <option key={st} value={st}>
              {PROJECT_STATUS_LABELS[st]}
            </option>
          ))}
        </SelectField>
        <SelectField label="Priority" value={v.priority} onChange={(e) => set('priority', e.target.value as Priority)}>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </SelectField>
        <TextField label="Start date" type="date" value={v.startDate} onChange={(e) => set('startDate', e.target.value)} error={s.fields.startDate} />
        <TextField label="Deadline" type="date" value={v.deadline} onChange={(e) => set('deadline', e.target.value)} error={s.fields.deadline} />
        <TextField label="Estimated hours" type="number" min={0} step="0.5" inputMode="decimal" value={v.estimatedHours} onChange={(e) => set('estimatedHours', e.target.value)} error={s.fields.estimatedHours} />
        {showBudget && (
          <div className="budget-row">
            <TextField label="Budget (optional)" type="number" min={0} step="1" inputMode="decimal" value={v.budget} onChange={(e) => set('budget', e.target.value)} error={s.fields.budget} />
            <SelectField label="Currency" value={v.currency} onChange={(e) => set('currency', e.target.value)}>
              {['INR', 'EUR', 'GBP', 'USD', 'AED', 'AUD', 'CAD', 'SGD'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
          </div>
        )}
      </div>
      {!project && internal.length > 1 && (
        <fieldset className="fieldset">
          <legend className="field-label">Team members</legend>
          <div className="check-grid">
            {internal
              .filter((m) => m.userId !== session.user.id && m.userId !== v.managerId)
              .map((m) => (
                <label key={m.userId} className="check">
                  <input
                    type="checkbox"
                    checked={v.memberIds.includes(m.userId)}
                    onChange={(e) => set('memberIds', e.target.checked ? [...v.memberIds, m.userId] : v.memberIds.filter((x) => x !== m.userId))}
                  />
                  {m.fullName}
                </label>
              ))}
          </div>
        </fieldset>
      )}
      <fieldset className="fieldset">
        <legend className="field-label">Client access</legend>
        <label className="check">
          <input type="checkbox" checked={v.clientTaskAccess} onChange={(e) => set('clientTaskAccess', e.target.checked)} />
          Clients can see this project’s tasks and board (read-only)
        </label>
        <label className="check">
          <input type="checkbox" checked={v.clientsCanPost} onChange={(e) => set('clientsCanPost', e.target.checked)} />
          Clients can post and comment in the feed
        </label>
      </fieldset>
      <div className="form-actions">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={s.busy}>
          {project ? 'Save changes' : 'Create project'}
        </Button>
      </div>
    </form>
  );
}
