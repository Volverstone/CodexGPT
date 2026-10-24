import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, validateState, setAttendance, removeStudent, validDate } from '../src/model.js';
const student = { id: 'student-1', name: 'Алина Соколова', group: 'Английский A1', phone: '+996 555 123456', joined: '2026-10-01', deposit: false };
const state = () => ({ ...emptyState(), students: [{ ...student }] });
test('attendance is saved per date and can be cleared without mutating input', () => {
  const original = state();
  const first = setAttendance(original, student.id, '2026-10-24', 'present');
  const second = setAttendance(first, student.id, '2026-10-25', 'absent');
  assert.equal(second.attendance['2026-10-24'][student.id], 'present');
  assert.equal(second.attendance['2026-10-25'][student.id], 'absent');
  assert.deepEqual(original.attendance, {});
  assert.deepEqual(setAttendance(second, student.id, '2026-10-24', null).attendance['2026-10-24'], {});
});
test('rejects attendance before joining and unknown students', () => {
  assert.throws(() => setAttendance(state(), student.id, '2026-09-30', 'present'));
  assert.throws(() => setAttendance(state(), 'unknown', '2026-10-24', 'present'));
});
test('backup round-trip retains students, phones, deposits, and attendance', () => {
  const data = setAttendance(state(), student.id, '2026-10-24', 'excused');
  assert.deepEqual(validateState(JSON.parse(JSON.stringify(data))), data);
});
test('rejects malformed backups and invalid calendar dates', () => {
  assert.equal(validDate('2026-02-30'), false);
  assert.equal(validDate('2028-02-29'), true);
  assert.throws(() => validateState({ ...state(), students: [student, student] }));
  assert.throws(() => validateState({ ...state(), attendance: { '2026-10-24': { 'unknown': 'present' } } }));
  assert.throws(() => validateState({ ...state(), attendance: { '2026-09-30': { [student.id]: 'present' } } }));
  assert.throws(() => validateState({ ...state(), students: [{ ...student, deposit: 'yes' }] }));
});
test('deleting a student removes historical attendance and leaves the original intact', () => {
  const original = setAttendance(state(), student.id, '2026-10-24', 'present');
  const removed = removeStudent(original, student.id);
  assert.equal(removed.students.length, 0);
  assert.deepEqual(removed.attendance['2026-10-24'], {});
  assert.equal(original.students.length, 1);
  assert.equal(original.attendance['2026-10-24'][student.id], 'present');
});
