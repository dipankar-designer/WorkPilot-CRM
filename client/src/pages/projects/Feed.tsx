import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Lock, MessageSquare, Paperclip, Pin, Send, Users } from 'lucide-react';
import { FEED_KINDS, FEED_KIND_LABELS, REACTIONS, type FeedCommentDTO, type FeedKind, type FeedPostDTO, type FileDTO, type ProjectDTO, type ProjectMemberDTO, type Visibility } from '@workpilot/shared';
import { del, patch, post, upload } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { isInternal } from '../../lib/nav';
import { useSubmit } from '../../lib/forms';
import { useRealtimeEvent } from '../../lib/realtime';
import { formatDateTime, relativeTime } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Loading, SelectField, TextField, cx } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { MentionInput } from '../../components/MentionInput';
import { RichText } from '../../components/RichText';
import { Avatar } from '../../components/bits';
import { FileChip } from './Files';
import { useToast } from '../../components/Toasts';

export function ProjectFeed({ project }: { project: ProjectDTO }) {
  const session = useAuthed();
  const internal = isInternal(session);
  const [params] = useSearchParams();
  const [filters, setFilters] = useState({ authorId: '', kind: '', visibility: '', from: '', to: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v));
  const feed = useApi<FeedPostDTO[]>(`/projects/${project.id}/feed?${qs}`);
  const members = useApi<ProjectMemberDTO[]>(`/projects/${project.id}/members`);
  useRealtimeEvent((e) => e.type === 'feed.changed' && e.projectId === project.id, feed.reload);
  const people = useMemo(() => (members.data ?? []).filter((m) => m.userId !== session.user.id).map((m) => ({ id: m.userId, name: m.name })), [members.data, session.user.id]);
  const canPost = internal || project.clientsCanPost;

  // Opening the feed marks it as read for the sidebar's unread count.
  useEffect(() => {
    void post(`/projects/${project.id}/seen`).catch(() => undefined);
  }, [project.id, feed.data?.length]);

  // Deep links (?post=…) scroll to the post once loaded.
  const target = params.get('post');
  useEffect(() => {
    if (target && feed.data) document.getElementById(`post-${target}`)?.scrollIntoView({ block: 'center' });
  }, [target, feed.data]);

  const replace = (p: FeedPostDTO) => feed.setData((feed.data ?? []).map((x) => (x.id === p.id ? p : x)));

  return (
    <div className="feed-layout">
      <div className="stack-lg">
        {canPost ? (
          <Composer project={project} people={people} onPosted={(p) => feed.setData([p, ...(feed.data ?? [])])} />
        ) : (
          <p className="notice notice-info">Posting is turned off for clients in this project. You can still read shared updates.</p>
        )}
        {feed.loading && !feed.data && <Loading label="Loading updates…" />}
        {feed.error && <ErrorPanel error={feed.error} operation="Loading the feed" onRetry={feed.reload} />}
        {feed.data && feed.data.length === 0 && (
          <EmptyState icon={<MessageSquare />} title={qs.toString() ? 'No updates match these filters' : 'No updates yet'}>
            {qs.toString() ? 'Try clearing a filter.' : 'Share progress, ask a question or post an announcement.'}
          </EmptyState>
        )}
        {(feed.data ?? []).map((p) => (
          <PostCard key={p.id} post={p} people={people} highlight={p.id === target} onChange={replace} onDeleted={() => feed.setData((feed.data ?? []).filter((x) => x.id !== p.id))} canComment={canPost} />
        ))}
      </div>
      <aside className="feed-filters" aria-label="Filter updates">
        <Card title="Filter updates" headingLevel={2}>
          <div className="form">
            <SelectField label="Author" value={filters.authorId} onChange={(e) => setFilters({ ...filters, authorId: e.target.value })}>
              <option value="">Anyone</option>
              {(members.data ?? []).map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </SelectField>
            <SelectField label="Type" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}>
              <option value="">All types</option>
              {FEED_KINDS.map((k) => (
                <option key={k} value={k}>
                  {FEED_KIND_LABELS[k]}
                </option>
              ))}
            </SelectField>
            {internal && (
              <SelectField label="Visibility" value={filters.visibility} onChange={(e) => setFilters({ ...filters, visibility: e.target.value })}>
                <option value="">Internal and client</option>
                <option value="internal">Internal only</option>
                <option value="client">Client-visible</option>
              </SelectField>
            )}
            <TextField label="From" type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
            <TextField label="To" type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
            {qs.toString() && (
              <Button variant="ghost" size="sm" onClick={() => setFilters({ authorId: '', kind: '', visibility: '', from: '', to: '' })}>
                Clear filters
              </Button>
            )}
          </div>
        </Card>
      </aside>
    </div>
  );
}

function Composer({ project, people, onPosted }: { project: ProjectDTO; people: { id: string; name: string }[]; onPosted: (p: FeedPostDTO) => void }) {
  const session = useAuthed();
  const internal = isInternal(session);
  const notify = useToast();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<FeedKind>('update');
  const [visibility, setVisibility] = useState<Visibility>('internal');
  const [link, setLink] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = useSubmit();

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!body.trim()) return s.fail({ body: 'Write something to post.' });
    const sent = body;
    const created = await s.run(async () => {
      const p = await post<FeedPostDTO>(`/projects/${project.id}/feed`, { body, kind, visibility: internal ? visibility : 'client', linkUrl: link.trim() || null });
      // Attachments are uploaded after the post exists; each upload is checked by the server.
      const uploaded: FileDTO[] = [];
      for (const f of files) uploaded.push(await upload<FileDTO>(`/files/upload?projectId=${project.id}&postId=${p.id}&visibility=${p.visibility}`, f));
      return { ...p, files: [...uploaded, ...p.files] };
    });
    if (created) {
      onPosted(created);
      // Only clear what was sent: anything typed while the post was saving is kept.
      setBody((current) => (current === sent ? '' : current));
      setLink('');
      setFiles([]);
      setKind('update');
      notify(created.visibility === 'client' ? 'Update posted (visible to clients)' : 'Update posted (internal)');
    }
  };

  return (
    <Card>
      <form className="form" onSubmit={submit} noValidate>
        {s.error && !s.fields.body && <ErrorPanel error={s.error} operation="Posting the update" />}
        <MentionInput label="Share an update" value={body} onChange={setBody} people={people} rows={3} placeholder="Share progress or ask a question. Type @ to mention someone." error={s.fields.body ?? s.fields.linkUrl} onSubmitShortcut={() => void submit()} />
        <div className="composer-row">
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value as FeedKind)}>
            {FEED_KINDS.filter((k) => internal || k !== 'announcement').map((k) => (
              <option key={k} value={k}>
                {FEED_KIND_LABELS[k]}
              </option>
            ))}
          </SelectField>
          {internal ? (
            <SelectField label="Who can see it" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
              <option value="internal">Internal team only</option>
              <option value="client">Team and clients</option>
            </SelectField>
          ) : (
            <p className="muted small composer-note">Your posts are visible to the project team.</p>
          )}
          <TextField label="Link (optional)" type="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
        </div>
        {files.length > 0 && (
          <ul className="pending-files" aria-label="Files to attach">
            {files.map((f, i) => (
              <li key={i}>
                {f.name}
                <button type="button" className="link-button" onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions">
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 10))} />
          <Button variant="ghost" icon={<Paperclip className="icon" aria-hidden />} onClick={() => fileInput.current?.click()}>
            Attach files
          </Button>
          <Button type="submit" loading={s.busy} icon={<Send className="icon" aria-hidden />}>
            Post
          </Button>
        </div>
      </form>
    </Card>
  );
}

function PostCard({ post: p, people, highlight, onChange, onDeleted, canComment }: { post: FeedPostDTO; people: { id: string; name: string }[]; highlight: boolean; onChange: (p: FeedPostDTO) => void; onDeleted: () => void; canComment: boolean }) {
  const session = useAuthed();
  const tz = session.org!.timezone;
  const notify = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.body);
  const [comment, setComment] = useState('');
  const [replyTo, setReplyTo] = useState<FeedCommentDTO | null>(null);
  const s = useSubmit();
  // Reactions have their own state so a slow reaction never blocks commenting.
  const react = useSubmit();
  const mine = p.author?.id === session.user.id;
  const top = p.comments.filter((c) => !c.parentId);
  const replies = (id: string) => p.comments.filter((c) => c.parentId === id);

  return (
    <article id={`post-${p.id}`} className={cx('post', p.pinned && 'post-pinned', highlight && 'post-highlight')} aria-labelledby={`post-${p.id}-author`}>
      <header className="post-header">
        <Avatar name={p.author?.name ?? '?'} />
        <div className="post-meta">
          <span id={`post-${p.id}-author`} className="person-name">
            {p.author?.name ?? 'Former member'}
          </span>
          <span className="row-sub">
            <time dateTime={p.createdAt} title={formatDateTime(p.createdAt, tz)}>
              {relativeTime(p.createdAt)}
            </time>
            {p.editedAt && ' · edited'}
          </span>
        </div>
        <div className="post-badges">
          {p.pinned && (
            <Badge tone="primary">
              <Pin className="icon icon-xs" aria-hidden /> Pinned
            </Badge>
          )}
          <Badge tone={p.kind === 'announcement' ? 'warning' : 'neutral'}>{FEED_KIND_LABELS[p.kind]}</Badge>
          {p.visibility === 'client' ? (
            <Badge tone="success">
              <Users className="icon icon-xs" aria-hidden /> Client-visible
            </Badge>
          ) : (
            <Badge>
              <Lock className="icon icon-xs" aria-hidden /> Internal
            </Badge>
          )}
        </div>
      </header>
      {s.error && <ErrorPanel error={s.error} />}
      {react.error && <ErrorPanel error={react.error} operation="Reacting" />}
      {editing ? (
        <div className="form">
          <MentionInput label="Edit update" hideLabel value={draft} onChange={setDraft} people={people} rows={3} />
          <div className="form-actions">
            <Button variant="ghost" onClick={() => (setEditing(false), setDraft(p.body))}>
              Cancel
            </Button>
            <Button
              loading={s.busy}
              onClick={async () => {
                const r = await s.run(() => patch<FeedPostDTO>(`/feed/${p.id}`, { body: draft }));
                if (r) {
                  onChange(r);
                  setEditing(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <RichText text={p.body} className="post-body rich-text" />
      )}
      {p.linkUrl && (
        <a className="post-link" href={p.linkUrl} target="_blank" rel="noopener noreferrer nofollow">
          {p.linkUrl}
        </a>
      )}
      {p.files.length > 0 && (
        <ul className="file-chips">
          {p.files.map((f) => (
            <li key={f.id}>
              <FileChip file={f} />
            </li>
          ))}
        </ul>
      )}
      <div className="post-actions">
        <div className="reactions" role="group" aria-label="Reactions">
          {REACTIONS.map((emoji) => {
            const r = p.reactions.find((x) => x.emoji === emoji);
            if (!r && p.reactions.length >= 3) return null;
            return (
              <button
                key={emoji}
                type="button"
                className={cx('reaction', r?.mine && 'reaction-mine', !r && 'reaction-empty')}
                aria-pressed={!!r?.mine}
                aria-label={`React with ${emoji}${r ? `, ${r.count} so far` : ''}`}
                disabled={react.busy}
                onClick={async () => {
                  const x = await react.run(() => post<FeedPostDTO>(`/feed/${p.id}/reactions`, { emoji }));
                  if (x) onChange(x);
                }}
              >
                <span aria-hidden>{emoji}</span>
                {r && <span className="reaction-count">{r.count}</span>}
              </button>
            );
          })}
        </div>
        <div className="row-actions">
          {p.canPin && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const x = await s.run(() => post<FeedPostDTO>(`/feed/${p.id}/${p.pinned ? 'unpin' : 'pin'}`));
                if (x) onChange(x);
              }}
            >
              {p.pinned ? 'Unpin' : 'Pin'}
            </Button>
          )}
          {mine && !editing && (
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {p.canEdit && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                if (!window.confirm('Delete this update for everyone?')) return;
                if (await s.run(() => del(`/feed/${p.id}`))) {
                  onDeleted();
                  notify('Update deleted');
                }
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      {(top.length > 0 || canComment) && (
        <section className="comments" aria-label="Comments">
          {top.map((c) => (
            <div key={c.id} className="comment-thread">
              <Comment c={c} postId={p.id} onChange={onChange} onReply={() => setReplyTo(c)} canReply={canComment} />
              {replies(c.id).map((r) => (
                <div key={r.id} className="comment-reply">
                  <Comment c={r} postId={p.id} onChange={onChange} />
                </div>
              ))}
            </div>
          ))}
          {canComment && (
            <form
              className="comment-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!comment.trim()) return;
                const x = await s.run(() => post<FeedPostDTO>(`/feed/${p.id}/comments`, { body: comment, parentId: replyTo?.id }));
                if (x) {
                  onChange(x);
                  setComment('');
                  setReplyTo(null);
                }
              }}
            >
              {replyTo && (
                <p className="muted small">
                  Replying to {replyTo.author?.name ?? 'a comment'}{' '}
                  <button type="button" className="link-button" onClick={() => setReplyTo(null)}>
                    Cancel reply
                  </button>
                </p>
              )}
              <MentionInput label={replyTo ? 'Write a reply' : 'Write a comment'} hideLabel value={comment} onChange={setComment} people={people} rows={1} placeholder={replyTo ? 'Write a reply…' : 'Write a comment…'} />
              <Button type="submit" size="sm" loading={s.busy} disabled={!comment.trim()}>
                {replyTo ? 'Reply' : 'Comment'}
              </Button>
            </form>
          )}
        </section>
      )}
    </article>
  );
}

function Comment({ c, postId, onChange, onReply, canReply }: { c: FeedCommentDTO; postId: string; onChange: (p: FeedPostDTO) => void; onReply?: () => void; canReply?: boolean }) {
  const session = useAuthed();
  const s = useSubmit();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.body);
  const mine = c.author?.id === session.user.id;
  void postId;
  return (
    <div className="comment">
      <Avatar name={c.author?.name ?? '?'} size="sm" />
      <div className="comment-main">
        <p className="comment-head">
          <span className="person-name">{c.author?.name ?? 'Former member'}</span> <span className="row-sub">{relativeTime(c.createdAt)}{c.editedAt && ' · edited'}</span>
        </p>
        {c.deleted ? (
          <p className="muted small">This comment was deleted.</p>
        ) : editing ? (
          <div className="comment-form">
            <label className="sr-only" htmlFor={`edit-${c.id}`}>
              Edit comment
            </label>
            <textarea id={`edit-${c.id}`} className="input textarea" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <Button
              size="sm"
              loading={s.busy}
              onClick={async () => {
                const x = await s.run(() => patch<FeedPostDTO>(`/feed/comments/${c.id}`, { body: draft }));
                if (x) {
                  onChange(x);
                  setEditing(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        ) : (
          <RichText text={c.body} />
        )}
        {s.error && <ErrorPanel error={s.error} />}
        {!c.deleted && (
          <div className="comment-actions">
            {canReply && onReply && (
              <button type="button" className="link-button" onClick={onReply}>
                Reply
              </button>
            )}
            {mine && !editing && (
              <button type="button" className="link-button" onClick={() => setEditing(true)}>
                Edit
              </button>
            )}
            {c.canEdit && (
              <button
                type="button"
                className="link-button"
                onClick={async () => {
                  const x = await s.run(() => del<FeedPostDTO>(`/feed/comments/${c.id}`));
                  if (x) onChange(x);
                }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
