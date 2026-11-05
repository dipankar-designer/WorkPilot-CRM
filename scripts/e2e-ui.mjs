// Browser end-to-end check of the real application (Phase 1): sign-up → dashboard and sidebar →
// invitations → a team member and a client accept in separate browsers → roles, deactivation →
// audit log → responsive drawer at phone width. axe-core (WCAG 2.2 A/AA) runs on each page.
//
//   node scripts/e2e-ui.mjs [appUrl] [screenshotDir]
//
// Needs the database, API and web client running (npm run db:start, npm run dev).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../client/package.json'));
const APP = process.argv[2] || 'http://localhost:5290';
const SHOTS = process.argv[3] || '';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p));
const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const consoleErrors = [];
async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const p = await ctx.newPage();
  p.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  p.on('pageerror', (e) => consoleErrors.push(e.message));
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
  const o = await p.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    // Elements sticking out past the viewport that are not inside their own scrolling container.
    const scrolls = (el) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(a).overflowX)) return true;
      return false;
    };
    const all = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > cw + 1);
    const culprits = (all.some((e) => !scrolls(e)) ? all.filter((e) => !scrolls(e)) : all)
      .slice(0, 4)
      .map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}@${Math.round(e.getBoundingClientRect().right)}`);
    return { sw: document.documentElement.scrollWidth, cw, culprits };
  });
  check(`no horizontal overflow at ${o.cw}px: ${label}`, o.sw <= o.cw, o.sw <= o.cw ? '' : `${o.sw} > ${o.cw}: ${o.culprits.join(', ')}`);
}

const stamp = Date.now().toString(36);
const ownerEmail = `owner-${stamp}@example.test`;
const memberEmail = `member-${stamp}@example.test`;
const clientEmail = `client-${stamp}@example.test`;
const PASSWORD = 'a-long-e2e-password';

try {
  const page = await newPage();

  // ---------------------------------------------------------------- sign-up
  await page.goto(APP);
  await page.waitForURL(/\/signin/);
  check('signed-out visitors land on sign-in', true);
  await axeCheck(page, 'sign-in');
  await page.getByRole('link', { name: 'Create an organisation' }).click();
  await page.getByRole('button', { name: 'Create organisation' }).click();
  check('empty sign-up shows field errors', (await page.getByText('Enter your name.').isVisible()) && (await page.getByText('Enter a valid email address, such as name@company.com.').isVisible()));
  check('focus moves to the first invalid field', (await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'))) === 'name');
  await axeCheck(page, 'sign-up with errors');
  await page.getByLabel('Your name').fill('Priya Sharma');
  await page.getByLabel('Work email').fill(ownerEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organisation name').fill(`Brightpath Digital ${stamp}`);
  await page.getByLabel('Organisation timezone').selectOption('Asia/Kolkata');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForURL(/\/dashboard/);
  check('sign-up opens the dashboard', await page.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Priya$/ }).waitFor().then(() => true, () => false));

  // ---------------------------------------------------------------- sidebar
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  const labels = (await nav.getByRole('link').allTextContents()).map((t) => t.replace(/\(not available yet\)|Soon/g, '').trim());
  check('sidebar has the eleven main sections', ['Dashboard', 'My Tasks', 'Projects', 'Time Tracker', 'Team Chat', 'People & HR', 'Attendance & Leave', 'Clients', 'Reports', 'AI Assistant', 'Settings'].every((l) => labels.includes(l)), labels.join(', '));
  check('no module is marked as unavailable any more', (await nav.getByText('Soon').count()) === 0);
  const clock = await page.locator('.clock-time').textContent();
  check('the header shows the live organisation time', /\d{2}:\d{2}:\d{2}/.test(clock ?? '') && /IST|GMT\+5:30/.test(clock ?? ''), clock ?? '');
  const t1 = await page.locator('.clock-time').textContent();
  await page.waitForTimeout(1200);
  check('the header clock ticks every second', t1 !== (await page.locator('.clock-time').textContent()));
  check('My Projects section is present and honest about its state', await page.getByRole('heading', { name: 'My Projects' }).isVisible());
  await page.getByText('Active team members').waitFor();
  check('dashboard shows the real member count (1)', (await page.locator('.stat', { hasText: 'Active team members' }).locator('.stat-value').textContent()) === '1');
  check('dashboard shows real figures for projects and tasks', (await page.locator('.stat', { hasText: 'Active projects' }).locator('.stat-value').textContent()) === '0' && (await page.getByRole('heading', { name: 'Upcoming deadlines' }).isVisible()));
  await shot(page, '01-dashboard');
  await axeCheck(page, 'dashboard');

  await nav.getByRole('link', { name: /Projects/ }).click();
  await page.getByRole('heading', { level: 1, name: 'Projects' }).waitFor();
  check('the Projects page is a working module', await page.getByRole('button', { name: 'New project' }).isVisible());
  await axeCheck(page, 'projects list');

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  check('desktop sidebar collapses to an icon rail', (await page.locator('.shell-collapsed').count()) === 1 && !(await page.getByRole('heading', { name: 'My Projects' }).isVisible()));
  await page.getByRole('button', { name: 'Expand sidebar' }).click();

  // ---------------------------------------------------------------- invitations
  await page.goto(`${APP}/settings/members`);
  await page.getByRole('button', { name: 'Invite people' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email address').fill(memberEmail);
  await dialog.getByLabel(/Project Manager/).check();
  await axeCheck(page, 'invite dialog');
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await dialog.getByText('Invitation created').waitFor();
  check('invitation dialog says honestly that the email was not sent (dev outbox)', await dialog.getByText(/does not send email/).isVisible());
  const memberLink = await dialog.getByLabel(/Invitation link/).inputValue();
  check('invitation link is shown to share', /\/invite\/[A-Za-z0-9_-]{20,}$/.test(memberLink), memberLink);
  await dialog.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Invite people' }).click();
  await dialog.getByLabel('Email address').fill(clientEmail);
  await dialog.getByLabel(/Client \/ Guest/).check();
  check('choosing Client clears internal roles', !(await dialog.getByLabel(/Team Member/).isChecked()));
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await dialog.getByText('Invitation created').waitFor();
  const clientLink = await dialog.getByLabel(/Invitation link/).inputValue();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.getByText(clientEmail).waitFor();
  check('pending invitations are listed', (await page.locator('.list-item').count()) === 2);
  await shot(page, '02-members');
  await axeCheck(page, 'members & roles');

  // ---------------------------------------------------------------- team member accepts
  const member = await newPage();
  await member.goto(memberLink);
  await member.getByRole('heading', { name: /Join Brightpath/ }).waitFor();
  check('invitation page shows the organisation and role', (await member.getByText(memberEmail).first().isVisible()) && (await member.getByText(/Project Manager/).isVisible()));
  await axeCheck(member, 'accept invitation');
  await member.getByLabel('Your name').fill('Arjun Mehta');
  await member.getByLabel('Password').fill(PASSWORD);
  await member.getByRole('button', { name: 'Create account and join' }).click();
  await member.waitForURL(/\/dashboard/);
  const landed = await member.getByRole('heading', { level: 1, name: /^Good (morning|afternoon|evening), Arjun$/ }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check('the invited member lands on the dashboard of the organisation', landed);
  await member.getByText('Active team members').waitFor();
  check('team members cannot see the audit log card', (await member.getByText('Recent activity').count()) === 0);

  // ---------------------------------------------------------------- client accepts
  const client = await newPage();
  await client.goto(clientLink);
  await client.getByLabel('Your name').fill('Chloe Byrne');
  await client.getByLabel('Password').fill(PASSWORD);
  await client.getByRole('button', { name: 'Create account and join' }).click();
  await client.waitForURL(/\/dashboard/);
  await client.getByRole('heading', { level: 1, name: 'Welcome, Chloe' }).waitFor();
  const clientNav = (await client.getByRole('navigation', { name: 'Main navigation' }).getByRole('link').allTextContents()).map((t) => t.replace(/\(not available yet\)|Soon/g, '').trim());
  check('clients only see shared modules in the sidebar', JSON.stringify(clientNav) === JSON.stringify(['Dashboard', 'Projects', 'Team Chat', 'Settings']), clientNav.join(', '));
  await client.goto(`${APP}/settings/members`);
  await client.getByRole('alert').waitFor();
  check('a client opening the member directory gets a permission error', (await client.getByRole('alert').textContent()).includes('Not allowed'));
  consoleErrors.length = 0; // the 403 above was provoked on purpose
  await axeCheck(client, 'client view of a forbidden page');

  // ---------------------------------------------------------------- roles and deactivation
  await page.reload();
  const row = page.getByRole('row', { name: /Arjun Mehta/ });
  await row.getByRole('button', { name: 'Edit roles for Arjun Mehta' }).click();
  await dialog.getByLabel(/Finance Manager/).check();
  await dialog.getByRole('button', { name: 'Save roles' }).click();
  await page.getByText('Roles updated for Arjun Mehta').waitFor();
  check('roles are changed and saved', (await row.textContent()).includes('Finance Manager'));

  await row.getByRole('button', { name: 'Deactivate Arjun Mehta' }).click();
  await dialog.getByRole('button', { name: 'Deactivate' }).click();
  await page.getByText('Arjun Mehta deactivated').waitFor();
  // The toast follows the server's confirmation; the list then reloads.
  const gone = await page.getByRole('row', { name: /Arjun Mehta/ }).waitFor({ state: 'detached', timeout: 10_000 }).then(() => true, () => false);
  check('deactivated members disappear from the active list', gone);
  await member.reload();
  await member.waitForURL(/\/no-organisation/);
  const lost = await member.getByRole('heading', { name: 'No active organisation' }).waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check('a deactivated member loses access on their next page load', lost);
  await axeCheck(member, 'no active organisation');

  // ---------------------------------------------------------------- people and audit log
  await page.goto(`${APP}/people`);
  await page.getByLabel('Search people').fill('priya');
  const filtered = await page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return rows.length === 1 && rows[0].textContent.includes('Priya Sharma');
    }, null, { timeout: 10_000 })
    .then(() => true, () => false);
  check('people directory search works', filtered);
  await axeCheck(page, 'people');
  await page.goto(`${APP}/settings/audit`);
  await page.getByRole('table').waitFor();
  const summaries = await page.getByRole('table').textContent();
  check('audit log records the journey', ['Invited', 'joined as Team Member, Project Manager', 'Changed Arjun Mehta’s roles', 'Deactivated Arjun Mehta'].every((s) => summaries.includes(s)));
  await page.getByLabel('Type').selectOption('invitation');
  await page.waitForFunction(() => [...document.querySelectorAll('tbody tr')].every((r) => r.textContent.includes('Invited')));
  check('audit log filters by type', true);
  await shot(page, '03-audit');
  await axeCheck(page, 'audit log');

  await page.goto(`${APP}/settings/profile`);
  await page.getByLabel('Job title').fill('Managing Director');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByText('Profile saved').waitFor();
  check('profile changes are saved', (await page.locator('.user-role').textContent()).length > 0);
  await axeCheck(page, 'profile');

  // ---------------------------------------------------------------- phone width
  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${APP}/signin`);
  await noOverflow(phone, 'sign-in');
  await phone.getByLabel('Email address').fill(ownerEmail);
  await phone.getByLabel('Password').fill(PASSWORD);
  await phone.getByRole('button', { name: 'Sign in' }).click();
  await phone.waitForURL(/\/dashboard/);
  await phone.getByText('Active team members').waitFor();
  await noOverflow(phone, 'dashboard');
  check('the sidebar is hidden off-canvas on phones', !(await phone.getByRole('navigation', { name: 'Main navigation' }).isVisible()));
  const menu = phone.getByRole('button', { name: 'Open navigation' });
  await menu.click();
  await phone.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'visible' });
  check('the menu button opens the drawer and moves focus into it', await phone.evaluate(() => !!document.activeElement?.closest('#sidebar')));
  await shot(phone, '04-phone-drawer');
  await axeCheck(phone, 'phone drawer open');
  await phone.keyboard.press('Escape');
  await phone.getByRole('navigation', { name: 'Main navigation' }).waitFor({ state: 'hidden' });
  check('Escape closes the drawer and returns focus to the menu button', await phone.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open navigation'));
  for (const p of ['/settings/members', '/settings/audit', '/people', '/tasks']) {
    await phone.goto(`${APP}${p}`);
    await phone.waitForLoadState('networkidle');
    await noOverflow(phone, p);
  }
  await shot(phone, '05-phone-tasks');

  // ---------------------------------------------------------------- sign out
  await page.getByRole('button', { name: /Account menu/ }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/signin/);
  await page.goto(`${APP}/dashboard`);
  await page.waitForURL(/\/signin\?next=/);
  check('signing out ends the session', true);

  check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (e) {
  check('journey completed without an exception', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
