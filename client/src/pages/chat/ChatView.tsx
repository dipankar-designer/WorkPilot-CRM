// One conversation: history (with older messages on demand), live delivery, typing indicators,
// read receipts, attachments, @mentions, editing and deletion. Messages are shown only after
// the server has stored them; if realtime is offline the view says so and still works by reloading.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Paperclip, Send } from 'lucide-react';
import type { ChannelDTO, FileDTO, MessageDTO } from '@workpilot/shared';
import { asApiError, del, get, patch, post, upload, type ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { useRealtime, useRealtimeEvent } from '../../lib/realtime';
import { formatDateTime, formatTime } from '../../lib/format';
import { Button, Loading, cx } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { MentionInput } from '../../components/MentionInput';
import { RichText } from '../../components/RichText';
import { Avatar } from '../../components/bits';
import { FileChip } from '../projects/Files';

export function ChatView({ channelId, onRead }: { channelId: string; onRead?: () => void }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const channel = useApi<ChannelDTO>(`/chat/channels/${channelId}`);
  const [messages, setMessages] = useState<MessageDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const { status, online, sendTyping } = useRealtime();
  const list = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const people = useMemo(() => (channel.data?.members ?? []).filter((m) => m.id !== session.user.id), [channel.data, session.user.id]);

  const scrollDown = () => window.requestAnimationFrame(() => list.current && (list.current.scrollTop = list.current.scrollHeight));

  const markRead = useCallback(
    async (seq: number) => {
      if (!seq) return;
      await post(`/chat/channels/${channelId}/read`, { seq }).catch(() => undefined);
      onRead?.();
    },
    [channelId, onRead],
  );

  const loadLatest = useCallback(async () => {
    try {
      const m = await get<MessageDTO[]>(`/chat/channels/${channelId}/messages?limit=50`);
      setMessages(m);
      setMore(m.length === 50);
      setError(null);
      setLoaded(true);
      scrollDown();
      const last = m.at(-1);
      if (last) void markRead(last.seq);
    } catch (e) {
      setError(asApiError(e));
      setLoaded(true);
    }
  }, [channelId, markRead]);

  useEffect(() => {
    setLoaded(false);
    void loadLatest();
  }, [loadLatest]);

  // Live: new messages, edits and deletions are fetched through the API (access re-checked).
  useRealtimeEvent(
    (e) => (e.type === 'chat.message' || e.type === 'chat.updated') && e.channelId === channelId,
    async (e) => {
      if (e.type !== 'chat.message' && e.type !== 'chat.updated') return;
      try {
        const m = await get<MessageDTO>(`/chat/messages/${e.messageId}`);
        setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m]));
        if (e.type === 'chat.message') {
          setTyping((t) => {
            const next = { ...t };
            if (m.author) delete next[m.author.id];
            return next;
          });
          scrollDown();
          if (document.visibilityState === 'visible') void markRead(m.seq);
        }
      } catch {
        /* removed or no longer accessible */
      }
    },
  );
  useRealtimeEvent(
    (e) => e.type === 'chat.read' && e.channelId === channelId,
    (e) => {
      if (e.type !== 'chat.read') return;
      const reader = channel.data?.members.find((m) => m.id === e.userId);
      if (!reader) return;
      setMessages((prev) => prev.map((m) => (m.seq <= e.seq && m.author?.id !== e.userId && !m.readBy.some((r) => r.id === e.userId) ? { ...m, readBy: [...m.readBy, reader] } : m)));
    },
  );
  useRealtimeEvent(
    (e) => e.type === 'typing' && e.channelId === channelId,
    (e) => e.type === 'typing' && setTyping((t) => ({ ...t, [e.userId]: { name: e.name, until: Date.now() + 4000 } })),
  );
  useEffect(() => {
    const t = window.setInterval(() => setTyping((cur) => Object.fromEntries(Object.entries(cur).filter(([, v]) => v.until > Date.now()))), 1000);
    return () => window.clearInterval(t);
  }, []);

  const loadOlder = async () => {
    const first = messages[0];
    if (!first) return;
    try {
      const older = await get<MessageDTO[]>(`/chat/channels/${channelId}/messages?limit=50&before=${first.seq}`);
      setMessages((m) => [...older, ...m]);
      setMore(older.length === 50);
    } catch (e) {
      setError(asApiError(e));
    }
  };

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() && !files.length) return;
    setSending(true);
    setError(null);
    try {
      const m = await post<MessageDTO>(`/chat/channels/${channelId}/messages`, { body: draft, hasAttachments: files.length > 0 });
      const uploaded: FileDTO[] = [];
      for (const f of files) uploaded.push(await upload<FileDTO>(`/files/upload?channelId=${channelId}&messageId=${m.id}`, f));
      setMessages((prev) => [...prev.filter((x) => x.id !== m.id), { ...m, files: uploaded }]);
      setDraft('');
      setFiles([]);
      scrollDown();
    } catch (err) {
      // Nothing is shown as sent unless the server stored it.
      setError(asApiError(err));
    } finally {
      setSending(false);
    }
  };

  const typingNames = Object.values(typing).map((t) => t.name);
  const c = channel.data;

  return (
    <section className="chat-view" aria-label={c ? `Conversation: ${c.name}` : 'Conversation'}>
      <header className="chat-head">
        <h2 className="chat-title">{c?.name ?? '…'}</h2>
        {c && (
          <p className="row-sub">
            {c.members.length} {c.members.length === 1 ? 'person' : 'people'}
            {c.kind === 'direct' && people[0] && (online.has(people[0].id) ? ' · Online' : ' · Offline')}
            {c.kind === 'client' && ' · Clients can read this channel'}
          </p>
        )}
      </header>
      {status !== 'open' && <p className="notice notice-warning chat-offline">Live updates are not connected, so new messages may not appear until you reload. Messages you send are still saved.</p>}
      <div ref={list} className="chat-messages" role="log" aria-live="polite" aria-relevant="additions">
        {!loaded && <Loading label="Loading messages…" />}
        {more && loaded && messages.length > 0 && (
          <div className="chat-more">
            <Button size="sm" variant="ghost" onClick={() => void loadOlder()}>
              Load earlier messages
            </Button>
          </div>
        )}
        {loaded && messages.length === 0 && <p className="chat-empty">No messages yet. Say hello.</p>}
        {messages.map((m, i) => {
          const mine = m.author?.id === session.user.id;
          const prev = messages[i - 1];
          const grouped = prev && prev.author?.id === m.author?.id && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
          const isLastMine = mine && !messages.slice(i + 1).some((x) => x.author?.id === session.user.id);
          return (
            <div key={m.id} className={cx('msg', mine && 'msg-mine', grouped && 'msg-grouped')}>
              {!grouped && !mine && <Avatar name={m.author?.name ?? '?'} size="sm" online={m.author ? online.has(m.author.id) : undefined} />}
              <div className="msg-bubble">
                {!grouped && (
                  <p className="msg-head">
                    <span className="person-name">{mine ? 'You' : (m.author?.name ?? 'Former member')}</span>{' '}
                    <time className="row-sub" dateTime={m.createdAt} title={formatDateTime(m.createdAt, tz)}>
                      {formatTime(m.createdAt, tz)}
                    </time>
                  </p>
                )}
                {m.deleted ? (
                  <p className="muted small">Message deleted</p>
                ) : editing === m.id ? (
                  <form
                    className="inline-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        const x = await patch<MessageDTO>(`/chat/messages/${m.id}`, { body: editDraft });
                        setMessages((prev) => prev.map((y) => (y.id === x.id ? { ...x, files: y.files } : y)));
                        setEditing(null);
                      } catch (err) {
                        setError(asApiError(err));
                      }
                    }}
                  >
                    <label className="sr-only" htmlFor={`edit-${m.id}`}>
                      Edit message
                    </label>
                    <input id={`edit-${m.id}`} className="input" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} autoFocus />
                    <Button size="sm" type="submit">
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </form>
                ) : (
                  m.body && <RichText text={m.body} />
                )}
                {m.files.length > 0 && (
                  <ul className="file-chips">
                    {m.files.map((f) => (
                      <li key={f.id}>
                        <FileChip file={f} />
                      </li>
                    ))}
                  </ul>
                )}
                <p className="msg-foot">
                  {m.editedAt && !m.deleted && <span className="row-sub">edited</span>}
                  {mine && !m.deleted && editing !== m.id && (
                    <>
                      <button type="button" className="link-button" onClick={() => (setEditing(m.id), setEditDraft(m.body))}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        onClick={async () => {
                          try {
                            await del(`/chat/messages/${m.id}`);
                            setMessages((prev) => prev.map((y) => (y.id === m.id ? { ...y, deleted: true, body: '', files: [] } : y)));
                          } catch (err) {
                            setError(asApiError(err));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                  {isLastMine && m.readBy.length > 0 && <span className="row-sub read-receipt">Seen by {m.readBy.map((r) => r.name.split(' ')[0]).join(', ')}</span>}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <p className="typing" aria-live="polite">
        {typingNames.length > 0 && `${typingNames.join(', ')} ${typingNames.length > 1 ? 'are' : 'is'} typing…`}
      </p>
      {error && <ErrorPanel error={error} operation="Chat" onRetry={() => void loadLatest()} />}
      <form className="chat-composer" onSubmit={send}>
        {files.length > 0 && (
          <ul className="pending-files" aria-label="Files to send">
            {files.map((f, i) => (
              <li key={i}>
                {f.name}{' '}
                <button type="button" className="link-button" onClick={() => setFiles(files.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="chat-composer-row">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5)), (e.target.value = ''))} />
          <button type="button" className="icon-btn" onClick={() => fileInput.current?.click()} aria-label="Attach files">
            <Paperclip className="icon" aria-hidden />
          </button>
          <MentionInput
            label="Message"
            hideLabel
            rows={1}
            value={draft}
            onChange={(v) => {
              setDraft(v);
              sendTyping(channelId);
            }}
            people={people}
            placeholder={c ? `Message ${c.name}` : 'Message'}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.defaultPrevented) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button type="submit" loading={sending} disabled={!draft.trim() && !files.length} icon={<Send className="icon" aria-hidden />}>
            Send
          </Button>
        </div>
        <p className="muted small">Enter to send · Shift+Enter for a new line · @ to mention</p>
      </form>
    </section>
  );
}
