import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { Router } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { AppError, toAppError } from './errors/AppError.js';
import { correlation, errorBody, errorHandler, ok } from './http/respond.js';
import { loadSession, originCheck, requireAuth, requireOrg } from './auth/session.js';
import { appPool, systemPool } from './db/pool.js';
import { authRouter } from './routes/auth.js';
import { orgRouter } from './routes/org.js';
import { meRouter } from './routes/me.js';
import { dashboardRouter } from './routes/dashboard.js';
import { adminRouter } from './routes/admin.js';
import { projectsRouter } from './routes/projects.js';
import { tasksRouter } from './routes/tasks.js';
import { filesRouter } from './routes/files.js';
import { timeRouter } from './routes/time.js';
import { clientsRouter } from './routes/clients.js';
import { feedRouter } from './routes/feed.js';
import { chatRouter } from './routes/chat.js';
import { notificationsRouter } from './routes/notifications.js';
import { hrRouter } from './routes/hr.js';
import { attendanceRouter } from './routes/attendance.js';
import { leaveRouter } from './routes/leave.js';
import { reportsRouter } from './routes/reports.js';
import { aiRouter } from './routes/ai.js';

/** requireOrg for requests under the given path prefixes only. */
function requireOrgFor(prefixes: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => (prefixes.some((p) => req.path.startsWith(p)) ? requireOrg(req, res, next) : next());
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(correlation);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'", 'data:'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  const api = Router();
  // Parsed inside the API router so malformed or oversized bodies get the standard error envelope.
  // File uploads stream their raw body to storage; everything else is JSON.
  const json = express.json({ limit: '200kb' });
  api.use((req, res, next) => (req.path === '/files/upload' ? next() : json(req, res, next)));
  // Two limits: a coarse one per IP address (a whole office can share one), and a per-person one
  // once the session is verified, so one busy browser cannot use up colleagues' allowance.
  const limiter = (limit: number, keyGenerator?: (req: express.Request) => string) =>
    rateLimit({
      windowMs: 60_000,
      limit: config.isTest ? 100_000 : limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      ...(keyGenerator ? { keyGenerator } : {}),
      handler: (req, res) => {
        res.setHeader('Retry-After', '60');
        res.status(429).json(errorBody(new AppError('RATE_LIMITED', 'Too many requests.', { retryAfterSeconds: 60 }), req.correlationId));
      },
    });
  api.use(limiter(config.API_IP_RATE_LIMIT));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use(originCheck);

  api.get('/health', async (_req, res) => {
    try {
      await Promise.all([systemPool.query('SELECT 1'), appPool.query('SELECT 1')]);
    } catch (e) {
      throw toAppError(e, { service: 'Database', operation: 'health' });
    }
    ok(res, { status: 'ok', database: 'ok', time: new Date().toISOString() });
  });
  api.use('/auth', authRouter);

  const authed = Router();
  authed.use(loadSession, requireAuth, limiter(config.API_USER_RATE_LIMIT, (req) => `user:${req.auth!.user.id}`));
  authed.use('/me', meRouter);
  authed.use('/admin', adminRouter);
  authed.use('/org', requireOrg, orgRouter);
  authed.use('/dashboard', requireOrg, dashboardRouter);
  authed.use('/projects', requireOrg, projectsRouter);
  authed.use('/clients', requireOrg, clientsRouter);
  authed.use('/time', requireOrg, timeRouter);
  authed.use('/chat', requireOrg, chatRouter);
  authed.use('/notifications', requireOrg, notificationsRouter);
  authed.use('/hr', requireOrg, hrRouter);
  authed.use('/attendance', requireOrg, attendanceRouter);
  authed.use('/leave', requireOrg, leaveRouter);
  authed.use('/reports', requireOrg, reportsRouter);
  authed.use('/ai', requireOrg, aiRouter);
  // Routers whose paths span several prefixes (/projects/:id/board, /tasks/:id, /files/:id, /feed/:id).
  authed.use(requireOrgFor(['/projects/', '/tasks', '/columns/', '/labels/', '/task-comments/', '/files', '/feed']), tasksRouter, filesRouter, feedRouter);
  api.use(authed);
  api.use((_req, _res, next) => next(new AppError('RESOURCE_NOT_FOUND', 'Unknown API endpoint.', { userMessage: 'That API endpoint does not exist.' })));
  api.use(errorHandler);
  app.use('/api', api);

  // Production: serve the built web client from the same origin.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const clientDist = [path.resolve(here, '../../client/dist'), path.resolve(here, '../client/dist')].find((p) => fs.existsSync(path.join(p, 'index.html')));
  if (clientDist) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }
  return app;
}
