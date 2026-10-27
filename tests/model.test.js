import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, validateState, setAttendance, removeStudent, validDate, getLessons, defaultSchedule, setDeposit, isDepositPaid } from '../src/model.js';
const student = { id: 'student-1', name: 'Алина Соколова', group: 'Английский A1', phone: '+996 555 123456', joined: '2026-10-01', deposit: false };
const state = () => ({ ...emptyState(), students: [{ ...student }] });
test('lecture and practice attendance are independent on the same day and can be cleared', () => {
  const original = state();
  const first = setAttendance(original, student.id, '2026-10-24', 'present', 'lecture');
  const second = setAttendance(first, student.id, '2026-10-24', 'absent', 'practice');
  assert.equal(second.attendance['2026-10-24'].lecture[student.id], 'present');
  assert.equal(second.attendance['2026-10-24'].practice[student.id], 'absent');
  assert.deepEqual(original.attendance, {});
  const cleared = setAttendance(second, student.id, '2026-10-24', null, 'lecture');
  assert.deepEqual(cleared.attendance['2026-10-24'].lecture, {});
  assert.equal(cleared.attendance['2026-10-24'].practice[student.id], 'absent');
});
test('rejects attendance before joining and unknown students/types', () => {
  assert.throws(() => setAttendance(state(), student.id, '2026-09-30', 'present'));
  assert.throws(() => setAttendance(state(), 'unknown', '2026-10-24', 'present'));
  assert.throws(() => setAttendance(state(), student.id, '2026-10-24', 'present', 'unknown'));
});
test('v1 backup migration preserves old marks under legacy without guessing their lesson type', () => {
  const migrated = validateState({ version: 1, students: [student], attendance: { '2026-10-24': { [student.id]: 'present' } } });
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.schedule, defaultSchedule());
  assert.deepEqual(migrated.attendance['2026-10-24'], { legacy: { [student.id]: 'present' } });
});
test('default weekday schedule and date overrides include days off and both lesson types', () => {
  const data = state();
  assert.deepEqual(getLessons(data, '2026-10-26'), ['practice']);
  assert.deepEqual(getLessons(data, '2026-10-27'), ['lecture']);
  assert.deepEqual(getLessons(data, '2026-10-30'), []);
  data.schedule.overrides['2026-10-27'] = [];
  data.schedule.overrides['2026-10-30'] = ['lecture', 'practice'];
  assert.deepEqual(getLessons(data, '2026-10-27'), []);
  assert.deepEqual(getLessons(data, '2026-10-30'), ['lecture', 'practice']);
  assert.deepEqual(getLessons(data, '2026-11-03'), ['lecture']);
});
test('v2 backup round-trip retains schedule, phone, deposits, and both attendance types', () => {
  let data = setAttendance(state(), student.id, '2026-10-24', 'excused', 'lecture');
  data = setAttendance(data, student.id, '2026-10-24', 'present', 'practice');
  data.schedule.overrides['2026-10-24'] = ['lecture', 'practice'];
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(data))), data);
  data.schedule.overrides['2026-10-24'] = [];
  assert.equal(validateState(data).attendance['2026-10-24'].lecture[student.id], 'excused');
});
test('rejects malformed backups and invalid calendar dates/schedules', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.throws(() => validateState({ ...state(), students: [student, student] }));
  assert.throws(() => validateState({ ...state(), attendance: { '2026-10-24': { lecture: { unknown: 'present' } } } }));
  assert.throws(() => validateState({ ...state(), attendance: { '2026-09-30': { lecture: { [student.id]: 'present' } } } }));
  assert.throws(() => validateState({ ...state(), students: [{ ...student, deposit: 'yes' }] }));
  for (const malformed of [null, { week: {}, overrides: {} }, { week: { ...defaultSchedule().week, '1': ['lecture', 'lecture'] }, overrides: {} }, { week: defaultSchedule().week, overrides: { '2026-02-30': [] } }, { week: defaultSchedule().week, overrides: { '2026-10-24': ['legacy'] } }]) {
    assert.throws(() => validateState({ ...state(), schedule: malformed }));
  }
});
test('deleting a student removes historical marks from every type without mutating input', () => {
  let original = setAttendance(state(), student.id, '2026-10-24', 'present', 'lecture');
  original = setAttendance(original, student.id, '2026-10-24', 'absent', 'practice');
  const removed = removeStudent(original, student.id);
  assert.equal(removed.students.length, 0);
  assert.deepEqual(removed.attendance['2026-10-24'], { lecture: {}, practice: {} });
  assert.equal(original.attendance['2026-10-24'].lecture[student.id], 'present');
});

test('deposits are independent per month and year; clearing one does not affect another', () => {
  const original = state();
  const october = setDeposit(original, student.id, '2026-10', true);
  assert.equal(isDepositPaid(october, student.id, '2026-10'), true);
  assert.equal(isDepositPaid(october, student.id, '2026-11'), false);
  const november = setDeposit(october, student.id, '2026-11', true);
  const cleared = setDeposit(november, student.id, '2026-11', false);
  assert.equal(isDepositPaid(cleared, student.id, '2026-10'), true);
  assert.equal(isDepositPaid(cleared, student.id, '2026-11'), false);
  assert.equal(isDepositPaid(cleared, student.id, '2027-10'), false);
  assert.deepEqual(original.deposits, {});
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(november))), november);
  assert.deepEqual(removeStudent(november, student.id).deposits, { '2026-10': {}, '2026-11': {} });
});
test('undated legacy deposits are preserved but never silently assigned to a month', () => {
  const legacy = validateState({ version: 1, students: [{...student, deposit: true}], attendance: {} });
  assert.equal(legacy.students[0].deposit, true);
  assert.deepEqual(legacy.deposits, {});
  assert.equal(isDepositPaid(legacy, student.id, '2026-10'), false);
  assert.throws(() => setDeposit(legacy, student.id, '2026-09', true));
  for (const marks of [{ '2026-13': {[student.id]: true}}, {'2026-10': {unknown: true}}, {'2026-10': {[student.id]: false}}, {'2026-09': {[student.id]: true}}]) {
    assert.throws(() => validateState({ ...state(), deposits: marks }));
  }
});
