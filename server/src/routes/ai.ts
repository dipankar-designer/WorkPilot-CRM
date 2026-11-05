// AI assistant (read-only). The server gathers a compact snapshot of data the asking user is
// already allowed to see (every query runs through RLS as that user), sends it with the question
// to the configured provider, and returns the answer. The model has no tools and cannot change
// anything. Without a configured provider the endpoint says so; it never fabricates an answer.

import Anthropic from '@anthropic-ai/sdk';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { AiAnswerDTO } from '@workpilot/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { AppError, forbidden } from '../errors/AppError.js';
import { ok, parse } from '../http/respond.js';
import { requirePermission } from '../auth/session.js';
import { plainText } from '../services/mentions.js';
import { read, tx } from '../services/tx.js';
import { log } from '../logging/logger.js';
import { zUuid } from './common.js';

export const aiRouter = Router();
aiRouter.use(requirePermission('ai.use', 'Your role does not include the AI assistant.'));

const SERVICE = 'AI assistant';

const SYSTEM = `You are the WorkPilot AI assistant inside a workforce management app.
Answer the user's question using ONLY the JSON data provided in the message. The data is everything this user is allowed to see; it was collected for them a moment ago.
- If the data does not contain what is needed, say plainly that you cannot tell from the available data. Never guess, estimate or invent names, numbers or dates.
- You are read-only. You cannot approve timesheets or leave, change tasks, permissions or any record. If asked to, explain that it must be done in the app by someone with permission.
- Use British English. Be concise. Use short paragraphs and "- " bullet lists; no tables. Give hours with up to two decimals.
- Times and dates are in the organisation's timezone given in the data.`;

// ---------------------------------------------------------------- context

async function buildContext(db: pg.PoolClient, req: Request, projectId: string | null) {
  const auth = req.auth!;
  const sources: string[] = [];
  const base = (await one<{ today: string; now_local: string; week_start: string; tz: string }>(
    db,
    `SELECT (now() AT TIME ZONE timezone)::date::text AS today, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD HH24:MI') AS now_local,
            app.week_start(now(), timezone)::text AS week_start, timezone AS tz FROM organizations WHERE id = app.org()`,
  ))!;
  const ctx: Record<string, unknown> = {
    organisation: auth.org!.name,
    timezone: base.tz,
    now: base.now_local,
    today: base.today,
    current_week_starts: base.week_start,
    me: { name: auth.user.fullName, roles: auth.roles },
  };

  const hours = await query<{ project: string | null; week: string; seconds: number; billable: number }>(
    db,
    `SELECT (app.time_labels(te.project_id, NULL)).project_name AS project, CASE WHEN app.week_start(te.started_at, o.timezone) = $1 THEN 'this_week' ELSE 'last_week' END AS week,
            sum(te.duration_seconds)::int AS seconds, coalesce(sum(te.duration_seconds) FILTER (WHERE te.billable), 0)::int AS billable
       FROM time_entries te JOIN organizations o ON o.id = te.org_id
      WHERE te.user_id = app.uid() AND te.status = 'stopped' AND app.week_start(te.started_at, o.timezone) >= $1::date - 7
      GROUP BY 1, 2`,
    [base.week_start],
  );
  const h = (s: number) => Math.round((s / 3600) * 100) / 100;
  ctx.my_tracked_hours = {
    this_week_total: h(hours.filter((x) => x.week === 'this_week').reduce((a, x) => a + x.seconds, 0)),
    last_week_total: h(hours.filter((x) => x.week === 'last_week').reduce((a, x) => a + x.seconds, 0)),
    by_project: hours.map((x) => ({ project: x.project, week: x.week, hours: h(x.seconds), billable_hours: h(x.billable) })),
  };
  sources.push('Your time entries');

  ctx.my_open_tasks = await query(
    db,
    `SELECT t.title, p.name AS project, t.priority, t.due_date AS due, bc.name AS status,
            (t.due_date < $1::date) AS overdue
       FROM tasks t JOIN projects p ON p.id = t.project_id JOIN board_columns bc ON bc.id = t.column_id
      WHERE t.completed_at IS NULL AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = t.id AND ta.user_id = app.uid())
      ORDER BY t.due_date NULLS LAST LIMIT 40`,
    [base.today],
  );
  sources.push('Tasks assigned to you');

  ctx.projects = await query(
    db,
    `SELECT p.name, p.status, p.priority, p.deadline, (p.deadline < $1::date AND p.status IN ('planning','active','on_hold')) AS overdue,
            (app.project_task_counts(p.id)).total AS tasks, (app.project_task_counts(p.id)).done AS tasks_done,
            p.estimated_hours, round(app.project_tracked_seconds(p.id) / 3600.0, 2) AS tracked_hours,
            (SELECT count(*)::int FROM tasks t WHERE t.project_id = p.id AND t.completed_at IS NULL AND t.due_date < $1::date) AS overdue_tasks
       FROM projects p WHERE p.archived_at IS NULL AND p.status IN ('planning','active','on_hold')
      ORDER BY p.deadline NULLS LAST LIMIT 30`,
    [base.today],
  );
  sources.push('Projects you can see');

  if (auth.permissions.includes('time.approve')) {
    ctx.timesheets_awaiting_my_approval = await query(
      db,
      `SELECT u.full_name AS person, ts.week_start, round(ts.total_seconds / 3600.0, 2) AS hours, ts.submitted_at::date AS submitted
         FROM timesheets ts JOIN users u ON u.id = ts.user_id WHERE ts.org_id = app.org() AND ts.status = 'submitted' AND ts.user_id <> app.uid()
        ORDER BY ts.week_start LIMIT 50`,
    );
    sources.push('Submitted timesheets');
  }
  ctx.my_timesheets = await query(db, 'SELECT week_start, status, round(total_seconds / 3600.0, 2) AS hours, decision_note FROM timesheets WHERE user_id = app.uid() AND org_id = app.org() ORDER BY week_start DESC LIMIT 6');

  const leaveApprover = await one<{ ok: boolean }>(
    db,
    "SELECT app.has_permission('leave.approve') OR EXISTS (SELECT 1 FROM employee_profiles WHERE org_id = app.org() AND manager_id = app.uid()) AS ok",
  );
  if (leaveApprover?.ok) {
    ctx.leave_requests_awaiting_my_decision = await query(
      db,
      `SELECT u.full_name AS person, t.name AS type, l.start_date, l.end_date, l.days FROM leave_requests l JOIN users u ON u.id = l.user_id JOIN leave_types t ON t.id = l.leave_type_id
        WHERE l.org_id = app.org() AND l.status = 'pending' AND l.user_id <> app.uid() AND (app.has_permission('leave.approve') OR app.manages(l.user_id)) LIMIT 50`,
    );
    sources.push('Pending leave requests');
  }

  if (projectId) {
    const visible = await one<{ ok: boolean; name: string }>(db, 'SELECT app.can_view_project(id) AS ok, name FROM projects WHERE id = $1', [projectId]);
    if (!visible?.ok) throw forbidden('You cannot see that project.');
    const posts = await query<{ author: string | null; kind: string; visibility: string; body: string; created: string; comments: number }>(
      db,
      `SELECT u.full_name AS author, f.kind, f.visibility, f.body, to_char(f.created_at AT TIME ZONE o.timezone, 'YYYY-MM-DD HH24:MI') AS created,
              (SELECT count(*)::int FROM feed_comments c WHERE c.post_id = f.id AND c.deleted_at IS NULL) AS comments
         FROM feed_posts f JOIN organizations o ON o.id = f.org_id LEFT JOIN users u ON u.id = f.author_id
        WHERE f.project_id = $1 AND f.deleted_at IS NULL ORDER BY f.created_at DESC LIMIT 20`,
      [projectId],
    );
    ctx.selected_project = {
      name: visible.name,
      latest_updates: posts.map((p) => ({ ...p, body: plainText(p.body).slice(0, 600) })),
      recent_activity: await query(
        db,
        `SELECT summary, to_char(a.created_at AT TIME ZONE o.timezone, 'YYYY-MM-DD HH24:MI') AS at FROM project_activity a JOIN organizations o ON o.id = a.org_id
          WHERE a.project_id = $1 ORDER BY a.id DESC LIMIT 25`,
        [projectId],
      ),
      open_tasks: await query(
        db,
        `SELECT t.title, bc.name AS status, t.priority, t.due_date AS due,
                (SELECT string_agg(u.full_name, ', ') FROM task_assignees ta JOIN users u ON u.id = ta.user_id WHERE ta.task_id = t.id) AS assignees
           FROM tasks t JOIN board_columns bc ON bc.id = t.column_id WHERE t.project_id = $1 AND t.parent_id IS NULL AND t.completed_at IS NULL
          ORDER BY t.due_date NULLS LAST LIMIT 40`,
        [projectId],
      ),
      completed_last_7_days: await query(
        db,
        `SELECT t.title, t.completed_at::date AS completed FROM tasks t WHERE t.project_id = $1 AND t.parent_id IS NULL AND t.completed_at > now() - interval '7 days' ORDER BY t.completed_at DESC LIMIT 30`,
        [projectId],
      ),
    };
    sources.push(`${visible.name}: feed, activity and tasks`);
  }
  return { ctx, sources };
}

// ---------------------------------------------------------------- providers

let anthropic: Anthropic | null = null;

function mapAnthropicError(e: unknown): AppError {
  const op = { service: SERVICE, operation: 'ai.anthropic' };
  if (e instanceof Anthropic.AuthenticationError) return new AppError('CONFIGURATION_ERROR', 'The Anthropic API key was rejected.', { ...op, userMessage: 'The AI assistant’s API key was rejected. Ask an administrator to check the configuration.', internalCode: 'http_401' });
  if (e instanceof Anthropic.PermissionDeniedError) return new AppError('CONFIGURATION_ERROR', 'The API key cannot use this model.', { ...op, userMessage: 'The AI assistant is not allowed to use the configured model.', internalCode: 'http_403' });
  if (e instanceof Anthropic.NotFoundError) return new AppError('CONFIGURATION_ERROR', `The model "${config.ANTHROPIC_MODEL}" is not available.`, { ...op, userMessage: 'The AI assistant’s model is not available. Ask an administrator to check the configuration.', internalCode: 'http_404' });
  if (e instanceof Anthropic.RateLimitError) return new AppError('RATE_LIMITED', 'The AI service is rate limiting requests.', { ...op, userMessage: 'The AI assistant is busy. Please try again in a minute.', internalCode: 'http_429', retryAfterSeconds: 60 });
  if (e instanceof Anthropic.BadRequestError) return new AppError('AI_ERROR', 'The AI service rejected the request.', { ...op, internalCode: 'http_400', retryable: false });
  if (e instanceof Anthropic.InternalServerError) return new AppError('AI_ERROR', 'The AI service is temporarily unavailable.', { ...op, internalCode: `http_${e.status}` });
  if (e instanceof Anthropic.APIConnectionTimeoutError) return new AppError('AI_ERROR', 'The AI service did not respond in time.', { ...op, internalCode: 'timeout', httpStatus: 504 });
  if (e instanceof Anthropic.APIConnectionError) return new AppError('AI_ERROR', 'The AI service could not be reached.', { ...op, internalCode: 'connection' });
  if (e instanceof Anthropic.APIError) return new AppError('AI_ERROR', `The AI service returned HTTP ${e.status ?? 'error'}.`, { ...op, internalCode: `http_${e.status}` });
  return new AppError('AI_ERROR', 'The AI request failed.', { ...op, internalCode: (e as Error)?.name ?? 'unknown' });
}

async function askAnthropic(system: string, user: string): Promise<{ text: string; model: string }> {
  anthropic ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, ...(config.ANTHROPIC_BASE_URL ? { baseURL: config.ANTHROPIC_BASE_URL } : {}), timeout: config.AI_TIMEOUT_MS, maxRetries: 2 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await anthropic.beta.messages.create({
      model: config.ANTHROPIC_MODEL,
      max_tokens: config.AI_MAX_OUTPUT_TOKENS,
      // If a safety classifier declines, the API re-runs the request on a suitable fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system,
      messages: [{ role: 'user', content: user }],
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  } catch (e) {
    throw mapAnthropicError(e);
  }
  if (response.stop_reason === 'refusal') throw new AppError('AI_ERROR', 'The AI model declined to answer.', { service: SERVICE, userMessage: 'The AI assistant declined to answer this question.', internalCode: 'refusal', retryable: false });
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (response.stop_reason === 'max_tokens' && !text) throw new AppError('AI_ERROR', 'The answer was cut off.', { service: SERVICE, internalCode: 'max_tokens' });
  return { text, model: response.model };
}

// The same options for the warm-up and every request: a different context size makes Ollama reload the model.
const OLLAMA_OPTIONS = { temperature: 0.1, num_predict: Math.min(config.AI_MAX_OUTPUT_TOKENS, 1200), num_ctx: 8192 };
// Loading a model from disk can take minutes on a CPU-only machine; keep it in memory between questions.
const OLLAMA_KEEP_ALIVE = config.OLLAMA_KEEP_ALIVE;

/** Loads the local model in the background at start-up so the first question is not slowed by it. */
export function warmUpAi(): void {
  if (config.ai.provider !== 'ollama' || !config.AI_WARMUP) return;
  const started = Date.now();
  fetch(new URL('/api/chat', config.OLLAMA_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10 * 60_000),
    body: JSON.stringify({ model: config.OLLAMA_MODEL, stream: false, keep_alive: OLLAMA_KEEP_ALIVE, options: { ...OLLAMA_OPTIONS, num_predict: 1 }, messages: [{ role: 'user', content: 'ok' }] }),
  })
    .then((r) => log.info('ai.warmed_up', { provider: 'ollama', model: config.OLLAMA_MODEL, ok: r.ok, seconds: Math.round((Date.now() - started) / 1000) }))
    .catch((e) => log.warn('ai.warm_up_failed', { category: 'AI_ERROR', message: (e as Error).message }));
}

async function askOllama(system: string, user: string): Promise<{ text: string; model: string }> {
  let res: Response;
  try {
    res = await fetch(new URL('/api/chat', config.OLLAMA_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(config.AI_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.OLLAMA_MODEL,
        stream: false,
        options: OLLAMA_OPTIONS,
        keep_alive: OLLAMA_KEEP_ALIVE,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') throw new AppError('AI_ERROR', 'The local AI model did not answer in time.', { service: SERVICE, internalCode: 'timeout', httpStatus: 504 });
    throw new AppError('AI_ERROR', 'The local AI service (Ollama) is not running or cannot be reached.', { service: SERVICE, userMessage: 'The AI assistant’s local model service is not running. Ask an administrator to start it.', internalCode: 'connection' });
  }
  const body = (await res.json().catch(() => null)) as { message?: { content?: string }; error?: string } | null;
  if (res.status === 404) throw new AppError('CONFIGURATION_ERROR', `The local model "${config.OLLAMA_MODEL}" is not installed.`, { service: SERVICE, userMessage: 'The AI assistant’s local model is not installed.', internalCode: 'model_missing' });
  if (!res.ok) throw new AppError('AI_ERROR', `The local AI service returned HTTP ${res.status}.`, { service: SERVICE, internalCode: `http_${res.status}` });
  const text = body?.message?.content?.trim() ?? '';
  return { text, model: config.OLLAMA_MODEL };
}

// ---------------------------------------------------------------- routes

aiRouter.get('/status', (_req, res) => {
  ok(res, { configured: config.ai.configured, provider: config.ai.provider, model: config.ai.model, issue: config.ai.configured ? null : config.ai.issue });
});

aiRouter.get('/history', async (req, res) => {
  const rows = await read(req, (db) =>
    query<{ id: string; question: string; answer: string; provider: string; model: string; sources: string[]; created_at: string }>(
      db,
      "SELECT id, question, answer, provider, model, sources, created_at FROM ai_requests WHERE user_id = app.uid() AND org_id = app.org() AND status = 'answered' ORDER BY created_at DESC LIMIT 30",
    ),
  );
  ok(res, rows.map((r): AiAnswerDTO => ({ id: r.id, question: r.question, answer: r.answer, provider: r.provider, model: r.model, sources: r.sources, createdAt: r.created_at })));
});

aiRouter.post('/ask', async (req, res) => {
  const b = parse(z.object({ question: z.string().trim().min(3, 'Ask a question.').max(2000, 'Keep the question under 2,000 characters.'), projectId: zUuid().optional() }), req.body);
  if (!config.ai.configured) {
    throw new AppError('CONFIGURATION_ERROR', config.ai.issue ?? 'AI is not configured.', {
      service: SERVICE,
      userMessage: 'The AI assistant is not configured on this server, so no answer can be given. An administrator can set AI_PROVIDER (and an API key) in the server settings.',
    });
  }
  const started = Date.now();
  const { ctx, sources } = await read(req, (db) => buildContext(db, req, b.projectId ?? null));
  const user = `DATA (JSON):\n${JSON.stringify(ctx)}\n\nQUESTION:\n${b.question}`;
  const provider = config.ai.provider!;
  let answer: { text: string; model: string };
  try {
    answer = provider === 'anthropic' ? await askAnthropic(SYSTEM, user) : await askOllama(SYSTEM, user);
    if (!answer.text) throw new AppError('AI_ERROR', 'The AI service returned an empty answer.', { service: SERVICE, internalCode: 'empty' });
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('AI_ERROR', 'The AI request failed.', { service: SERVICE, cause: e });
    log.warn('ai.failed', { category: err.code, internalCode: err.internalCode, provider });
    await tx(req, (db) =>
      query(db, "INSERT INTO ai_requests (org_id, user_id, project_id, question, status, error_code, provider, model, duration_ms) VALUES (app.org(), app.uid(), $1, $2, 'failed', $3, $4, $5, $6)", [
        b.projectId ?? null,
        b.question,
        err.code,
        provider,
        config.ai.model,
        Date.now() - started,
      ]),
    ).catch(() => {});
    throw err;
  }
  const row = await tx(req, (db) =>
    one<{ id: string; created_at: string }>(
      db,
      "INSERT INTO ai_requests (org_id, user_id, project_id, question, answer, status, provider, model, sources, duration_ms) VALUES (app.org(), app.uid(), $1, $2, $3, 'answered', $4, $5, $6, $7) RETURNING id, created_at",
      [b.projectId ?? null, b.question, answer.text.slice(0, 20000), provider, answer.model, JSON.stringify(sources), Date.now() - started],
    ),
  );
  const body: AiAnswerDTO = { id: row!.id, question: b.question, answer: answer.text, provider, model: answer.model, sources, createdAt: row!.created_at };
  ok(res, body);
});
