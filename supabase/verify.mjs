// Run: node supabase/verify.mjs /absolute/path/to/@electric-sql/pglite/dist/index.js
// Test dependency is optional and is not part of the application or deployment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass the installed PGlite module path; see the first comment.');
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const pg = new PGlite();
await pg.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002');
`);
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await pg.exec(schema);
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const state = {
  version: 1,
  students: [{ id: 's-1', name: 'Алина Соколова', group: 'A1', phone: '+996555123456', joined: '2026-10-01', deposit: true }],
  attendance: { '2026-10-24': { 's-1': 'present' } },
};
async function asUser(id, role = 'authenticated') {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await pg.exec(`set role ${role}`);
}
const load = async () => (await pg.query('select public.load_journal() as result')).rows[0].result;
const save = async (data, revision) => (await pg.query('select public.save_journal($1::jsonb, $2::bigint) as result', [JSON.stringify(data), revision])).rows[0].result;
await asUser(owner);
assert.deepEqual(await load(), { revision: 0, state: { version: 1, students: [], attendance: {} } });
assert.deepEqual(await save(state, 0), { revision: 1, state });
assert.deepEqual(await load(), { revision: 1, state });
await assert.rejects(save({ ...state, students: [] }, 0), { code: '40001' });
assert.deepEqual(await load(), { revision: 1, state });
console.log('PASS: save/load, revision, stale-write rejection without data loss');
for (const bad of [
  { ...state, students: [state.students[0], state.students[0]] },
  { ...state, students: [{ ...state.students[0], joined: '2026-02-30' }] },
  { ...state, students: [{ ...state.students[0], joined: '2026-10-25' }] },
  { ...state, students: [{ ...state.students[0], deposit: 'true' }] },
  { ...state, attendance: { '2026-10-24': { unknown: 'present' } } },
  { ...state, attendance: { '2026-10-24': { 's-1': 'unknown' } } },
  { ...state, attendance: { '2026-10-24': [] } },
  { ...state, attendance: [] },
  { ...state, version: 2 },
  { ...state, students: [{ ...state.students[0], name: ' ' }] },
  { ...state, students: [{ ...state.students[0], phone: '0'.repeat(41) }] },
]) {
  await assert.rejects(save(bad, 1));
  assert.deepEqual(await load(), { revision: 1, state }, 'invalid save must roll back');
}
console.log('PASS: input validation and atomic rollback across 11 invalid snapshots');
for (const table of ['journals', 'students', 'attendance']) {
  await assert.rejects(pg.exec(`delete from public.${table}`), { code: '42501' });
}
await assert.rejects(pg.exec(`insert into public.journals(user_id) values ('${other}')`), { code: '42501' });
console.log('PASS: direct API writes denied');
await asUser(other);
assert.equal((await pg.query('select * from public.students')).rows.length, 0);
assert.equal((await pg.query('select * from public.attendance')).rows.length, 0);
assert.equal((await load()).state.students.length, 0);
const otherState = { ...state, students: [{ ...state.students[0], name: 'Другой пользователь' }] };
assert.equal((await save(otherState, 0)).revision, 1);
await asUser(owner);
assert.deepEqual(await load(), { revision: 1, state });
await pg.exec('reset role');
await pg.exec(schema);
await asUser(owner);
assert.deepEqual(await load(), { revision: 1, state });
console.log('PASS: two-user isolation with same student ID, idempotent schema preserves data');
await asUser('', 'anon');
await assert.rejects(load(), { code: '42501' });
await assert.rejects(save(state, 0), { code: '42501' });
await assert.rejects(pg.exec('select * from public.students'), { code: '42501' });
await asUser('');
await assert.rejects(load(), { code: '42501' });
await assert.rejects(save(state, 0), { code: '42501' });
console.log('PASS: anonymous and missing-identity access denied');
await pg.close();
