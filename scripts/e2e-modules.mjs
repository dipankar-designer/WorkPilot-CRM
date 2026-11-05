// Browser end-to-end check of the Phase 2–6 modules with four real people in separate browsers:
// an owner (Priya), a project manager (Arjun), a team member (Neha) and a client (Chloe).
// Covers clients, projects, the Kanban board (drag-and-drop and keyboard), tasks, the project
// feed (internal vs client-visible, live comments), files, chat (live delivery and read
// receipts), the timer across a reload, timesheets and approval, attendance, leave approval, HR
// records, reports with CSV, the dashboard and the AI assistant. axe-core runs on every page and
// every page is checked for horizontal overflow at 390px.
//
//   node scripts/e2e-modules.mjs [appUrl]          (set E2E_AI=0 to skip the slow local AI answer)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/package.json'));
const APP = process.argv[2] || 'http://localhost:5290';
const SHOTS = process.argv[3] || '';
const RUN_AI = process.env.E2E_AI !== '0';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`);
};
const soon = (p) => p.then(() => true, () => false);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const consoleErrors = [];
const pages = [];
async function person(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && !/status of 4\d\d/.test(m.text()) && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.message));
  p.on('dialog', (d) => void d.accept());
  pages.push(p);
  return p;
}
const shot = async (p, name) => SHOTS && p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }).catch(() => {});

async function axeCheck(p, label) {
  await p.evaluate(AXE);
  const r = await p.evaluate(() => window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } }));
  const v = r.violations.map((x) => `${x.id}(${x.nodes.length}): ${x.nodes[0]?.target.join(' ')}`);
  check(`axe WCAG A/AA: ${label}`, v.length === 0, v.join(' | '));
}

async function noOverflow(p, label) {
  const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  check(`no horizontal overflow at ${o.cw}px: ${label}`, o.sw <= o.cw, `${o.sw} > ${o.cw}`);
}

/** Calls the API from the page with its session (setup steps only). */
async function api(p, method, url, body) {
  return p.evaluate(
    async ({ method, url, body }) => {
      const s = await (await fetch('/api/auth/session')).json();
      const r = await fetch(`/api${url}`, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.data?.csrfToken ?? '' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    { method, url, body },
  );
}

const ymd = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const inDays = (n) => ymd(new Date(now.getTime() + n * 86400_000));
const lastMonday = (() => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7);
  return ymd(d);
})();
const futureMonday = (() => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + 21 + ((8 - d.getUTCDay()) % 7));
  return ymd(d);
})();
const stamp = Date.now().toString(36);
const PASSWORD = 'a-long-e2e-password';

try {
  // ================================================================ setup: an organisation with four people
  const priya = await person();
  await priya.goto(`${APP}/signup`);
  await priya.getByLabel('Your name').fill('Priya Sharma');
  await priya.getByLabel('Work email').fill(`priya-${stamp}@example.test`);
  await priya.getByLabel('Password').fill(PASSWORD);
  await priya.getByLabel('Organisation name').fill(`Brightpath ${stamp}`);
  await priya.getByLabel('Organisation timezone').selectOption('Asia/Kolkata');
  await priya.getByRole('button', { name: 'Create organisation' }).click();
  await priya.waitForURL(/dashboard/);

  async function join(roles, name, emailPrefix) {
    const inv = await api(priya, 'POST', '/org/invitations', { email: `${emailPrefix}-${stamp}@example.test`, roles });
    const p = await person();
    await p.goto(inv.body.data.acceptUrl);
    await p.getByLabel('Your name').fill(name);
    await p.getByLabel('Password').fill(PASSWORD);
    await p.getByRole('button', { name: 'Create account and join' }).click();
    await p.waitForURL(/dashboard/);
    return p;
  }
  const arjun = await join(['project_manager'], 'Arjun Mehta', 'arjun');
  const neha = await join(['member'], 'Neha Kapoor', 'neha');
  const chloe = await join(['client'], 'Chloe Byrne', 'chloe');
  check('four people in one organisation (owner, project manager, member, client)', true);

  // ================================================================ clients
  await priya.goto(`${APP}/clients`);
  await priya.getByRole('button', { name: 'New client' }).click();
  const dlg = priya.getByRole('dialog');
  await dlg.getByLabel('Company name').fill('Acme Retail');
  await dlg.getByLabel('Contact person').fill('Ann Client');
  await dlg.getByLabel('Email').fill('ann@acme.example');
  await dlg.getByRole('button', { name: 'Add client' }).click();
  check('a client company is added', await soon(priya.getByRole('row', { name: /Acme Retail/ }).waitFor()));
  await axeCheck(priya, 'clients');

  // ================================================================ projects
  await arjun.goto(`${APP}/projects`);
  await arjun.getByRole('button', { name: 'New project' }).click();
  const pd = arjun.getByRole('dialog');
  await pd.getByLabel('Project name').fill('Website relaunch');
  await pd.getByLabel('Description').fill('New storefront for Acme Retail.');
  await pd.getByLabel('Client', { exact: true }).selectOption({ label: 'Acme Retail' });
  await pd.getByLabel('Deadline').fill(inDays(30));
  await pd.getByLabel('Estimated hours').fill('40');
  await pd.getByLabel('Budget (optional)').fill('250000');
  await pd.getByLabel('Neha Kapoor').check();
  await pd.getByLabel('Priya Sharma').check();
  await axeCheck(arjun, 'new project dialog');
  await pd.getByRole('button', { name: 'Create project' }).click();
  await arjun.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  const projectUrl = arjun.url();
  check('the project manager creates a project and lands in its workspace', await soon(arjun.getByRole('heading', { level: 1, name: 'Website relaunch' }).waitFor()));
  const tabs = await arjun.getByRole('navigation', { name: 'Project sections' }).getByRole('link').allTextContents();
  check('the workspace has all nine sections', ['Overview', 'Feed', 'Board', 'Tasks', 'Chat', 'Files', 'Time & Reports', 'Members', 'Settings'].every((t) => tabs.includes(t)), tabs.join(', '));
  check('the sidebar lists it under My Projects', await soon(arjun.locator('.my-projects').getByText('Website relaunch').waitFor()));
  await axeCheck(arjun, 'project overview');
  await shot(arjun, 'm01-project');

  // ================================================================ board
  await arjun.goto(`${projectUrl}/board`);
  const col = (name) => arjun.locator('.board-col', { has: arjun.getByRole('heading', { name, exact: true }) });
  const card = (column, title) => col(column).locator('.task-card-title', { hasText: title });
  for (const title of ['Design homepage', 'Build header']) {
    // The quick-add form stays open after each task for rapid entry.
    await col('To Do').locator('.board-cards').waitFor();
    if (!(await col('To Do').getByLabel('Task title').isVisible())) await col('To Do').getByRole('button', { name: 'Add task' }).click();
    await col('To Do').getByLabel('Task title').fill(title);
    await col('To Do').getByRole('button', { name: 'Add', exact: true }).click();
    await card('To Do', title).waitFor();
  }
  check('tasks are added to a column', (await col('To Do').locator('.task-card').count()) === 2);
  check('live updates are connected', await soon(arjun.locator('.live-status-on').waitFor({ timeout: 10_000 })));
  // Wait for the save to finish before reloading, as a person would see the board settle.
  const saved1 = arjun.waitForResponse((r) => r.url().endsWith('/move') && r.request().method() === 'POST');
  await arjun.locator('[data-card-id]', { hasText: 'Build header' }).dragTo(col('In Progress').locator('.board-cards'));
  check('the drag-and-drop move is saved by the server', (await saved1).status() === 200);
  await card('In Progress', 'Build header').waitFor({ timeout: 10_000 });
  await arjun.reload();
  check('drag-and-drop moves a task and the move persists after reload', await soon(card('In Progress', 'Build header').waitFor({ timeout: 10_000 })));
  const saved2 = arjun.waitForResponse((r) => r.url().endsWith('/move') && r.request().method() === 'POST');
  await arjun.getByLabel('Move “Design homepage” to').selectOption({ label: 'In Review' });
  check('the keyboard move is saved by the server', (await saved2).status() === 200);
  await card('In Review', 'Design homepage').waitFor();
  await arjun.reload();
  check('the keyboard "Move to" control moves a task and persists', await soon(card('In Review', 'Design homepage').waitFor({ timeout: 10_000 })));
  await axeCheck(arjun, 'board');
  await shot(arjun, 'm02-board');

  await arjun.getByRole('button', { name: 'Design homepage' }).click();
  const td = arjun.getByRole('dialog');
  await td.getByLabel('Neha Kapoor', { exact: true }).check();
  await td.getByText('Neha Kapoor').first().waitFor();
  await td.getByLabel('New subtask').fill('Hero banner');
  await td.getByRole('button', { name: 'Add', exact: true }).first().click();
  await td.getByText('Hero banner', { exact: true }).waitFor();
  await td.getByLabel('Add a comment').fill('@Neh');
  await td.getByRole('option', { name: 'Neha Kapoor' }).click();
  await td.getByLabel('Add a comment').pressSequentially('please start with the hero');
  await td.getByRole('button', { name: 'Comment', exact: true }).click();
  check('task details: assignee, subtask and a comment with an @mention', await soon(td.locator('.mention', { hasText: '@Neha Kapoor' }).waitFor()));
  await axeCheck(arjun, 'task dialog');
  await td.getByRole('button', { name: 'Close dialog' }).click();

  await neha.goto(`${APP}/tasks`);
  check('the assignee sees the task in My Tasks', await soon(neha.getByRole('link', { name: 'Design homepage' }).waitFor()));
  check('the assignee was notified (bell count)', Number((await neha.locator('.bell-count').textContent({ timeout: 10_000 }).catch(() => '0')) ?? 0) >= 2);
  await axeCheck(neha, 'my tasks');

  // ================================================================ members and the feed
  await arjun.goto(`${projectUrl}/members`);
  await arjun.getByLabel('Person').selectOption({ label: 'Chloe Byrne (client)' });
  await arjun.getByRole('button', { name: 'Add to project' }).click();
  check('the client is given access to the project', await soon(arjun.getByText('Chloe Byrne').first().waitFor()));
  await axeCheck(arjun, 'project members');

  await arjun.goto(`${projectUrl}/feed`);
  await arjun.getByLabel('Share an update').fill('Internal: the estimate is tight, keep scope fixed.');
  await arjun.getByRole('button', { name: 'Post', exact: true }).click();
  await arjun.locator('article', { hasText: 'Internal: the estimate is tight' }).waitFor();
  await arjun.getByLabel('Who can see it').selectOption('client');
  await arjun.getByLabel('Share an update').fill('Hello Chloe, the first designs arrive on Friday.');
  await arjun.getByRole('button', { name: 'Post', exact: true }).click();
  await arjun.locator('article', { hasText: 'Hello Chloe, the first designs' }).waitFor();
  await axeCheck(arjun, 'feed');

  await chloe.goto(`${projectUrl}/feed`);
  await chloe.getByText('Hello Chloe, the first designs').waitFor();
  check('the client sees client-visible updates only', (await chloe.getByText('Internal: the estimate is tight').count()) === 0);
  await axeCheck(chloe, 'feed as client');
  const post = chloe.locator('article', { hasText: 'Hello Chloe' });
  await post.getByRole('button', { name: /React with 🎉/ }).click();
  await post.getByLabel('Write a comment').fill('Looks great, thank you!');
  await post.getByRole('button', { name: 'Comment', exact: true }).click();
  await post.getByText('Looks great, thank you!').waitFor();
  check('the client reacts and comments', true);
  check('the manager sees the client’s comment live, without reloading', await soon(arjun.getByText('Looks great, thank you!').waitFor({ timeout: 10_000 })));
  await arjun.locator('article', { hasText: 'Hello Chloe' }).getByRole('button', { name: 'Pin' }).click();
  await chloe.reload();
  check('a pinned update shows as pinned to the client', await soon(chloe.locator('article', { hasText: 'Hello Chloe' }).getByText('Pinned').waitFor()));
  await shot(chloe, 'm03-feed-client');

  // ================================================================ files
  await arjun.goto(`${projectUrl}/files`);
  await arjun.getByLabel('Who can see them').selectOption('client');
  await arjun.locator('input[type=file]').setInputFiles({ name: 'brief.txt', mimeType: 'text/plain', buffer: Buffer.from('Project brief for Acme') });
  await arjun.getByRole('link', { name: /brief\.txt/ }).waitFor();
  await arjun.getByLabel('Who can see them').selectOption('internal');
  await arjun.locator('input[type=file]').setInputFiles({ name: 'budget.txt', mimeType: 'text/plain', buffer: Buffer.from('Internal budget') });
  await arjun.getByRole('link', { name: /budget\.txt/ }).waitFor();
  check('files are uploaded with internal or client visibility', true);
  await axeCheck(arjun, 'files');
  await chloe.goto(`${projectUrl}/files`);
  await chloe.getByRole('link', { name: /brief\.txt/ }).waitFor();
  check('the client sees only files shared with them', (await chloe.getByText('budget.txt').count()) === 0);
  const href = await chloe.getByRole('link', { name: /brief\.txt/ }).getAttribute('href');
  const dl = await chloe.request.get(`${APP}${href}`);
  check('the client can download the shared file', dl.status() === 200 && (await dl.text()) === 'Project brief for Acme');

  // ================================================================ chat
  await arjun.goto(`${projectUrl}/chat`);
  await arjun.getByLabel('Message', { exact: true }).fill('Kick-off tomorrow at 10:00');
  await arjun.keyboard.press('Enter');
  await arjun.locator('.msg', { hasText: 'Kick-off tomorrow at 10:00' }).waitFor();
  await neha.goto(`${APP}/chat`);
  await neha.getByRole('button', { name: /Website relaunch — team/ }).click();
  check('a team member receives the project chat message', await soon(neha.getByText('Kick-off tomorrow at 10:00').waitFor()));
  check('the sender sees a read receipt', await soon(arjun.getByText(/Seen by Neha/).waitFor({ timeout: 10_000 })));
  await neha.getByLabel('Message', { exact: true }).fill('On it');
  await neha.keyboard.press('Enter');
  check('replies arrive live for the other person', await soon(arjun.locator('.msg', { hasText: 'On it' }).waitFor({ timeout: 10_000 })));
  await axeCheck(neha, 'team chat');
  await shot(neha, 'm04-chat');
  await chloe.goto(`${APP}/chat`);
  await chloe.waitForLoadState('networkidle');
  check('the client cannot see the internal team channel', (await chloe.getByRole('button', { name: /Website relaunch — team/ }).count()) === 0);

  // ================================================================ time tracking
  await neha.goto(`${APP}/time`);
  await neha.getByLabel('Project', { exact: true }).first().selectOption({ label: 'Website relaunch' });
  await neha.getByLabel('Task (optional)').first().selectOption({ label: 'Design homepage' });
  await neha.getByLabel('Description (optional)').first().fill('Hero layout');
  await neha.getByRole('button', { name: 'Start timer' }).last().click();
  await neha.locator('.timer-big').waitFor();
  await neha.waitForTimeout(2500);
  await neha.reload();
  const chip = await neha.locator('.timer-chip-time').textContent({ timeout: 10_000 }).catch(() => '');
  check('the timer keeps running across a page reload', /0:00:0[2-9]|0:00:[1-5]\d/.test(chip ?? ''), chip ?? '');
  await axeCheck(neha, 'time tracker (running)');
  await neha.getByRole('button', { name: 'Stop and save' }).click();
  await neha.getByText('Time saved').waitFor();
  check('stopping saves an entry in today’s list', await soon(neha.locator('table', { hasText: 'Website relaunch' }).waitFor()));

  await neha.getByLabel('Project', { exact: true }).last().selectOption({ label: 'Website relaunch' });
  await neha.getByLabel('Date').fill(lastMonday);
  await neha.getByLabel('Start').fill('09:00');
  await neha.getByLabel('End').fill('12:30');
  await neha.getByRole('button', { name: 'Add entry' }).click();
  await neha.getByText('Time entry added').waitFor();
  await neha.getByRole('tab', { name: 'My week' }).click();
  await neha.getByRole('button', { name: 'Previous week' }).click();
  await neha.getByRole('button', { name: 'Submit timesheet' }).click();
  const submitted = await soon(neha.getByText('Awaiting approval', { exact: true }).waitFor());
  check('a week is submitted for approval', submitted, submitted ? '' : (await neha.locator('[role=alert]').allTextContents()).join(' | ') || 'no error shown');
  if (!submitted) await shot(neha, 'week-not-submitted');
  await axeCheck(neha, 'my week');

  await arjun.goto(`${APP}/time?tab=approvals`);
  await arjun.getByRole('button', { name: /Review Neha Kapoor’s timesheet/ }).click();
  await arjun.getByRole('dialog').getByText('3:30').first().waitFor();
  await axeCheck(arjun, 'timesheet review');
  await arjun.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await arjun.getByText('Timesheet approved').waitFor();
  await neha.reload();
  await neha.getByRole('tab', { name: 'My week' }).click();
  await neha.getByRole('button', { name: 'Previous week' }).click();
  check('the approver approves and the week is locked for the employee', await soon(neha.getByText(/This week can no longer be changed/).waitFor()));

  // ================================================================ attendance and leave
  await neha.goto(`${APP}/attendance`);
  await neha.getByRole('button', { name: 'Check in' }).click();
  await neha.getByRole('button', { name: 'Check out' }).click();
  check('check-in and check-out are recorded', await soon(neha.getByText('You have finished for today.').waitFor()));
  await axeCheck(neha, 'attendance');
  await neha.getByRole('tab', { name: 'My leave' }).click();
  await neha.getByLabel('Leave type').selectOption({ label: 'Annual leave' });
  await neha.getByRole('textbox', { name: 'From date', exact: true }).fill(futureMonday);
  await neha.getByRole('textbox', { name: 'To date', exact: true }).fill(inDaysFrom(futureMonday, 1));
  check('the leave form shows the days before applying', await soon(neha.locator('.leave-summary').getByText('2 day(s)').waitFor()));
  await neha.getByRole('button', { name: 'Apply', exact: true }).click();
  check('leave is requested with working days counted', await soon(neha.getByText('Requested 2 day(s) of Annual leave').waitFor()));
  await axeCheck(neha, 'my leave');
  await priya.goto(`${APP}/attendance?tab=approvals`);
  await priya.getByRole('button', { name: 'Approve' }).first().click();
  await priya.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await priya.getByText('Leave approved').waitFor();
  await neha.reload();
  check('HR approves and the employee sees it', await soon(neha.locator('.list-item', { hasText: 'Annual leave' }).getByText('approved').waitFor()));

  // ================================================================ people and HR
  await priya.goto(`${APP}/people?tab=departments`);
  await priya.getByLabel('Name').fill('Engineering');
  await priya.getByRole('button', { name: 'Add department' }).click();
  await priya.getByText('Department added').waitFor();
  await priya.goto(`${APP}/people`);
  await priya.getByRole('link', { name: 'Neha Kapoor' }).click();
  await priya.getByLabel('Department').selectOption({ label: 'Engineering' });
  await priya.getByLabel('Reports to').selectOption({ label: 'Arjun Mehta' });
  await priya.getByRole('button', { name: 'Save record' }).click();
  await priya.getByText('Employee record saved').waitFor();
  await priya.getByLabel('Notes').fill('Strong first month.');
  await priya.getByRole('button', { name: 'Save notes' }).click();
  await priya.getByText('HR notes saved').waitFor();
  check('HR updates the employee record and HR notes', true);
  await axeCheck(priya, 'employee profile');
  await neha.goto(`${APP}/people`);
  await neha.getByRole('link', { name: 'Neha Kapoor' }).click();
  await neha.getByRole('heading', { name: 'Personal details' }).waitFor();
  check('the employee never sees HR notes about them', (await neha.getByText('Strong first month.').count()) === 0 && (await neha.getByRole('heading', { name: 'HR notes' }).count()) === 0);

  // ================================================================ reports and dashboard
  await priya.goto(`${APP}/reports?kind=time_by_person`);
  check('reports compute tracked hours per person', await soon(priya.getByRole('row', { name: /Neha Kapoor/ }).waitFor()));
  await axeCheck(priya, 'reports');
  const csvHref = await priya.getByRole('link', { name: 'Export CSV' }).getAttribute('href');
  const csv = await priya.request.get(`${APP}${csvHref}`);
  check('reports export as CSV', csv.status() === 200 && (csv.headers()['content-type'] ?? '').includes('text/csv') && (await csv.text()).includes('Neha Kapoor'));
  await priya.goto(`${APP}/dashboard`);
  await priya.locator('.stat', { hasText: 'Active projects' }).waitFor();
  check('the dashboard counts the active project', (await priya.locator('.stat', { hasText: 'Active projects' }).locator('.stat-value').textContent()) === '1');
  check('the dashboard lists the project with progress', await soon(priya.locator('.project-progress').getByText('Website relaunch').waitFor()));
  await axeCheck(priya, 'dashboard with data');
  await shot(priya, 'm05-dashboard');
  await neha.goto(`${APP}/dashboard`);
  check('the dashboard greets the person by time of day', await soon(neha.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Neha$/ }).waitFor()));
  check('the dashboard shows today with a live clock and the attendance state', await soon(neha.locator('.home-today').getByText('Finished for today').waitFor()) && /\d\d : \d\d : \d\d/.test((await neha.locator('.home-clock').textContent()) ?? ''));
  check('the dashboard shows the real leave balance', await soon(neha.locator('.home-leave-list li', { hasText: 'Annual leave' }).getByText('16 / 18').waitFor()));
  check('the time tracker can be switched on from the dashboard', await neha.getByRole('button', { name: 'Switch on tracker' }).isVisible().catch(() => false) || (await neha.getByRole('button', { name: 'Switch off and save' }).isVisible().catch(() => false)));
  await axeCheck(neha, 'dashboard home');
  await shot(neha, 'm06-dashboard-home');

  // ================================================================ AI assistant
  await neha.goto(`${APP}/assistant`);
  await axeCheck(neha, 'assistant');
  const configured = (await neha.getByText(/not configured on this server/).count()) === 0;
  if (!configured) {
    check('the assistant states that it is not configured instead of answering', true);
  } else if (RUN_AI) {
    await neha.getByLabel('Your question').fill('How many hours did I track last week? Answer with the number.');
    await neha.getByRole('button', { name: 'Ask', exact: true }).click();
    const answered = await soon(neha.locator('.qa-a').last().waitFor({ timeout: 450_000 }));
    const answer = answered ? await neha.locator('.qa-a').last().textContent() : '';
    check('the assistant answers from the user’s own data (local model)', answered && /3[.,:]5|3 hours 30|three and a half|3h 30|3:30/i.test(answer ?? ''), (answer ?? '').slice(0, 200));
  }

  // ================================================================ phone width
  const phone = await person({ width: 390, height: 844 });
  await phone.goto(`${APP}/signin`);
  await phone.getByLabel('Email address').fill(`priya-${stamp}@example.test`);
  await phone.getByLabel('Password').fill(PASSWORD);
  await phone.getByRole('button', { name: 'Sign in' }).click();
  await phone.waitForURL(/dashboard/);
  for (const p of ['/dashboard', '/projects', `${projectUrl.replace(APP, '')}/board`, `${projectUrl.replace(APP, '')}/feed`, '/time', '/chat', '/attendance', '/attendance?tab=leave', '/people', '/reports', '/clients', '/assistant', '/notifications']) {
    await phone.goto(`${APP}${p}`);
    await phone.waitForLoadState('networkidle');
    await noOverflow(phone, p);
  }

  check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('journey completed without an exception', false, e.message.split('\n').slice(0, 14).join(' '));
  // Evidence for diagnosis: every open browser at the moment of failure.
  const dir = SHOTS || 'e2e-shots';
  fs.mkdirSync(dir, { recursive: true });
  for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(dir, `failure-${i}.png`), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}

function inDaysFrom(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
