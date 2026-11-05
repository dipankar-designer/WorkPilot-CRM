import { useDeferredValue, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Briefcase, Plus } from 'lucide-react';
import type { ClientDTO, ProjectDTO } from '@workpilot/shared';
import { patch, post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { Badge, Button, Card, Dialog, EmptyState, Loading, PageHeader, SelectField, TextField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { StatusBadge } from '../components/bits';
import { useToast } from '../components/Toasts';

export function Clients() {
  const session = useAuthed();
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState('false');
  const deferred = useDeferredValue(q.trim());
  const clients = useApi<ClientDTO[]>(`/clients?archived=${archived}${deferred ? `&q=${encodeURIComponent(deferred)}` : ''}`);
  const [editing, setEditing] = useState<ClientDTO | 'new' | null>(null);
  const [open, setOpen] = useState<ClientDTO | null>(null);
  const canManage = session.can('clients.manage');
  return (
    <div className="page">
      <PageHeader
        title="Clients"
        description="The companies you work for, and their projects. Client contacts get access per project from the project’s Members tab."
        actions={
          canManage && (
            <Button icon={<Plus className="icon" aria-hidden />} onClick={() => setEditing('new')}>
              New client
            </Button>
          )
        }
      />
      <Card>
        <div className="filters" role="search">
          <TextField label="Search clients" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          <SelectField label="Show" value={archived} onChange={(e) => setArchived(e.target.value)}>
            <option value="false">Active</option>
            <option value="true">Archived</option>
            <option value="all">All</option>
          </SelectField>
        </div>
        {clients.loading && !clients.data && <Loading />}
        {clients.error && <ErrorPanel error={clients.error} onRetry={clients.reload} />}
        {clients.data && clients.data.length === 0 && (
          <EmptyState icon={<Briefcase />} title={deferred ? 'No clients match' : 'No clients yet'} action={canManage && !deferred ? <Button onClick={() => setEditing('new')}>Add the first client</Button> : undefined}>
            {canManage ? 'Add the companies you work for and link them to projects.' : 'Project managers add clients.'}
          </EmptyState>
        )}
        {clients.data && clients.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Clients</caption>
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Contact</th>
                  <th scope="col">Projects</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {clients.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <button type="button" className="link-button row-title" onClick={() => setOpen(c)}>
                        {c.name}
                      </button>
                      {c.country && <span className="row-sub">{c.country}</span>}
                      {c.archived && <Badge>Archived</Badge>}
                    </td>
                    <td>
                      {c.contactName ?? '—'}
                      {c.email && <span className="row-sub">{c.email}</span>}
                    </td>
                    <td>{c.projectCount}</td>
                    <td className="cell-actions">
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                          Edit
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <ClientForm client={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), clients.reload())} />}
      {open && <ClientProjects client={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ClientForm({ client, onClose, onSaved }: { client: ClientDTO | null; onClose: () => void; onSaved: () => void }) {
  const notify = useToast();
  const [v, setV] = useState({ name: client?.name ?? '', contactName: client?.contactName ?? '', email: client?.email ?? '', phone: client?.phone ?? '', country: client?.country ?? '', notes: client?.notes ?? '' });
  const s = useSubmit();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'name' ? x : x || null]));
    if (await s.run(() => (client ? patch(`/clients/${client.id}`, body) : post('/clients', body)))) {
      notify(client ? 'Client saved' : 'Client added');
      onSaved();
    }
  };
  return (
    <Dialog open onClose={onClose} title={client ? `Edit ${client.name}` : 'New client'}>
      <form className="form" onSubmit={submit} noValidate>
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        <TextField label="Company name" required value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} error={s.fields.name} />
        <div className="form-grid">
          <TextField label="Contact person" value={v.contactName} onChange={(e) => setV({ ...v, contactName: e.target.value })} />
          <TextField label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} error={s.fields.email} />
          <TextField label="Phone" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} />
          <TextField label="Country" value={v.country} onChange={(e) => setV({ ...v, country: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="client-notes" className="field-label">
            Notes
          </label>
          <textarea id="client-notes" className="input textarea" rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
        </div>
        <div className="form-actions">
          {client && (
            <Button
              variant="ghost"
              onClick={async () => {
                if (await s.run(() => patch(`/clients/${client.id}`, { archived: !client.archived }))) {
                  notify(client.archived ? 'Client restored' : 'Client archived');
                  onSaved();
                }
              }}
            >
              {client.archived ? 'Restore' : 'Archive'}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={s.busy}>
            {client ? 'Save' : 'Add client'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ClientProjects({ client, onClose }: { client: ClientDTO; onClose: () => void }) {
  const projects = useApi<ProjectDTO[]>(`/projects?clientId=${client.id}&status=all`);
  return (
    <Dialog open onClose={onClose} title={client.name}>
      {client.notes && <p className="pre-wrap">{client.notes}</p>}
      <h3 className="section-title">Projects</h3>
      {projects.error && <ErrorPanel error={projects.error} />}
      {projects.data && projects.data.length === 0 && <p className="muted">No projects you can see for this client.</p>}
      <ul className="list">
        {(projects.data ?? []).map((p) => (
          <li key={p.id} className="list-item">
            <Link to={`/projects/${p.id}`} className="row-title">
              {p.name}
            </Link>
            <StatusBadge status={p.status} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
