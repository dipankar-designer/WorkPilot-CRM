import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Bell } from 'lucide-react';
import type { NotificationDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useRealtimeEvent } from '../lib/realtime';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Card, EmptyState, Loading, PageHeader, SelectField, cx } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';

export function Notifications() {
  const session = useAuthed();
  const navigate = useNavigate();
  const [unread, setUnread] = useState('false');
  const list = useApi<{ items: NotificationDTO[]; unread: number }>(`/notifications?limit=100&unread=${unread}`);
  useRealtimeEvent((e) => e.type === 'notification', list.reload);
  return (
    <div className="page">
      <PageHeader
        title="Notifications"
        description="Mentions, replies, assignments, approvals and messages."
        actions={
          (list.data?.unread ?? 0) > 0 && (
            <Button variant="secondary" onClick={async () => (await post('/notifications/read-all').catch(() => undefined), list.reload())}>
              Mark all as read
            </Button>
          )
        }
      />
      <Card>
        <div className="filters">
          <SelectField label="Show" value={unread} onChange={(e) => setUnread(e.target.value)}>
            <option value="false">All</option>
            <option value="true">Unread only</option>
          </SelectField>
        </div>
        {list.loading && !list.data && <Loading />}
        {list.error && <ErrorPanel error={list.error} onRetry={list.reload} />}
        {list.data && list.data.items.length === 0 && <EmptyState icon={<Bell />} title="Nothing here" />}
        <ul className="list">
          {(list.data?.items ?? []).map((n) => (
            <li key={n.id} className={cx('list-item', !n.read && 'list-item-unread')}>
              <button
                type="button"
                className="notification-row"
                onClick={async () => {
                  if (!n.read) await post(`/notifications/${n.id}/read`).catch(() => undefined);
                  if (n.link) navigate(n.link);
                  else list.reload();
                }}
              >
                <span className="person-name">{n.title}</span>
                {n.body && <span className="row-sub">{n.body}</span>}
                <span className="row-sub" title={formatDateTime(n.createdAt, session.org!.timezone)}>
                  {relativeTime(n.createdAt)}
                  {!n.read && ' · unread'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
