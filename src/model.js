export const STORAGE_KEY = 'classroom.v1';
export const statuses = ['present', 'absent', 'excused'];
export const lessonTypes = ['lecture', 'practice'];
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function defaultSchedule() {
  return { week: { '0': [], '1': ['practice'], '2': ['lecture'], '3': ['practice'], '4': ['lecture'], '5': [], '6': ['lecture'] }, overrides: {} };
}
function isRecord(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function validLessons(value) { return Array.isArray(value) && value.length <= 2 && new Set(value).size === value.length && value.every(type => lessonTypes.includes(type)); }
function validateSchedule(value) {
  if (!isRecord(value) || !isRecord(value.week) || !isRecord(value.overrides) || Object.keys(value).some(k => !['week', 'overrides'].includes(k)) || Object.keys(value.week).length !== 7 || Object.keys(value.week).some(k => !/^[0-6]$/.test(k))) throw new Error('Некорректное расписание.');
  const week = {};
  for (let day = 0; day < 7; day++) {
    if (!validLessons(value.week[day])) throw new Error('Некорректные дни расписания.');
    week[day] = [...value.week[day]];
  }
  const overrides = {};
  for (const [date, types] of Object.entries(value.overrides)) {
    if (!validDate(date) || !validLessons(types)) throw new Error('Некорректное занятие на дату.');
    overrides[date] = [...types];
  }
  return { week, overrides };
}
export function getLessons(state, date) {
  if (!validDate(date)) throw new Error('Некорректная дата занятия.');
  const schedule = state.schedule || defaultSchedule();
  if (Object.hasOwn(schedule.overrides, date)) return [...schedule.overrides[date]];
  return [...schedule.week[new Date(`${date}T12:00:00Z`).getUTCDay()]];
}
export function emptyState() { return { version: 3, students: [], deposits: {}, schedule: defaultSchedule(), attendance: {} }; }
export function validateState(data) {
  if (!isRecord(data) || ![1, 2, 3].includes(data.version) || !Array.isArray(data.students) || !isRecord(data.attendance)) throw new Error('Неверный формат резервной копии.');
  const ids = new Set();
  const students = data.students.map(s => {
    if (!s || typeof s.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(s.id) || ids.has(s.id) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 100 || typeof s.group !== 'string' || !s.group.trim() || s.group.length > 60 || typeof s.phone !== 'string' || s.phone.length > 40 || !validDate(s.joined) || typeof s.deposit !== 'boolean') throw new Error('Некорректные данные ученика.');
    ids.add(s.id);
    return { id: s.id, name: s.name.trim(), group: s.group.trim(), phone: s.phone, joined: s.joined, deposit: s.deposit };
  });
  const joined = new Map(students.map(student => [student.id, student.joined]));
  const schedule = data.version === 1 ? defaultSchedule() : validateSchedule(data.schedule);
  const attendance = {};
  for (const [date, source] of Object.entries(data.attendance)) {
    if (!validDate(date) || !isRecord(source)) throw new Error('Некорректные данные посещаемости.');
    const entries = data.version === 1 ? (Object.keys(source).length ? { legacy: source } : {}) : source;
    attendance[date] = {};
    for (const [type, marks] of Object.entries(entries)) {
      if (![...lessonTypes, 'legacy'].includes(type) || !isRecord(marks)) throw new Error('Некорректный тип занятия.');
      attendance[date][type] = {};
      for (const [id, status] of Object.entries(marks)) {
        if (!ids.has(id) || !statuses.includes(status) || joined.get(id) > date) throw new Error('Некорректная отметка посещаемости.');
        attendance[date][type][id] = status;
      }
    }
  }
  const deposits = {};
  if (data.version === 3) {
    if (!isRecord(data.deposits)) throw new Error('Некорректная история пополнений.');
    for (const [month, marks] of Object.entries(data.deposits)) {
      if (!validDate(`${month}-01`) || !/^[0-9]{4}-[0-9]{2}$/.test(month) || !isRecord(marks)) throw new Error('Некорректный месяц пополнения.');
      deposits[month] = {};
      for (const [id, paid] of Object.entries(marks)) {
        if (!ids.has(id) || paid !== true || joined.get(id).slice(0, 7) > month) throw new Error('Некорректное пополнение.');
        deposits[month][id] = true;
      }
    }
  }
  // Undated legacy student.deposit flags remain in the backup, never guessed into a month.
  return { version: 3, students, schedule, attendance, deposits };
}
export function setAttendance(state, id, date, status, type = 'lecture') {
  const student = state.students.find(s => s.id === id);
  if (!student || !validDate(date) || student.joined > date || ![...lessonTypes, 'legacy'].includes(type) || (status !== null && !statuses.includes(status))) throw new Error('Нельзя поставить эту отметку.');
  const attendance = structuredClone(state.attendance);
  attendance[date] ||= {};
  attendance[date][type] ||= {};
  if (status === null) delete attendance[date][type][id];
  else attendance[date][type][id] = status;
  return { ...state, attendance };
}
export function removeStudent(state, id) {
  const attendance = structuredClone(state.attendance);
  Object.values(attendance).forEach(day => Object.values(day).forEach(marks => delete marks[id]));
  const deposits = structuredClone(state.deposits);
  Object.values(deposits).forEach(marks => delete marks[id]);
  return { ...state, students: state.students.filter(s => s.id !== id), attendance, deposits };
}

export function isDepositPaid(state, id, month) { return state.deposits?.[month]?.[id] === true; }
export function setDeposit(state, id, month, paid) {
  const student = state.students.find(s => s.id === id);
  if (!student || !/^[0-9]{4}-[0-9]{2}$/.test(month) || !validDate(`${month}-01`) || student.joined.slice(0, 7) > month || typeof paid !== 'boolean') throw new Error('Нельзя отметить пополнение за этот месяц.');
  const deposits = structuredClone(state.deposits);
  deposits[month] ||= {};
  if (paid) deposits[month][id] = true;
  else delete deposits[month][id];
  return { ...state, deposits };
}
