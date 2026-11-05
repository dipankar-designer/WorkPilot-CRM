import { useRef, useState, type FormEvent } from 'react';
import { FileText, Image as ImageIcon, Link2, Upload } from 'lucide-react';
import { FILE_CATEGORIES, type FileCategory, type FileDTO, type ProjectDTO, type Visibility } from '@workpilot/shared';
import { del, fileUrl, patch, post, upload } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import { useAuthed } from '../../lib/session';
import { isInternal } from '../../lib/nav';
import { useSubmit } from '../../lib/forms';
import { formatBytes, formatDateTime } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Loading, SelectField, TextField } from '../../components/ui';
import { ErrorPanel } from '../../components/ErrorPanel';
import { useToast } from '../../components/Toasts';

const CATEGORY_LABELS: Record<FileCategory, string> = { image: 'Images', document: 'Documents', pdf: 'PDFs', design: 'Design assets', brief: 'Project briefs', link: 'Shared links', other: 'Other' };

/** A small download link for a file or shared link. */
export function FileChip({ file }: { file: FileDTO }) {
  const href = file.kind === 'link' ? file.url! : fileUrl(file.id, file.category === 'image' || file.category === 'pdf');
  const Icon = file.kind === 'link' ? Link2 : file.category === 'image' ? ImageIcon : FileText;
  return (
    <a className="file-chip" href={href} target="_blank" rel="noopener noreferrer">
      <Icon className="icon icon-xs" aria-hidden />
      <span className="file-chip-name">{file.name}</span>
      {file.sizeBytes !== null && <span className="file-chip-size">{formatBytes(file.sizeBytes)}</span>}
    </a>
  );
}

export function ProjectFiles({ project }: { project: ProjectDTO }) {
  const session = useAuthed();
  const internal = isInternal(session);
  const notify = useToast();
  const [category, setCategory] = useState('');
  const files = useApi<FileDTO[]>(`/projects/${project.id}/files${category ? `?category=${category}` : ''}`);
  const [visibility, setVisibility] = useState<Visibility>(internal ? 'internal' : 'client');
  const [uploadCategory, setUploadCategory] = useState<FileCategory | ''>('');
  const [link, setLink] = useState({ name: '', url: '' });
  const input = useRef<HTMLInputElement>(null);
  const up = useSubmit();
  const linkSubmit = useSubmit();
  const row = useSubmit();
  const canAdd = internal || project.clientsCanPost;

  const onFiles = async (list: FileList | null) => {
    const chosen = Array.from(list ?? []);
    if (!chosen.length) return;
    const done = await up.run(async () => {
      const out: FileDTO[] = [];
      for (const f of chosen) out.push(await upload<FileDTO>(`/files/upload?projectId=${project.id}&visibility=${visibility}${uploadCategory ? `&category=${uploadCategory}` : ''}`, f));
      return out;
    });
    if (done) {
      notify(`${done.length} file${done.length > 1 ? 's' : ''} uploaded`);
      files.reload();
    }
  };

  return (
    <div className="grid-2 grid-2-wide-left">
      <Card
        title="Files and links"
        actions={
          <SelectField label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {FILE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </SelectField>
        }
      >
        {files.loading && <Loading />}
        {files.error && <ErrorPanel error={files.error} onRetry={files.reload} />}
        {row.error && <ErrorPanel error={row.error} />}
        {files.data && files.data.length === 0 && <EmptyState icon={<FileText />} title="No files yet">{internal ? 'Upload briefs, designs and documents, or share links.' : 'Files the team shares with you appear here.'}</EmptyState>}
        {files.data && files.data.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Project files</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Uploaded</th>
                  {internal && <th scope="col">Visible to</th>}
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.data.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <FileChip file={f} />
                      <span className="row-sub">{CATEGORY_LABELS[f.category]}</span>
                    </td>
                    <td>
                      <span className="row-sub-inline">{f.uploadedBy?.name ?? '—'}</span>
                      <span className="row-sub">{formatDateTime(f.createdAt, session.org!.timezone)}</span>
                    </td>
                    {internal && <td>{f.visibility === 'client' ? <Badge tone="success">Team and clients</Badge> : <Badge>Internal</Badge>}</td>}
                    <td className="cell-actions">
                      {internal && (f.uploadedBy?.id === session.user.id || project.canManage) && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (await row.run(() => patch(`/files/${f.id}`, { visibility: f.visibility === 'client' ? 'internal' : 'client' }))) files.reload();
                            }}
                          >
                            {f.visibility === 'client' ? 'Make internal' : 'Share with clients'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Delete ${f.name}`}
                            onClick={async () => {
                              if (!window.confirm(`Delete ${f.name}?`)) return;
                              if (await row.run(() => del(`/files/${f.id}`))) {
                                files.reload();
                                notify(`${f.name} deleted`);
                              }
                            }}
                          >
                            Delete
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {canAdd && (
        <div className="stack-lg">
          <Card title="Upload files">
            <div className="form">
              {up.error && <ErrorPanel error={up.error} operation="Uploading" />}
              {internal && (
                <SelectField label="Who can see them" value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
                  <option value="internal">Internal team only</option>
                  <option value="client">Team and clients</option>
                </SelectField>
              )}
              <SelectField label="Category" value={uploadCategory} onChange={(e) => setUploadCategory(e.target.value as FileCategory | '')} hint="Leave on automatic to sort by file type.">
                <option value="">Automatic</option>
                {FILE_CATEGORIES.filter((c) => c !== 'link').map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </SelectField>
              <input ref={input} type="file" multiple hidden onChange={(e) => (void onFiles(e.target.files), (e.target.value = ''))} />
              <Button icon={<Upload className="icon" aria-hidden />} loading={up.busy} onClick={() => input.current?.click()}>
                Choose files
              </Button>
              <p className="muted small">Files are stored privately and only downloaded through WorkPilot AI after an access check.</p>
            </div>
          </Card>
          {internal && (
            <Card title="Share a link">
              <form
                className="form"
                onSubmit={async (e: FormEvent) => {
                  e.preventDefault();
                  const r = await linkSubmit.run(() => post<FileDTO>(`/projects/${project.id}/links`, { ...link, visibility }));
                  if (r) {
                    setLink({ name: '', url: '' });
                    files.reload();
                    notify('Link shared');
                  }
                }}
                noValidate
              >
                {linkSubmit.error && !Object.keys(linkSubmit.fields).length && <ErrorPanel error={linkSubmit.error} />}
                <TextField label="Name" value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} error={linkSubmit.fields.name} />
                <TextField label="Web address" type="url" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} error={linkSubmit.fields.url} />
                <div className="form-actions">
                  <Button type="submit" variant="secondary" loading={linkSubmit.busy}>
                    Add link
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
