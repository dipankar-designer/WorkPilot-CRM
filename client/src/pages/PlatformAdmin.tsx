import { Building2 } from 'lucide-react';
import type { AdminOrgDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { formatDate } from '../lib/format';
import { useToast } from '../components/Toasts';
import { Badge, Button, Card, EmptyState, Loading, PageHeader } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';

export function PlatformAdmin() {
  const session = useAuthed();
  const orgs = useApi<AdminOrgDTO[]>(session.user.isPlatformAdmin ? '/admin/organizations' : null);
  if (!session.user.isPlatformAdmin) {
    return (
      <div className="page">
        <PageHeader title="Platform admin" />
        <p className="notice notice-warning">Only platform administrators can open this page.</p>
      </div>
    );
  }
  return (
    <div className="page">
      <PageHeader title="Platform admin" description="Organisations on this WorkPilot AI installation. You see names and member counts only, never an organisation’s data." />
      <Card>
        {orgs.loading && <Loading />}
        {orgs.error && <ErrorPanel error={orgs.error} operation="Loading organisations" onRetry={orgs.reload} />}
        {orgs.data && orgs.data.length === 0 && <EmptyState icon={<Building2 />} title="No organisations yet" />}
        {orgs.data && orgs.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Organisations</caption>
              <thead>
                <tr>
                  <th scope="col">Organisation</th>
                  <th scope="col">Active members</th>
                  <th scope="col">Created</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orgs.data.map((o) => (
                  <OrgRow key={o.id} org={o} onChange={orgs.reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function OrgRow({ org, onChange }: { org: AdminOrgDTO; onChange: () => void }) {
  const notify = useToast();
  const s = useSubmit();
  const suspend = org.status === 'active';
  return (
    <tr>
      <td>
        <span className="person-name">{org.name}</span>
        <span className="person-email">{org.slug}</span>
        {s.error && <ErrorPanel error={s.error} />}
      </td>
      <td>{org.activeMembers}</td>
      <td>{formatDate(org.createdAt, 'UTC')}</td>
      <td>{suspend ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Suspended</Badge>}</td>
      <td className="cell-actions">
        <Button
          size="sm"
          variant={suspend ? 'ghost' : 'secondary'}
          loading={s.busy}
          aria-label={`${suspend ? 'Suspend' : 'Reactivate'} ${org.name}`}
          onClick={async () => {
            if (await s.run(() => post(`/admin/organizations/${org.id}/${suspend ? 'suspend' : 'reactivate'}`))) {
              notify(`${org.name} ${suspend ? 'suspended' : 'reactivated'}`);
              onChange();
            }
          }}
        >
          {suspend ? 'Suspend' : 'Reactivate'}
        </Button>
      </td>
    </tr>
  );
}
