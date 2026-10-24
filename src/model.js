export const STORAGE_KEY = 'classroom.v1';
export const statuses = ['present', 'absent', 'excused'];
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function emptyState() { return { version: 1, students: [], attendance: {} }; }
export function validateState(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.students) || !data.attendance || typeof data.attendance !== 'object' || Array.isArray(data.attendance)) throw new Error('Неверный формат резервной копии.');
  const ids = new Set();
  const students = data.students.map(s => {
    if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(s.id) || ids.has(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 100 || typeof s.group !== 'string' || !s.group.trim() || s.group.length > 60 || typeof s.phone !== 'string' || s.phone.length > 40 || !validDate(s.joined) || typeof s.deposit !== 'boolean') throw new Error('Некорректные данные ученика.');
    ids.add(s.id);
    return { id: s.id, name: s.name.trim(), group: s.group.trim(), phone: s.phone, joined: s.joined, deposit: s.deposit };
  });
  const attendance = {};
  for (const [date, entries] of Object.entries(data.attendance)) {
    if (!validDate(date) || !entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('Некорректные данные посещаемости.');
    attendance[date] = {};
    for (const [id, status] of Object.entries(entries)) {
      if (!ids.has(id) || !statuses.includes(status) || students.find(s => s.id === id).joined > date) throw new Error('Некорректная отметка посещаемости.');
      attendance[date][id] = status;
    }
  }
  return { version: 1, students, attendance };
}
export function setAttendance(state, id, date, status) {
  const student = state.students.find(s => s.id === id);
  if (!student || !validDate(date) || student.joined > date || (status !== null && !statuses.includes(status))) throw new Error('Нельзя поставить эту отметку.');
  const attendance = structuredClone(state.attendance);
  attendance[date] ||= {};
  if (status === null) delete attendance[date][id];
  else attendance[date][id] = status;
  return { ...state, attendance };
}
export function removeStudent(state, id) {
  const attendance = structuredClone(state.attendance);
  Object.values(attendance).forEach(entries => delete entries[id]);
  return { ...state, students: state.students.filter(s => s.id !== id), attendance };
}
