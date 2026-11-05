import { useState } from 'react';
import { ScrollText } from 'lucide-react';
import type { AuditEntryDTO, Page } from '@workpilot/shared';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { formatDateTime } from '../../lib/format';
import { Button, Card, EmptyState, Loading, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';

const LIMIT = 25;

/** A local calendar date in the organisation's timezone, as a UTC instant at its start. */
function dayStartUtc(day: string, timeZone: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  // Offset of the timezone at that moment, from the formatted wall-clock time.
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (wall - guess)).toISOString();
}

export function AuditLog() {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const params = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
  if (action) params.set('action', action);
  if (from) params.set('from', dayStartUtc(from, tz));
  if (to) {
    const next = new Date(`${to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    params.set('to', dayStartUtc(next.toISOString().slice(0, 10), tz));
  }
  const { data, error, loading, reload } = useApi<Page<AuditEntryDTO>>(`/org/audit?${params}`);
  const change = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <Card title="Audit log">
      <p className="muted">Every change to the organisation, its members, roles and invitations. Entries cannot be edited or deleted. Dates use {tz.replace(/_/g, ' ')}.</p>
      <div className="filters">
        <SelectField label="Type" value={action} onChange={(e) => change(() => setAction(e.target.value))}>
          <option value="">All changes</option>
          <option value="org">Organisation</option>
          <option value="member">Members and roles</option>
          <option value="invitation">Invitations</option>
        </SelectField>
        <TextField label="From" type="date" value={from} onChange={(e) => change(() => setFrom(e.target.value))} />
        <TextField label="To" type="date" value={to} onChange={(e) => change(() => setTo(e.target.value))} />
      </div>
      {loading && <Loading label="Loading the audit log…" />}
      {error && <ErrorPanel error={error} operation="Loading the audit log" onRetry={reload} />}
      {data && data.items.length === 0 && <EmptyState icon={<ScrollText />} title="No entries match these filters" />}
      {data && data.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Audit log entries</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What happened</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <tr key={a.id}>
                    <td className="nowrap">
                      <time dateTime={a.createdAt}>{formatDateTime(a.createdAt, tz)}</time>
                    </td>
                    <td>{a.actorName ?? 'System'}</td>
                    <td>{a.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Audit log pages">
            <span className="muted small">
              {data.offset + 1}–{data.offset + data.items.length} of {data.total}
            </span>
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
              Previous
            </Button>
            <Button size="sm" variant="secondary" disabled={offset + LIMIT >= data.total} onClick={() => setOffset(offset + LIMIT)}>
              Next
            </Button>
          </nav>
        </>
      )}
    </Card>
  );
}
