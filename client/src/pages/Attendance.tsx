import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CalendarCheck, LogIn, LogOut, Undo2 } from 'lucide-react';
import type { AttendanceDTO, AttendanceTodayDTO, EmployeeDTO, LeaveBalanceDTO, LeaveRequestDTO } from '@workpilot/shared';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { useNow } from '../lib/hooks';
import { useRealtimeEvent } from '../lib/realtime';
import { addDays, formatDay, formatTime, hm, todayIn } from '../lib/format';
import { Badge, Button, Card, Dialog, EmptyState, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { useToast } from '../components/Toasts';
import { FileChip } from './projects/Files';
import { LeaveRequestForm } from './LeaveRequestForm';

type Tab = 'today' | 'leave' | 'approvals' | 'team';
const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const;
/** A request its owner cancelled is shown as "withdrawn". */
const STATUS_LABEL = { pending: 'pending', approved: 'approved', rejected: 'rejected', cancelled: 'withdrawn' } as const;

export function Attendance() {
  const session = useAuthed();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'today';
  const tabs: { key: Tab; label: string }[] = [
    { key: 'today', label: 'Attendance' },
    { key: 'leave', label: 'My leave' },
    { key: 'approvals', label: 'Leave approvals' },
    { key: 'team', label: 'Team attendance' },
  ];
  return (
    <div className="page">
      <PageHeader title="Attendance & Leave" description={`Check in and out, request leave and approve requests. Days follow ${session.org!.timezone.replace(/_/g, ' ')}.`} />
      <div className="tabs" role="tablist" aria-label="Attendance and leave sections">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" id={`tab-${t.key}`} aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} className={tab === t.key ? 'tab tab-active' : 'tab'} onClick={() => setParams({ tab: t.key })}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'today' && <Today />}
        {tab === 'leave' && <MyLeave />}
        {tab === 'approvals' && <Approvals />}
        {tab === 'team' && <TeamAttendance />}
      </div>
    </div>
  );
}

function Today() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const notify = useToast();
  const today = useApi<AttendanceTodayDTO>('/attendance/today');
  const from = addDays(todayIn(tz), -13);
  const history = useApi<AttendanceDTO[]>(`/attendance?from=${from}&to=${todayIn(tz)}`);
  const s = useSubmit();
  const now = useNow(30_000);
  const t = today.data;
  const rec = t?.record;
  const working = rec && !rec.checkOutAt ? (now - Date.parse(rec.checkInAt)) / 1000 : (rec?.seconds ?? 0);

  const act = async (path: 'check-in' | 'check-out') => {
    const r = await s.run(() => post<AttendanceTodayDTO>(`/attendance/${path}`, {}));
    if (r) {
      today.setData(r);
      history.reload();
      notify(path === 'check-in' ? 'Checked in' : 'Checked out');
    }
  };

  return (
    <div className="grid-2">
      <Card title={t ? `Today, ${formatDay(t.workDate, { weekday: 'long', day: 'numeric', month: 'long' })}` : 'Today'}>
        {today.loading && !t && <Loading />}
        {today.error && <ErrorPanel error={today.error} onRetry={today.reload} />}
        {s.error && <ErrorPanel error={s.error} />}
        {t && (
          <div className="stack">
            {t.holiday && <p className="notice notice-info">Today is a holiday: {t.holiday}.</p>}
            {t.onLeave && <p className="notice notice-info">You are on approved leave today.</p>}
            {!rec && <p>You have not checked in yet.</p>}
            {rec && (
              <dl className="facts">
                <div>
                  <dt>Checked in</dt>
                  <dd>{formatTime(rec.checkInAt, tz)}</dd>
                </div>
                <div>
                  <dt>Checked out</dt>
                  <dd>{rec.checkOutAt ? formatTime(rec.checkOutAt, tz) : 'Not yet'}</dd>
                </div>
                <div>
                  <dt>{rec.checkOutAt ? 'Time on site' : 'So far'}</dt>
                  <dd>{hm(working)} h</dd>
                </div>
              </dl>
            )}
            <div className="form-actions form-actions-start">
              {!rec && (
                <Button icon={<LogIn className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('check-in')}>
                  Check in
                </Button>
              )}
              {rec && !rec.checkOutAt && (
                <Button icon={<LogOut className="icon" aria-hidden />} loading={s.busy} onClick={() => void act('check-out')}>
                  Check out
                </Button>
              )}
              {rec?.checkOutAt && <p className="muted">You have finished for today.</p>}
            </div>
            <p className="muted small">Times are recorded by the server clock. Ask HR if a record needs correcting.</p>
          </div>
        )}
      </Card>
      <Card title="Last 14 days">
        {history.error && <ErrorPanel error={history.error} onRetry={history.reload} />}
        {history.data && history.data.length === 0 && <EmptyState icon={<CalendarCheck />} title="No attendance recorded yet" />}
        {history.data && history.data.length > 0 && <AttendanceTable rows={history.data} />}
      </Card>
    </div>
  );
}

function AttendanceTable({ rows, showPerson, onEdit }: { rows: AttendanceDTO[]; showPerson?: boolean; onEdit?: (a: AttendanceDTO) => void }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">Attendance records</caption>
        <thead>
          <tr>
            {showPerson && <th scope="col">Person</th>}
            <th scope="col">Day</th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col">Hours</th>
            {onEdit && (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              {showPerson && <td>{a.user.name}</td>}
              <td className="nowrap">
                {formatDay(a.workDate, { weekday: 'short', day: 'numeric', month: 'short' })}
                {a.corrected && <span className="row-sub">Corrected by HR</span>}
              </td>
              <td>{formatTime(a.checkInAt, tz)}</td>
              <td>{a.checkOutAt ? formatTime(a.checkOutAt, tz) : <span className="muted">—</span>}</td>
              <td>{a.seconds !== null ? hm(a.seconds) : '—'}</td>
              {onEdit && (
                <td className="cell-actions">
                  <Button size="sm" variant="ghost" onClick={() => onEdit(a)} aria-label={`Correct ${a.user.name}’s attendance on ${a.workDate}`}>
                    Correct
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Mon 2 Nov (second half) – Wed 4 Nov (first half)": the period with any half days spelt out. */
function leavePeriod(r: LeaveRequestDTO) {
  const opts = { weekday: 'short', day: 'numeric', month: 'short' } as const;
  if (r.startDate === r.endDate) {
    const half = r.startSession === r.endSession ? (r.startSession === 1 ? ' (first half)' : ' (second half)') : '';
    return `${formatDay(r.startDate, opts)}${half}`;
  }
  return `${formatDay(r.startDate, opts)}${r.startSession === 2 ? ' (second half)' : ''} – ${formatDay(r.endDate, opts)}${r.endSession === 1 ? ' (first half)' : ''}`;
}

/** Who the request went to, who was copied in, how to reach the person, and their documents. */
function LeaveDetails({ r }: { r: LeaveRequestDTO }) {
  return (
    <>
      {(r.approver || r.cc.length > 0) && (
        <span className="row-sub">
          {r.approver && `Applied to ${r.approver.name}`}
          {r.approver && r.cc.length > 0 && ' · '}
          {r.cc.length > 0 && `CC ${r.cc.map((p) => p.name).join(', ')}`}
        </span>
      )}
      {r.contactDetails && <span className="row-sub">Contact: {r.contactDetails}</span>}
      {r.files.length > 0 && (
        <span className="file-chips" aria-label="Attachments">
          {r.files.map((f) => (
            <FileChip key={f.id} file={f} />
          ))}
        </span>
      )}
    </>
  );
}

function MyLeave() {
  const balances = useApi<{ year: number; balances: LeaveBalanceDTO[] }>('/leave/balances');
  const requests = useApi<LeaveRequestDTO[]>('/leave/requests?scope=mine');
  useRealtimeEvent((e) => e.type === 'notification', () => refresh());
  const row = useSubmit();
  const notify = useToast();
  const [withdrawing, setWithdrawing] = useState<LeaveRequestDTO | null>(null);
  const isPaid = (r: LeaveRequestDTO) => balances.data?.balances.find((b) => b.leaveType.id === r.leaveType.id)?.leaveType.paid ?? true;
  // Bumped whenever the balance changes, so the application form's balance panel refreshes too.
  const [balanceVersion, setBalanceVersion] = useState(0);
  const refresh = () => (requests.reload(), balances.reload(), setBalanceVersion((n) => n + 1));
  const withdraw = async (r: LeaveRequestDTO) => {
    if (!(await row.run(() => post(`/leave/requests/${r.id}/cancel`)))) return;
    setWithdrawing(null);
    notify(isPaid(r) ? `Leave withdrawn — ${r.days} day(s) returned to your ${r.leaveType.name} balance` : 'Leave withdrawn');
    refresh();
  };
  return (
    <div className="stack-lg">
      <LeaveRequestForm onCreated={refresh} balanceVersion={balanceVersion} />
      <div className="grid-2">
        <Card title={`Balances ${balances.data?.year ?? ''}`}>
          {balances.error && <ErrorPanel error={balances.error} onRetry={balances.reload} />}
          <ul className="balances">
            {(balances.data?.balances ?? []).map((b) => (
              <li key={b.leaveType.id}>
                <span className={`label label-${b.leaveType.color}`}>{b.leaveType.name}</span>
                <strong>{b.leaveType.paid ? `${b.remaining} left` : `${b.taken} taken`}</strong>
                <span className="row-sub">
                  {b.leaveType.paid ? `${b.taken} taken of ${b.allowance}` : 'Unpaid'}
                  {b.pending > 0 && ` · ${b.pending} pending`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="My requests">
          {row.error && <ErrorPanel error={row.error} />}
          {requests.error && <ErrorPanel error={requests.error} onRetry={requests.reload} />}
          {requests.data && requests.data.length === 0 && <EmptyState icon={<CalendarCheck />} title="No leave requested yet" />}
          <ul className="list">
            {(requests.data ?? []).map((r) => (
              <li key={r.id} className="list-item">
                <div className="list-item-main">
                  <span className="person-name">
                    {r.leaveType.name} · {r.days} day(s)
                  </span>
                  <span className="row-sub">{leavePeriod(r)}</span>
                  <LeaveDetails r={r} />
                  {r.decisionNote && <span className="row-sub">Note: {r.decisionNote}</span>}
                </div>
                <div className="row-actions">
                  <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
                  {r.canCancel && (
                    <Button size="sm" variant="secondary" icon={<Undo2 className="icon" aria-hidden />} onClick={() => (row.reset(), setWithdrawing(r))} aria-label={`Withdraw ${r.leaveType.name} for ${leavePeriod(r)}`}>
                      Withdraw
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {withdrawing && (
        <Dialog
          open
          onClose={() => setWithdrawing(null)}
          title={`Withdraw your ${withdrawing.leaveType.name}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setWithdrawing(null)}>
                Keep it
              </Button>
              <Button variant="danger" loading={row.busy} onClick={() => void withdraw(withdrawing)}>
                Withdraw
              </Button>
            </>
          }
        >
          {row.error && <ErrorPanel error={row.error} operation="Withdrawing leave" />}
          <p>
            {leavePeriod(withdrawing)} ({withdrawing.days} day(s)){withdrawing.status === 'approved' ? ', already approved' : ', waiting for approval'}.
          </p>
          <p>
            {isPaid(withdrawing) ? `The ${withdrawing.days} day(s) go straight back to your ${withdrawing.leaveType.name} balance.` : 'This is unpaid leave, so no balance changes.'}
            {(withdrawing.approver || withdrawing.decidedBy) && ` ${(withdrawing.decidedBy ?? withdrawing.approver)!.name} will be told.`}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function Approvals() {
  const notify = useToast();
  const [status, setStatus] = useState('pending');
  const requests = useApi<LeaveRequestDTO[]>(`/leave/requests?scope=approvals&status=${status}`);
  useRealtimeEvent((e) => e.type === 'notification', requests.reload);
  const [deciding, setDeciding] = useState<{ r: LeaveRequestDTO; action: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const s = useSubmit();
  return (
    <Card title="Leave requests to decide" actions={<SelectField label="Show" value={status} onChange={(e) => setStatus(e.target.value)}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="all">All</option></SelectField>}>
      <p className="muted small">You see requests from people you can approve: everyone if you are HR or an owner, otherwise the people who report to you.</p>
      {requests.error && <ErrorPanel error={requests.error} onRetry={requests.reload} />}
      {requests.data && requests.data.length === 0 && <EmptyState icon={<CalendarCheck />} title={status === 'pending' ? 'Nothing waiting for a decision' : 'No requests'} />}
      <ul className="list">
        {(requests.data ?? []).map((r) => (
          <li key={r.id} className="list-item">
            <div className="list-item-main">
              <span className="person-name">
                {r.user.name} · {r.leaveType.name} · {r.days} day(s)
              </span>
              <span className="row-sub">
                {leavePeriod(r)}
                {r.reason && ` · “${r.reason}”`}
              </span>
              <LeaveDetails r={r} />
              {r.decidedBy && (
                <span className="row-sub">
                  {r.status === 'cancelled' ? `Approved by ${r.decidedBy.name}, then withdrawn by ${r.user.name}` : `${r.status} by ${r.decidedBy.name}`}
                  {r.decisionNote && `: ${r.decisionNote}`}
                </span>
              )}
            </div>
            <div className="row-actions">
              {r.canDecide ? (
                <>
                  <Button size="sm" variant="secondary" onClick={() => (setDeciding({ r, action: 'reject' }), setNote(''))}>
                    Reject
                  </Button>
                  <Button size="sm" onClick={() => (setDeciding({ r, action: 'approve' }), setNote(''))}>
                    Approve
                  </Button>
                </>
              ) : (
                <Badge tone={STATUS_TONE[r.status]}>{STATUS_LABEL[r.status]}</Badge>
              )}
            </div>
          </li>
        ))}
      </ul>
      {deciding && (
        <Dialog
          open
          onClose={() => setDeciding(null)}
          title={`${deciding.action === 'approve' ? 'Approve' : 'Reject'} ${deciding.r.user.name}’s ${deciding.r.leaveType.name}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeciding(null)}>
                Cancel
              </Button>
              <Button
                variant={deciding.action === 'approve' ? 'primary' : 'danger'}
                loading={s.busy}
                onClick={async () => {
                  if (deciding.action === 'reject' && !note.trim()) return s.fail({ note: 'Give a reason for rejecting.' });
                  if (await s.run(() => post(`/leave/requests/${deciding.r.id}/${deciding.action}`, { note: note || undefined }))) {
                    notify(`Leave ${deciding.action === 'approve' ? 'approved' : 'rejected'}`);
                    setDeciding(null);
                    requests.reload();
                  }
                }}
              >
                {deciding.action === 'approve' ? 'Approve' : 'Reject'}
              </Button>
            </>
          }
        >
          {s.error && !s.fields.note && <ErrorPanel error={s.error} />}
          <p>
            {leavePeriod(deciding.r)} ({deciding.r.days} working day(s)).
          </p>
          <TextField label={deciding.action === 'reject' ? 'Reason (required)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} error={s.fields.note} />
        </Dialog>
      )}
    </Card>
  );
}

function TeamAttendance() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const notify = useToast();
  const [from, setFrom] = useState(addDays(todayIn(tz), -6));
  const [to, setTo] = useState(todayIn(tz));
  const rows = useApi<AttendanceDTO[]>(`/attendance?scope=team&from=${from}&to=${to}`);
  const canEdit = session.can('hr.manage');
  const people = useApi<EmployeeDTO[]>(canEdit ? '/hr/employees' : null);
  const [editing, setEditing] = useState<AttendanceDTO | null>(null);
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState({ userId: '', date: todayIn(tz), checkIn: '09:00', checkOut: '', note: '' });
  const s = useSubmit();
  return (
    <div className="stack-lg">
      <div className="filters">
        <TextField label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <TextField label="To" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        {canEdit && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a missed day
          </Button>
        )}
      </div>
      <Card title="Team attendance">
        <p className="muted small">HR sees everyone; managers see their reports; everyone else sees only their own days.</p>
        {rows.error && <ErrorPanel error={rows.error} onRetry={rows.reload} />}
        {rows.data && rows.data.length === 0 && <EmptyState icon={<CalendarCheck />} title="No attendance in this period" />}
        {rows.data && rows.data.length > 0 && <AttendanceTable rows={rows.data} showPerson onEdit={canEdit ? setEditing : undefined} />}
      </Card>
      {editing && (
        <Dialog open onClose={() => setEditing(null)} title={`Correct ${editing.user.name} · ${formatDay(editing.workDate)}`}>
          <CorrectionForm a={editing} onDone={() => (setEditing(null), rows.reload(), notify('Attendance corrected'))} />
        </Dialog>
      )}
      {adding && (
        <Dialog open onClose={() => setAdding(false)} title="Add attendance for a missed day">
          <form
            className="form"
            noValidate
            onSubmit={async (e) => {
              e.preventDefault();
              if (await s.run(() => post('/attendance', { ...v, checkOut: v.checkOut || undefined, note: v.note || null }))) {
                setAdding(false);
                rows.reload();
                notify('Attendance added');
              }
            }}
          >
            {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
            <SelectField label="Person" value={v.userId} onChange={(e) => setV({ ...v, userId: e.target.value })} error={s.fields.userId}>
              <option value="">Choose…</option>
              {(people.data ?? []).map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <div className="form-grid form-grid-3">
              <TextField label="Date" type="date" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} />
              <TextField label="In" type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} />
              <TextField label="Out" type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} error={s.fields.checkOut} />
            </div>
            <TextField label="Note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
            <div className="form-actions">
              <Button type="submit" loading={s.busy}>
                Add
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}

function CorrectionForm({ a, onDone }: { a: AttendanceDTO; onDone: () => void }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(new Date(iso));
  const [v, setV] = useState({ checkIn: hhmm(a.checkInAt), checkOut: a.checkOutAt ? hhmm(a.checkOutAt) : '', note: a.note ?? '' });
  const s = useSubmit();
  return (
    <form
      className="form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (await s.run(() => patch(`/attendance/${a.id}`, { checkIn: v.checkIn, checkOut: v.checkOut || null, note: v.note || null }))) onDone();
      }}
    >
      {s.error && <ErrorPanel error={s.error} />}
      <div className="form-grid">
        <TextField label="In" type="time" value={v.checkIn} onChange={(e) => setV({ ...v, checkIn: e.target.value })} />
        <TextField label="Out" type="time" value={v.checkOut} onChange={(e) => setV({ ...v, checkOut: e.target.value })} />
      </div>
      <TextField label="Reason for the correction" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
      <p className="muted small">Corrections are recorded in the audit log.</p>
      <div className="form-actions">
        <Button type="submit" loading={s.busy}>
          Save correction
        </Button>
      </div>
    </form>
  );
}
