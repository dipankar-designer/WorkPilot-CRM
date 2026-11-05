import { useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Hash, MessageSquarePlus, MessagesSquare, Users } from 'lucide-react';
import type { ChannelDTO, ChannelKind, PersonRef } from '@workpilot/shared';
import { post } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { isInternal } from '../../lib/nav';
import { useSubmit } from '../../lib/forms';
import { useRealtime, useRealtimeEvent } from '../../lib/realtime';
import { Button, Dialog, EmptyState, Loading, PageHeader, SelectField, TextField, cx } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { Avatar } from '../../components/bits';
import { ChatView } from './ChatView';

const GROUPS: { kinds: ChannelKind[]; label: string }[] = [
  { kinds: ['direct'], label: 'Direct messages' },
  { kinds: ['group', 'team'], label: 'Groups and teams' },
  { kinds: ['project'], label: 'Project teams' },
  { kinds: ['client'], label: 'Client channels' },
];

export function TeamChat() {
  const session = useAuthed();
  const internal = isInternal(session);
  const [params, setParams] = useSearchParams();
  const channels = useApi<ChannelDTO[]>('/chat/channels');
  const { online } = useRealtime();
  const [q, setQ] = useState('');
  const [dialog, setDialog] = useState<null | 'direct' | 'group'>(null);
  useRealtimeEvent((e) => e.type === 'chat.message', channels.reload);
  const selected = params.get('c') ?? channels.data?.[0]?.id ?? null;
  const filtered = useMemo(() => (channels.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase())), [channels.data, q]);

  return (
    <div className="page page-wide">
      <PageHeader
        title="Team Chat"
        description={internal ? 'Direct messages, groups, team channels and project conversations.' : 'Conversations with the teams on your projects.'}
        actions={
          internal && (
            <>
              <Button variant="secondary" icon={<MessageSquarePlus className="icon" aria-hidden />} onClick={() => setDialog('direct')}>
                New message
              </Button>
              <Button icon={<Users className="icon" aria-hidden />} onClick={() => setDialog('group')}>
                New channel
              </Button>
            </>
          )
        }
      />
      <div className="chat-layout">
        <nav className="chat-sidebar" aria-label="Conversations">
          <TextField label="Find a conversation" type="search" value={q} onChange={(e) => setQ(e.target.value)} />
          {channels.loading && !channels.data && <Loading />}
          {channels.error && <ErrorPanel error={channels.error} onRetry={channels.reload} />}
          {channels.data?.length === 0 && <p className="muted small">No conversations yet.</p>}
          {GROUPS.map((g) => {
            const items = filtered.filter((c) => g.kinds.includes(c.kind));
            if (!items.length) return null;
            return (
              <div key={g.label} className="chat-group">
                <h2 className="chat-group-title">{g.label}</h2>
                <ul>
                  {items.map((c) => {
                    const other = c.kind === 'direct' ? c.members.find((m) => m.id !== session.user.id) : null;
                    return (
                      <li key={c.id}>
                        <button type="button" className={cx('chat-channel', c.id === selected && 'chat-channel-active')} aria-current={c.id === selected ? 'true' : undefined} onClick={() => setParams({ c: c.id })}>
                          {other ? <Avatar name={other.name} size="sm" online={online.has(other.id)} /> : <Hash className="icon" aria-hidden />}
                          <span className="chat-channel-name">{c.name}</span>
                          {c.unread > 0 && (
                            <span className="unread-badge" aria-label={`${c.unread} unread`}>
                              {c.unread}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>
        <div className="chat-main">
          {selected ? (
            <ChatView channelId={selected} key={selected} onRead={channels.reload} />
          ) : (
            channels.data && <EmptyState icon={<MessagesSquare />} title="No conversation selected">{internal ? 'Start a direct message or create a channel.' : 'Your project teams’ client channels appear here.'}</EmptyState>
          )}
        </div>
      </div>
      {dialog && <NewConversation kind={dialog} onClose={() => setDialog(null)} onCreated={(c) => (setDialog(null), channels.reload(), setParams({ c: c.id }))} />}
    </div>
  );
}

function NewConversation({ kind, onClose, onCreated }: { kind: 'direct' | 'group'; onClose: () => void; onCreated: (c: ChannelDTO) => void }) {
  const people = useApi<PersonRef[]>('/chat/people');
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [channelKind, setChannelKind] = useState<'group' | 'team'>('group');
  const [members, setMembers] = useState<string[]>([]);
  const s = useSubmit();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = await s.run(() => (kind === 'direct' ? post<ChannelDTO>('/chat/direct', { userId }) : post<ChannelDTO>('/chat/channels', { kind: channelKind, name, memberIds: members })));
    if (c) onCreated(c);
  };
  return (
    <Dialog open onClose={onClose} title={kind === 'direct' ? 'New direct message' : 'New channel'}>
      <form className="form" onSubmit={submit} noValidate>
        {s.error && !Object.keys(s.fields).length && <ErrorPanel error={s.error} />}
        {people.error && <ErrorPanel error={people.error} />}
        {kind === 'direct' ? (
          <SelectField label="Person" value={userId} onChange={(e) => setUserId(e.target.value)} error={s.fields.userId}>
            <option value="">Choose someone…</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        ) : (
          <>
            <TextField label="Channel name" value={name} onChange={(e) => setName(e.target.value)} error={s.fields.name} />
            <SelectField label="Type" value={channelKind} onChange={(e) => setChannelKind(e.target.value as 'group' | 'team')} hint="Team channels are for departments or teams; groups for anything else. Both are private to their members.">
              <option value="group">Group</option>
              <option value="team">Team channel</option>
            </SelectField>
            <fieldset className="fieldset">
              <legend className="field-label">Members</legend>
              <div className="check-grid">
                {(people.data ?? []).map((p) => (
                  <label key={p.id} className="check">
                    <input type="checkbox" checked={members.includes(p.id)} onChange={(e) => setMembers(e.target.checked ? [...members, p.id] : members.filter((x) => x !== p.id))} />
                    {p.name}
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={s.busy} disabled={kind === 'direct' ? !userId : !name.trim()}>
            {kind === 'direct' ? 'Open conversation' : 'Create channel'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
