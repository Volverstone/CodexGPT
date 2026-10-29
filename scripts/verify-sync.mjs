// Optional integration test (not a runtime dependency):
// npm run build
// node scripts/verify-sync.mjs /path/to/playwright/index.mjs /path/to/@electric-sql/pglite/dist/index.js [/path/to/chromium]
// Uses real SQL in embedded PostgreSQL and fake local authentication; no cloud credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

if (!process.argv[2] || !process.argv[3]) throw new Error('Pass Playwright and PGlite module paths; see the comments at the top.');
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const { PGlite } = await import(pathToFileURL(process.argv[3]).href);
const pg = new PGlite();
const users = new Map([
  ['owner@example.test', '00000000-0000-0000-0000-000000000001'],
  ['other@example.test', '00000000-0000-0000-0000-000000000002'],
]);
await pg.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
for (const id of users.values()) await pg.query('insert into auth.users values ($1)', [id]);
await pg.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
const builtHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert(builtHtml.includes('class CloudClient'), 'Run npm run build first.');
const tokens = new Map();
let sequence = 0, failWrites = false, failLogout = false;
let queue = Promise.resolve();
function databaseTask(action) {
  const result = queue.then(action);
  queue = result.catch(() => {});
  return result;
}
async function rpc(userId, name, data) {
  return databaseTask(async () => {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await pg.exec('set role authenticated');
    const result = name === 'load_journal'
      ? await pg.query('select public.load_journal() as result')
      : await pg.query('select public.save_journal($1::jsonb, $2::bigint) as result', [JSON.stringify(data.p_state), data.p_expected_revision]);
    return result.rows[0].result;
  });
}
function session(email) {
  const token = `test-access-${++sequence}`;
  tokens.set(token, { id: users.get(email), email });
  return { access_token: token, refresh_token: token, expires_in: 3600, user: { id: users.get(email), email } };
}
const server = http.createServer(async (request, response) => {
  const send = (data, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(data));
  };
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && (path === '/' || path === '/index.html')) {
      const config = JSON.stringify({ url: origin, key: 'sb_publishable_test' });
      const html = builtHtml.replace(/globalThis\.CLASSROOM_CONFIG = [^\n]*;/, `globalThis.CLASSROOM_CONFIG = ${config};`)
        .replace('<meta name="classroom-hosted" content="true">', '');
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(html); return;
    }
    if (request.method !== 'POST') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const data = JSON.parse(raw || '{}');
    if (path === '/auth/v1/token' && request.url.includes('grant_type=password')) {
      if (!users.has(data.email) || data.password !== 'test-password') { send({ code: 'invalid_credentials' }, 400); return; }
      send(session(data.email)); return;
    }
    if (path === '/auth/v1/signup') {
      if (!users.has(data.email)) { send({ message: 'Unknown test user' }, 400); return; }
      send(session(data.email)); return;
    }
    if (path === '/auth/v1/token' && request.url.includes('grant_type=refresh_token')) {
      const account = tokens.get(data.refresh_token);
      if (!account) { send({ code: 'refresh_token_not_found' }, 400); return; }
      send(session(account.email)); return;
    }
    const token = (request.headers.authorization || '').replace(/^Bearer /, '');
    const account = tokens.get(token);
    if (!account) { send({ message: 'Unauthenticated' }, 401); return; }
    if (path === '/auth/v1/logout') {
      if (failLogout) { send({ message: 'Simulated outage' }, 503); return; }
      tokens.delete(token); send(null); return;
    }
    const operation = path.split('/').at(-1);
    if (!['load_journal', 'save_journal'].includes(operation)) { send({}, 404); return; }
    if (operation === 'save_journal' && failWrites) { send({ message: 'Simulated outage' }, 503); return; }
    send(await rpc(account.id, operation, data));
  } catch (error) {
    send({ code: error.code || 'test_error', message: error.message }, error.code === '40001' ? 409 : 400);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const errors = [];
try {
  browser = await chromium.launch({ executablePath: process.argv[4] || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const android = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // Chromium layout emulation only: this does not claim native Safari / real iPhone validation.
  const iphoneLayout = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' });
  const contexts = [desktop, android, iphoneLayout];
  const pages = await Promise.all(contexts.map(c => c.newPage()));
  const failedRequests = [];
  for (const page of pages) {
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(`${request.url()} ${request.failure()?.errorText}`));
  }
  async function login(page, email = 'owner@example.test') {
    await page.goto(origin);
    await page.locator('#account-button').click();
    await page.locator('#account-form [name=email]').fill(email);
    await page.locator('#account-form [name=password]').fill('test-password');
    await page.locator('#signin').click();
    try { await page.locator('#account-dialog').waitFor({ state: 'hidden', timeout: 10000 }); }
    catch (error) { throw new Error(`Login failed: ${await page.locator('#account-error').textContent()} | ${await page.locator('#sync-message').textContent()} | browser errors: ${errors.join('; ')} | requests: ${failedRequests.join('; ')}`, { cause: error }); }
    await page.waitForFunction(() => document.querySelector('#sync-title').textContent === 'Общий журнал');
    await page.locator('#attendance-date').fill('2026-10-24');
  }
  async function refresh(page) {
    const response = page.waitForResponse(r => r.url().endsWith('/rpc/load_journal'));
    await page.locator('#refresh-cloud').click();
    await response;
    await page.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  }
  async function add(page, name) {
    await page.locator('#add-student').click();
    await page.locator('#student-form [name=name]').fill(name);
    await page.locator('#student-form [name=group]').fill('Группа A1');
    await page.locator('#student-form [name=joined]').fill('2026-01-01');
    await page.locator('#student-form [name=phone]').fill('+996555123456');
    await page.locator('#save-student').click();
    await page.locator('#student-dialog').waitFor({ state: 'hidden' });
  }
  const [first, second, other] = pages;
  await login(first); await login(second); await login(other, 'other@example.test');
  await add(first, 'Ученик синхронизации');
  await first.getByLabel('Посещаемость: Ученик синхронизации', { exact: true }).selectOption('present');
  await first.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  await first.getByLabel('Депозит: Ученик синхронизации', { exact: true }).click();
  await first.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  await refresh(second);
  assert.equal(await second.locator('#total').textContent(), '1');
  assert.equal(await second.getByLabel('Посещаемость: Ученик синхронизации', { exact: true }).inputValue(), 'present');
  assert.equal(await second.getByLabel('Депозит: Ученик синхронизации', { exact: true }).getAttribute('aria-pressed'), 'true');
  console.log('PASS: desktop → PostgreSQL → separate mobile browser: student, attendance and deposit');

  await second.locator('#attendance-date').fill('2026-11-24');
  assert.equal(await second.getByLabel('Депозит: Ученик синхронизации', {exact:true}).getAttribute('aria-pressed'), 'false');
  await second.getByLabel('Депозит: Ученик синхронизации', {exact:true}).click();
  await second.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  await first.locator('#attendance-date').fill('2026-11-24'); await refresh(first);
  assert.equal(await first.getByLabel('Депозит: Ученик синхронизации', {exact:true}).getAttribute('aria-pressed'), 'true');
  await first.locator('#attendance-date').fill('2026-10-24');
  await second.locator('#attendance-date').fill('2026-10-24');
  assert.equal(await first.getByLabel('Депозит: Ученик синхронизации', {exact:true}).getAttribute('aria-pressed'), 'true');
  console.log('PASS: deposits are month-specific and both months synchronize without carrying over');

  // A one-day override can schedule both lesson types without merging their marks.
  await first.locator('#customize-day').click();
  await first.locator('#day-form [name=lecture]').check();
  await first.locator('#day-form [name=practice]').check();
  await first.locator('#save-day').click();
  await first.locator('#day-dialog').waitFor({ state: 'hidden' });
  await first.locator('#lesson-tabs [data-lesson=practice]').click();
  await first.getByLabel('Посещаемость: Ученик синхронизации', { exact: true }).selectOption('absent');
  await first.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  await refresh(second);
  await second.locator('#lesson-tabs [data-lesson=practice]').click();
  assert.equal(await second.getByLabel('Посещаемость: Ученик синхронизации', { exact: true }).inputValue(), 'absent');
  await second.locator('#lesson-tabs [data-lesson=lecture]').click();
  assert.equal(await second.getByLabel('Посещаемость: Ученик синхронизации', { exact: true }).inputValue(), 'present');
  await first.locator('#lesson-tabs [data-lesson=lecture]').click();
  console.log('PASS: same-date lecture and practice have independent marks; date override syncs across devices');

  await first.getByLabel('Заметки: Ученик синхронизации', {exact:true}).click();
  await first.locator('#student-notes').fill('Повторить тему\nПроверить домашнюю работу');
  await first.locator('#save-notes').click(); await first.locator('#notes-dialog').waitFor({state:'hidden'});
  await refresh(second);
  await second.getByLabel('Заметки: Ученик синхронизации', {exact:true}).click();
  assert.equal(await second.locator('#student-notes').inputValue(), 'Повторить тему\nПроверить домашнюю работу');
  await second.locator('#notes-dialog [data-close]').first().click();
  console.log('PASS: student notes synchronize between separate devices');
  // Hold a stale edit dialog open so polling deliberately does not refresh this snapshot.
  await second.getByLabel('Редактировать: Ученик синхронизации', { exact: true }).click();
  await second.locator('#student-form [name=name]').fill('Устаревшее изменение');
  await first.getByLabel('Депозит: Ученик синхронизации', { exact: true }).click();
  await first.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  const conflict = second.waitForResponse(r => r.url().endsWith('/rpc/save_journal') && r.status() === 409);
  await second.locator('#save-student').click(); await conflict;
  await second.waitForFunction(() => document.querySelector('#sync-message').textContent.includes('другом устройстве'));
  assert.equal(await second.locator('#student-dialog').evaluate(d => d.open), true);
  await second.locator('#cancel-dialog').click(); await refresh(second);
  assert.equal(await second.getByLabel('Депозит: Ученик синхронизации', { exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(await second.getByText('Устаревшее изменение', { exact: true }).count(), 0);
  console.log('PASS: concurrent stale write rejected without overwriting the newer journal');

  await refresh(other);
  assert.equal(await other.locator('#total').textContent(), '0');
  await add(other, 'Чужой журнал');
  await refresh(first);
  assert.equal(await first.getByText('Чужой журнал', { exact: true }).count(), 0);
  for (const mobile of [second, other]) assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('PASS: account isolation; Android-size and iPhone-size layouts in Chromium (not native Safari)');

  failWrites = true;
  await second.getByLabel('Редактировать: Ученик синхронизации', { exact: true }).click();
  await second.locator('#student-form [name=name]').fill('Не сохранено при сбое');
  const outage = second.waitForResponse(r => r.url().endsWith('/rpc/save_journal') && r.status() === 503);
  await second.locator('#save-student').click(); await outage;
  await second.waitForFunction(() => !document.querySelector('#refresh-cloud').disabled);
  assert.equal(await second.locator('#student-dialog').evaluate(d => d.open), true);
  assert(!(await second.locator('#sync-message').textContent()).includes('Сохранено'));
  await second.locator('#cancel-dialog').click(); failWrites = false;
  await refresh(second);
  assert.equal(await second.getByText('Не сохранено при сбое', { exact: true }).count(), 0);
  console.log('PASS: cloud outage does not claim success or overwrite stored state');

  // A server-side logout failure must still clear this browser's session and journal.
  failLogout = true;
  await second.locator('#account-button').click(); await second.locator('#signout').click();
  await second.locator('#account-dialog').waitFor({ state: 'hidden' });
  assert.equal(await second.locator('#total').textContent(), '0');
  assert.equal(await second.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('classroom.auth.')).length), 0);
  await second.reload();
  assert.equal(await second.locator('#total').textContent(), '0');
  assert.match(await second.locator('#sync-title').textContent(), /Войдите/);
  assert.deepEqual(errors, []);
  console.log('PASS: logout clears shared data and session even if logout endpoint fails; no browser JS errors');
  const legacyContext = await browser.newContext();
  const legacyPage = await legacyContext.newPage();
  legacyPage.on('pageerror', error => errors.push(error.message));
  await legacyPage.route('**/rpc/load_journal', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ revision: 7, state: { version: 1, students: [{ id:'old-1', name:'Прежний ученик', group:'A1', phone:'', joined:'2026-01-01', deposit:true }], attendance: { '2026-10-24': { 'old-1': 'present' } } } }) }));
  await login(legacyPage);
  assert.equal(await legacyPage.locator('#total').textContent(), '1');
  assert.equal(await legacyPage.locator('#add-student').isDisabled(), true);
  assert.equal(await legacyPage.locator('#export').isEnabled(), true);
  assert.equal(await legacyPage.locator('#migration-help').isVisible(), true);
  assert.match(await legacyPage.locator('#sync-message').textContent(), /только для просмотра/);
  await legacyPage.locator('[data-lesson=legacy]').click();
  assert.equal(await legacyPage.getByLabel('Посещаемость: Прежний ученик', {exact:true}).inputValue(), 'present');
  assert.deepEqual(errors, []);
  console.log('PASS: old SQL backend retains a read-only journal and export with a migration link');
  await legacyContext.close();
  for (const context of contexts) await context.close();
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await queue;
  await pg.close();
}
