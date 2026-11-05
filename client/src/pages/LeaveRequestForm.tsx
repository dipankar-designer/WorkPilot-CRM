// "Applying for leave": leave type, from/to dates with sessions (first or second half of the day),
// who the request goes to, people to keep informed, contact details, reason and supporting
// documents. The panel on the right shows the live balance and how many days the request is
// for, calculated by the server with the same rules as the real request.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Paperclip, Plus, X } from 'lucide-react';
import { LEAVE_ATTACHMENT_TYPES, type FileDTO, type LeaveApproverDTO, type LeavePreviewDTO, type LeaveRequestDTO, type LeaveSession, type LeaveTypeDTO, type PersonRef } from '@workpilot/shared';
import { asApiError, get, post, upload, type ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';
import { focusFirstInvalid, useSubmit } from '../lib/forms';
import { useAuthed } from '../lib/session';
import { describeWorkingDays, formatBytes } from '../lib/format';
import { Button, Card, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { Avatar } from '../components/bits';
import { useToast } from '../components/Toasts';

const REASON_LABEL: Record<LeaveApproverDTO['reason'], string> = { manager: 'Reporting manager', department_head: 'Department head', hr: 'HR / approver' };
const MAX_FILE_MB = 10;

interface Values {
  leaveTypeId: string;
  startDate: string;
  startSession: LeaveSession;
  endDate: string;
  endSession: LeaveSession;
  approverId: string;
  cc: PersonRef[];
  contactDetails: string;
  reason: string;
}

const EMPTY: Values = { leaveTypeId: '', startDate: '', startSession: 1, endDate: '', endSession: 2, approverId: '', cc: [], contactDetails: '', reason: '' };

export function LeaveRequestForm({ onCreated, balanceVersion = 0 }: { onCreated: () => void; balanceVersion?: number }) {
  const session = useAuthed();
  const notify = useToast();
  const types = useApi<LeaveTypeDTO[]>('/hr/leave-types');
  const approvers = useApi<LeaveApproverDTO[]>('/leave/approvers');
  const colleagues = useApi<PersonRef[]>('/chat/people');
  const [v, setV] = useState<Values>(EMPTY);
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [addingCc, setAddingCc] = useState(false);
  const [preview, setPreview] = useState<LeavePreviewDTO | null>(null);
  const [previewError, setPreviewError] = useState<ApiError | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = useSubmit();
  const set = <K extends keyof Values>(k: K, val: Values[K]) => setV((x) => ({ ...x, [k]: val }));

  // Default "applying to": the reporting manager, otherwise the first approver.
  useEffect(() => {
    if (approvers.data?.length && !v.approverId) set('approverId', approvers.data[0]!.id);
  }, [approvers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // A single-day request usually ends the same day: keep "to date" in step with "from date".
  const setStart = (d: string) => setV((x) => ({ ...x, startDate: d, endDate: !x.endDate || x.endDate < d ? d : x.endDate }));

  // Live preview of the days and balance (debounced).
  useEffect(() => {
    if (!v.startDate || !v.endDate) return setPreview(null);
    const ctrl = new AbortController();
    const t = window.setTimeout(async () => {
      const q = new URLSearchParams({ startDate: v.startDate, startSession: String(v.startSession), endDate: v.endDate, endSession: String(v.endSession), ...(v.leaveTypeId ? { leaveTypeId: v.leaveTypeId } : {}) });
      try {
        setPreview(await get<LeavePreviewDTO>(`/leave/preview?${q}`, ctrl.signal));
        setPreviewError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setPreviewError(asApiError(e));
      }
    }, 250);
    return () => {
      ctrl.abort();
      window.clearTimeout(t);
    };
  }, [v.startDate, v.startSession, v.endDate, v.endSession, v.leaveTypeId, balanceVersion]);

  const addFiles = (list: FileList | null) => {
    setFileError(null);
    const chosen = Array.from(list ?? []);
    for (const f of chosen) {
      const ext = f.name.toLowerCase().split('.').pop() ?? '';
      if (!(LEAVE_ATTACHMENT_TYPES as readonly string[]).includes(ext)) return setFileError(`${f.name} is not an allowed file type.`);
      if (f.size > MAX_FILE_MB * 1024 * 1024) return setFileError(`${f.name} is larger than ${MAX_FILE_MB} MB.`);
    }
    setFiles((cur) => [...cur, ...chosen].slice(0, 5));
  };

  const reset = () => {
    setV({ ...EMPTY, approverId: approvers.data?.[0]?.id ?? '' });
    setFiles([]);
    setFileError(null);
    setPreview(null);
    s.reset();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problems: Record<string, string> = {};
    if (!v.leaveTypeId) problems.leaveTypeId = 'Choose a leave type.';
    if (!v.startDate) problems.startDate = 'Choose the from date.';
    if (!v.endDate) problems.endDate = 'Choose the to date.';
    if (Object.keys(problems).length) {
      s.fail(problems);
      return focusFirstInvalid(form.current);
    }
    const created = await s.run(() =>
      post<LeaveRequestDTO>('/leave/requests', {
        leaveTypeId: v.leaveTypeId,
        startDate: v.startDate,
        startSession: v.startSession,
        endDate: v.endDate,
        endSession: v.endSession,
        approverId: v.approverId || null,
        ccUserIds: v.cc.map((p) => p.id),
        contactDetails: v.contactDetails || null,
        reason: v.reason || null,
      }),
    );
    if (!created) return focusFirstInvalid(form.current);
    // Documents are attached after the request exists; a failed upload is reported, not hidden.
    const failed: string[] = [];
    const attached: FileDTO[] = [];
    for (const f of files) {
      try {
        attached.push(await upload<FileDTO>(`/files/upload?leaveRequestId=${created.id}`, f));
      } catch (err) {
        failed.push(`${f.name}: ${asApiError(err).userMessage}`);
      }
    }
    notify(`Requested ${created.days} day(s) of ${created.leaveType.name}${created.approver ? ` — sent to ${created.approver.name}` : ''}`);
    reset();
    if (failed.length) setFileError(`Your request was sent, but these files could not be attached: ${failed.join('; ')}`);
    onCreated();
  };

  const ccCandidates = (colleagues.data ?? []).filter((p) => !v.cc.some((c) => c.id === p.id) && p.id !== v.approverId);
  const approver = approvers.data?.find((a) => a.id === v.approverId);
  const type = types.data?.find((t) => t.id === v.leaveTypeId);

  return (
    <Card title="Applying for leave">
      <div className="leave-layout">
        <form ref={form} className="form leave-form" onSubmit={submit} noValidate>
          {s.error && <ErrorPanel error={s.error} operation="Applying for leave" />}
          <SelectField label="Leave type" required value={v.leaveTypeId} onChange={(e) => set('leaveTypeId', e.target.value)} error={s.fields.leaveTypeId} className="leave-narrow">
            <option value="">Select type</option>
            {(types.data ?? [])
              .filter((t) => !t.archived)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </SelectField>

          <div className="leave-date-row">
            <TextField label="From date" type="date" required value={v.startDate} onChange={(e) => setStart(e.target.value)} error={s.fields.startDate} />
            <SelectField
              label={
                <>
                  Session<span className="sr-only"> for the from date</span>
                </>
              }
              value={String(v.startSession)}
              onChange={(e) => set('startSession', Number(e.target.value) as LeaveSession)}
            >
              <option value="1">Session 1 (from the start of the day)</option>
              <option value="2">Session 2 (from the second half)</option>
            </SelectField>
          </div>
          <div className="leave-date-row">
            <TextField label="To date" type="date" required value={v.endDate} min={v.startDate || undefined} onChange={(e) => set('endDate', e.target.value)} error={s.fields.endDate} />
            <SelectField
              label={
                <>
                  Session<span className="sr-only"> for the to date</span>
                </>
              }
              value={String(v.endSession)}
              onChange={(e) => set('endSession', Number(e.target.value) as LeaveSession)}
            >
              <option value="1">Session 1 (until the first half)</option>
              <option value="2">Session 2 (until the end of the day)</option>
            </SelectField>
          </div>

          <div className="leave-approver">
            <Avatar name={approver?.name ?? '?'} />
            <SelectField label="Applying to" value={v.approverId} onChange={(e) => set('approverId', e.target.value)} error={s.fields.approverId} hint={approver ? REASON_LABEL[approver.reason] : approvers.data && !approvers.data.length ? 'Nobody can approve leave yet. Ask an owner to set up HR or a reporting manager.' : undefined}>
              {!approvers.data?.length && <option value="">No approver available</option>}
              {(approvers.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {REASON_LABEL[a.reason]}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="field">
            <span className="field-label" id="cc-label">
              CC to
            </span>
            <ul className="cc-list" aria-labelledby="cc-label">
              {v.cc.map((p) => (
                <li key={p.id} className="cc-chip">
                  <Avatar name={p.name} size="sm" />
                  {p.name}
                  <button type="button" className="icon-btn icon-btn-sm" aria-label={`Remove ${p.name} from CC`} onClick={() => set('cc', v.cc.filter((c) => c.id !== p.id))}>
                    <X className="icon" aria-hidden />
                  </button>
                </li>
              ))}
              <li>
                {addingCc ? (
                  <span className="cc-add">
                    <label htmlFor="cc-person" className="sr-only">
                      Person to CC
                    </label>
                    <select
                      id="cc-person"
                      className="input select input-sm"
                      autoFocus
                      value=""
                      onChange={(e) => {
                        const p = ccCandidates.find((c) => c.id === e.target.value);
                        if (p) set('cc', [...v.cc, p]);
                        setAddingCc(false);
                      }}
                      onBlur={() => setAddingCc(false)}
                    >
                      <option value="">Choose a colleague…</option>
                      {ccCandidates.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </span>
                ) : (
                  <button type="button" className="cc-add-btn" onClick={() => setAddingCc(true)} disabled={!ccCandidates.length}>
                    <span className="cc-add-icon" aria-hidden>
                      <Plus className="icon" />
                    </span>
                    Add
                  </button>
                )}
              </li>
            </ul>
            <p className="field-hint">People in CC are notified and can see this request.</p>
          </div>

          <TextField label="Contact details" value={v.contactDetails} onChange={(e) => set('contactDetails', e.target.value)} error={s.fields.contactDetails} hint="How to reach you while you are away (optional)." maxLength={200} className="leave-narrow" />

          <div className="field">
            <label htmlFor="leave-reason" className="field-label">
              Reason
            </label>
            <textarea id="leave-reason" className="input textarea" rows={3} placeholder="Enter a reason" value={v.reason} maxLength={1000} onChange={(e) => set('reason', e.target.value)} />
          </div>

          <div className="leave-attach">
            <input ref={fileInput} type="file" hidden multiple accept={LEAVE_ATTACHMENT_TYPES.map((t) => `.${t}`).join(',')} onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
            <Button variant="ghost" size="sm" icon={<Paperclip className="icon" aria-hidden />} onClick={() => fileInput.current?.click()}>
              Attach file
            </Button>
            <span className="muted small">File types: {LEAVE_ATTACHMENT_TYPES.join(', ')} · up to {MAX_FILE_MB} MB</span>
          </div>
          {files.length > 0 && (
            <ul className="pending-files" aria-label="Files to attach">
              {files.map((f, i) => (
                <li key={i}>
                  {f.name} ({formatBytes(f.size)}){' '}
                  <button type="button" className="link-button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fileError && (
            <p className="field-error" role="alert">
              {fileError}
            </p>
          )}

          <div className="form-actions form-actions-start">
            <Button type="submit" loading={s.busy} disabled={!!preview?.problem}>
              Apply
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>

        <aside className="leave-summary" aria-label="Leave summary" aria-live="polite">
          <dl>
            <div>
              <dt>Leave balance</dt>
              <dd>
                {!type ? (
                  <span className="muted">Choose a leave type</span>
                ) : preview?.balance ? (
                  type.paid ? (
                    <>
                      <strong>{preview.balance.remaining}</strong> of {preview.balance.allowance} day(s) left
                      {preview.balance.pending > 0 && <span className="row-sub">{preview.balance.pending} day(s) awaiting approval</span>}
                    </>
                  ) : (
                    <>Unpaid · {preview.balance.taken} day(s) taken</>
                  )
                ) : (
                  <span className="muted">Choose the dates</span>
                )}
              </dd>
            </div>
            <div>
              <dt>Applying for</dt>
              <dd>{preview ? preview.problem ? <span className="text-danger">{preview.problem}</span> : <strong>{preview.days} day(s)</strong> : <span className="muted">—</span>}</dd>
            </div>
          </dl>
          {type?.paid && preview?.balance && !preview.problem && preview.days > preview.balance.remaining && <p className="notice notice-warning">This is more than your remaining {type.name}.</p>}
          {previewError && <ErrorPanel error={previewError} operation="Calculating the days" />}
          <p className="muted small">Counts your organisation’s working days ({describeWorkingDays(session.org!.workingDays)}), minus holidays. Session 1 is the first half of a day, session 2 the second.</p>
        </aside>
      </div>
    </Card>
  );
}
