import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Bot, Send } from 'lucide-react';
import type { AiAnswerDTO, ProjectDTO } from '@workpilot/shared';
import { post } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useAuthed } from '../lib/session';
import { useSubmit } from '../lib/forms';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, EmptyState, Loading, PageHeader, SelectField } from '../components/ui';
import { ErrorPanel } from '../components/ErrorPanel';
import { RichText } from '../components/RichText';

const SUGGESTIONS = [
  'How many hours did I track this week?',
  'Which projects are approaching their deadlines?',
  'Which of my tasks are overdue?',
  'Which timesheets need my approval?',
  'Prepare a weekly project report.',
];

export function Assistant() {
  const session = useAuthed();
  const [params] = useSearchParams();
  const status = useApi<{ configured: boolean; provider: string | null; model: string | null; issue: string | null }>('/ai/status');
  const history = useApi<AiAnswerDTO[]>('/ai/history');
  const projects = useApi<ProjectDTO[]>('/projects');
  const [question, setQuestion] = useState(params.get('q') ?? '');
  const [projectId, setProjectId] = useState(params.get('project') ?? '');
  const [answers, setAnswers] = useState<AiAnswerDTO[]>([]);
  const s = useSubmit();
  const input = useRef<HTMLTextAreaElement>(null);
  const tz = session.org!.timezone;

  useEffect(() => {
    if (history.data) setAnswers(history.data.slice().reverse());
  }, [history.data]);

  const ask = async (e?: FormEvent, q = question) => {
    e?.preventDefault();
    if (!q.trim()) return;
    const r = await s.run(() => post<AiAnswerDTO>('/ai/ask', { question: q, projectId: projectId || undefined }));
    if (r) {
      setAnswers((a) => [...a, r]);
      setQuestion('');
    }
  };

  const configured = status.data?.configured;
  return (
    <div className="page">
      <PageHeader title="AI Assistant" description="Ask about your hours, tasks, projects, deadlines and approvals. Answers use only data you are allowed to see, and the assistant cannot change anything." />
      {status.data && !configured && (
        <p className="notice notice-warning" role="status">
          The AI assistant is not configured on this server, so it cannot answer questions. An administrator can enable it by setting AI_PROVIDER (with an API key for a hosted model, or a local Ollama model) in the server settings.
        </p>
      )}
      {status.data && configured && (
        <p className="muted small">
          Answering with {status.data.provider === 'ollama' ? 'a local model' : 'Claude'} ({status.data.model}). Local models on a CPU can take a minute or two.
        </p>
      )}
      <div className="assistant-layout">
        <Card>
          <div className="assistant-thread" aria-live="polite">
            {history.loading && <Loading />}
            {answers.length === 0 && !history.loading && (
              <EmptyState icon={<Bot />} title="Ask a question">
                Try one of the suggestions, or ask about a specific project.
              </EmptyState>
            )}
            {answers.map((a) => (
              <div key={a.id} className="qa">
                <p className="qa-q">
                  <strong>You:</strong> {a.question}
                </p>
                <div className="qa-a">
                  <RichText text={a.answer} />
                  <p className="row-sub">
                    {formatDateTime(a.createdAt, tz)} · Based on: {a.sources.join(', ')}
                  </p>
                </div>
              </div>
            ))}
            {s.busy && <Loading label="Thinking… this reads your data and may take a while." />}
          </div>
          {s.error && <ErrorPanel error={s.error} operation="Asking the assistant" onRetry={() => void ask()} />}
          <form className="form assistant-form" onSubmit={ask}>
            <div className="form-grid">
              <SelectField label="About a project (optional)" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All my work</option>
                {(projects.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </SelectField>
            </div>
            <div className="field">
              <label htmlFor="ai-question" className="field-label">
                Your question
              </label>
              <textarea
                ref={input}
                id="ai-question"
                className="input textarea"
                rows={2}
                value={question}
                maxLength={2000}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void ask();
                  }
                }}
                disabled={!configured}
              />
            </div>
            <div className="form-actions">
              <Button type="submit" loading={s.busy} disabled={!configured || !question.trim()} icon={<Send className="icon" aria-hidden />}>
                Ask
              </Button>
            </div>
          </form>
        </Card>
        <Card title="Suggestions">
          <ul className="suggestions">
            {SUGGESTIONS.map((q) => (
              <li key={q}>
                <button type="button" className="suggestion" disabled={!configured || s.busy} onClick={() => void ask(undefined, q)}>
                  {q}
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">
            <Badge>Read-only</Badge> The assistant summarises and reports. Approvals, edits and permission changes are always done by people in the app.
          </p>
        </Card>
      </div>
    </div>
  );
}
