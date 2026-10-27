// Run: node supabase/verify.mjs /absolute/path/to/@electric-sql/pglite/dist/index.js
// Test dependency is optional and is not part of the application or deployment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { defaultSchedule, emptyState } from '../src/model.js';
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
  insert into auth.users values ('00000000-0000-0000-0000-000000000001'), ('00000000-0000-0000-0000-000000000002'), ('00000000-0000-0000-0000-000000000003');
`);
// Simulate the exact old table layout, with a real existing journal and mark.
await pg.exec(`
  create table public.journals(user_id uuid primary key references auth.users(id), revision bigint not null default 0);
  create table public.students(user_id uuid references public.journals(user_id), id text, name text not null, group_name text not null, phone text not null default '', joined date not null, deposit boolean not null default false, primary key(user_id,id));
  create table public.attendance(user_id uuid, student_id text, lesson_date date, status text, primary key(user_id,lesson_date,student_id), foreign key(user_id,student_id) references public.students(user_id,id) on delete cascade);
  insert into public.journals values ('00000000-0000-0000-0000-000000000003',7);
  insert into public.students values ('00000000-0000-0000-0000-000000000003','old-1','Исторический ученик','A1','+996555000000','2026-10-01',true);
  insert into public.attendance values ('00000000-0000-0000-0000-000000000003','old-1','2026-10-24','present');
`);
const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
await pg.exec(schema);
const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const state = {
  version: 3,
  deposits: {'2026-10': {'s-1': true}, '2026-11': {'s-1': true}},
  schedule: defaultSchedule(),
  students: [{ id: 's-1', name: 'Алина Соколова', group: 'A1', phone: '+996555123456', joined: '2026-10-01', deposit: true }],
  attendance: { '2026-10-24': { lecture: { 's-1': 'present' }, practice: { 's-1': 'absent' } } },
};
async function asUser(id, role = 'authenticated') {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await pg.exec(`set role ${role}`);
}
const load = async () => (await pg.query('select public.load_journal() as result')).rows[0].result;
const save = async (data, revision) => (await pg.query('select public.save_journal($1::jsonb, $2::bigint) as result', [JSON.stringify(data), revision])).rows[0].result;
await asUser('00000000-0000-0000-0000-000000000003');
const historical = await load();
assert.equal(historical.revision, 7);
assert.equal(historical.state.students[0].name, 'Исторический ученик');
assert.deepEqual(historical.state.attendance, { '2026-10-24': { legacy: { 'old-1': 'present' } } });
assert.deepEqual(historical.state.schedule, defaultSchedule());
assert.deepEqual(historical.state.deposits, {});
assert.equal(historical.state.students[0].deposit, true);
console.log('PASS: v1 SQL migration preserves historical marks under legacy and keeps journal revision');
await asUser(owner);
assert.deepEqual(await load(), { revision: 0, state: emptyState() });
assert.deepEqual(await save(state, 0), { revision: 1, state });
assert.deepEqual(await load(), { revision: 1, state });
await assert.rejects(save({ ...state, students: [] }, 0), { code: '40001' });
assert.deepEqual(await load(), { revision: 1, state });
console.log('PASS: save/load, separate lecture/practice marks, revision, stale-write rejection without data loss');
for (const bad of [
  { ...state, students: [state.students[0], state.students[0]] },
  { ...state, students: [{ ...state.students[0], joined: '2026-02-30' }] },
  { ...state, students: [{ ...state.students[0], joined: '2026-10-25' }] },
  { ...state, students: [{ ...state.students[0], deposit: 'true' }] },
  { ...state, attendance: { '2026-10-24': { lecture: { unknown: 'present' } } } },
  { ...state, attendance: { '2026-10-24': { lecture: { 's-1': 'unknown' } } } },
  { ...state, attendance: { '2026-10-24': [] } },
  { ...state, attendance: [] },
  { ...state, version: 1 },
  { ...state, version: 2 },
  { ...state, deposits: {'2026-09': {'s-1': true}} },
  { ...state, deposits: {'2026-10': {'s-1': false}} },
  { ...state, deposits: {'2026-13': {'s-1': true}} },
  { ...state, deposits: {'2026-10': {unknown: true}} },
  { ...state, schedule: null },
  { ...state, schedule: { week: {}, overrides: {} } },
  { ...state, schedule: { week: { ...state.schedule.week, '1': ['practice', 'practice'] }, overrides: {} } },
  { ...state, schedule: { week: state.schedule.week, overrides: { '2026-02-30': [] } } },
  { ...state, schedule: { week: state.schedule.week, overrides: { '2026-10-24': ['legacy'] } } },
  { ...state, attendance: { '2026-10-24': { unknown: { 's-1': 'present' } } } },
  { ...state, students: [{ ...state.students[0], name: ' ' }] },
  { ...state, students: [{ ...state.students[0], phone: '0'.repeat(41) }] },
]) {
  await assert.rejects(save(bad, 1));
  assert.deepEqual(await load(), { revision: 1, state }, 'invalid save must roll back');
}
console.log('PASS: input validation and atomic rollback across invalid snapshots');
const rescheduled = structuredClone(state);
rescheduled.schedule.week['6'] = [];
rescheduled.schedule.overrides['2026-10-24'] = [];
rescheduled.schedule.overrides['2026-10-27'] = ['lecture', 'practice'];
assert.equal((await save(rescheduled, 1)).revision, 2);
assert.deepEqual((await load()).state.attendance, state.attendance);
assert.deepEqual((await load()).state.schedule, rescheduled.schedule);
// Restore canonical fixture for remaining isolation tests.
assert.equal((await save(state, 2)).revision, 3);
console.log('PASS: schedule/week overrides synchronize and rescheduling never deletes marks');
const changedMonth = structuredClone(state); delete changedMonth.deposits['2026-11'];
assert.equal((await save(changedMonth, 3)).revision, 4);
assert.deepEqual((await load()).state.deposits, {'2026-10': {'s-1': true}});
assert.equal((await save(state, 4)).revision, 5);
console.log('PASS: monthly deposits round-trip and clearing November preserves October');
for (const table of ['journals', 'students', 'attendance', 'deposits']) {
  await assert.rejects(pg.exec(`delete from public.${table}`), { code: '42501' });
}
await assert.rejects(pg.exec(`insert into public.journals(user_id) values ('${other}')`), { code: '42501' });
console.log('PASS: direct API writes denied');
await asUser(other);
assert.equal((await pg.query('select * from public.students')).rows.length, 0);
assert.equal((await pg.query('select * from public.attendance')).rows.length, 0);
assert.equal((await load()).state.students.length, 0);
assert.equal((await pg.query('select * from public.deposits')).rows.length, 0);
const otherState = { ...state, students: [{ ...state.students[0], name: 'Другой пользователь' }] };
assert.equal((await save(otherState, 0)).revision, 1);
await asUser(owner);
assert.deepEqual(await load(), { revision: 5, state });
await pg.exec('reset role');
await pg.exec(schema);
await asUser(owner);
assert.deepEqual(await load(), { revision: 5, state });
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
