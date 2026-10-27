import { CloudClient } from './src/cloud.js';
import { STORAGE_KEY, today, emptyState, validateState, setAttendance, removeStudent, validDate, getLessons, lessonTypes, isDepositPaid, setDeposit } from './src/model.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = emptyState();
let storageBroken = false;
let sessionOnly = false;
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try { state = validateState(JSON.parse(saved)); }
    catch { storageBroken = true; }
  }
  // Some embedded previews and private modes allow reads but reject writes.
  if (!storageBroken) {
    localStorage.setItem(`${STORAGE_KEY}.check`, '1');
    localStorage.removeItem(`${STORAGE_KEY}.check`);
  }
} catch { sessionOnly = true; }
const isPreview = !!globalThis.CLASSROOM_PREVIEW;
if (isPreview) { state = validateState(globalThis.CLASSROOM_PREVIEW); sessionOnly = true; storageBroken = false; }
const config = isPreview ? {} : globalThis.CLASSROOM_CONFIG || {};
let cloud = null;
let cloudConfigError = '';
if (config.url && config.key) {
  try { cloud = new CloudClient(config); }
  catch (error) { cloudConfigError = error.message; }
}
let cloudReady = false;
let cloudBusy = false;
let cloudRevision = 0;
let cloudMessage = '';
let needsMigration = false;
let cloudEpoch = 0;
let activeLesson = 'lecture';
let calendarMonth = today().slice(0, 7);
let customDate = null;
let view = 'attendance';
let editingId = null;
let toastTimer;
const palette = ['sage', 'lavender', 'sand', 'rose'];
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
async function save(next) {
  next = validateState(next);
  if (cloud) {
    if (!cloudReady || !cloud.session) { toast('Сначала войдите в аккаунт и загрузите общий журнал.'); return false; }
    if (cloudBusy) { toast('Дождитесь завершения синхронизации.'); return false; }
    cloudBusy = true; cloudMessage = 'Сохраняем в базу…'; render();
    const epoch = cloudEpoch;
    try {
      const result = await cloud.save(next, cloudRevision);
      if (epoch !== cloudEpoch) return false;
      state = result.state; cloudRevision = result.revision;
      cloudMessage = 'Сохранено в общей базе'; return true;
    } catch (error) {
      if (epoch === cloudEpoch) {
        handleCloudError(error);
        cloudMessage = error.code === 'conflict'
          ? 'Журнал изменён на другом устройстве. Закройте карточку, нажмите «Обновить» и повторите изменение.'
          : error.message;
        toast(cloudMessage);
      }
      return false;
    } finally { cloudBusy = false; render(); }
  }
  if (cloudConfigError) { toast(cloudConfigError); return false; }
  if (storageBroken) { toast('Сохранение заблокировано: прежние данные не удалось прочитать. Экспортируйте их перед восстановлением.'); return false; }
  if (sessionOnly) { state = next; render(); return true; }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); state = next; render(); return true; }
  catch { toast('Не удалось сохранить. Проверьте свободное место и доступ к хранилищу браузера.'); return false; }
}
function selectedMonth() { return $('#attendance-date').value.slice(0, 7); }
function monthName(month) { return new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00`)); }
function formatDate(date) { return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`)); }
function updateControls() {
  const locked = !!cloudConfigError || !!(cloud && (!cloudReady || !cloud.session || cloudBusy));
  document.querySelectorAll('#add-student, #empty-add, #import, [data-edit], [data-deposit], [data-attendance], #save-student, #delete-student, #configure-week, #customize-day, #save-week, #save-day, #reset-day').forEach(element => { element.disabled = locked || (element.hasAttribute('data-deposit') && state.students.find(s => s.id === element.dataset.deposit)?.joined.slice(0, 7) > selectedMonth()); });
  document.querySelectorAll('#close-dialog, #cancel-dialog, #signout, #close-account, [data-close]').forEach(element => { element.disabled = cloudBusy; });
}
function handleCloudError(error) {
  needsMigration = error.code === 'schema';
  if (needsMigration) { cloudReady = false; if (error.snapshot) state = error.snapshot; }
  if (cloud && !cloud.session) {
    cloudReady = false; state = emptyState();
    $('#student-dialog').close(); $('#week-dialog').close(); $('#day-dialog').close();
  }
  cloudMessage = error.message;
}
function render() {
  const signedIn = !!cloud?.session;
  $('#migration-help').hidden = !needsMigration;
  $('#sync-title').textContent = isPreview ? 'Предпросмотр изменений · демо-журнал' : cloud ? (signedIn ? 'Общий журнал' : 'Войдите для синхронизации') : 'Локальный журнал';
  $('#sync-message').textContent = isPreview ? 'Можно менять расписание и отмечать учеников. Здесь только вымышленные данные; рабочий сайт и GitHub не изменены.' : cloudConfigError || (cloud
    ? (cloudMessage || (signedIn ? 'Изменения загружаются автоматически каждые 10 секунд.' : 'Один аккаунт на компьютере, Android и iPhone. Старые локальные записи можно экспортировать перед входом.'))
    : 'Облачная база не подключена. На разных устройствах записи пока отдельные.');
  $('#account-button').textContent = signedIn ? 'Мой аккаунт' : 'Вход и синхронизация';
  $('#storage-location').textContent = needsMigration ? 'Общая база · только просмотр' : cloudReady ? 'Данные в общей базе' : 'Локальные данные устройства';
  $('#refresh-cloud').hidden = !signedIn;
  $('#refresh-cloud').disabled = cloudBusy;
  $('#storage-warning').hidden = isPreview || cloudReady || (!sessionOnly && !storageBroken);
  $('#storage-warning').textContent = storageBroken
    ? 'Сохранённые данные повреждены. Изменения заблокированы, чтобы не потерять журнал. Сначала экспортируйте копию, затем восстановите корректный файл.'
    : 'Режим просмотра: браузер не разрешает сохранять данные. Изменения действуют только до закрытия страницы. Экспортируйте журнал или откройте скачанный файл в обычном браузере.';
  $('#save-status').textContent = isPreview ? 'Демо · изменения только в этом окне' : sessionOnly ? 'Данные только в этой сессии · сделайте экспорт' : storageBroken ? 'Сохранение заблокировано' : '● Изменения сохраняются автоматически';
  if (cloud) $('#save-status').textContent = needsMigration ? 'Только просмотр · требуется SQL-обновление' : cloudBusy ? 'Синхронизация…' : cloudReady ? 'Общая база · для изменений нужен интернет' : 'Нет подключения к общему журналу';
  const date = $('#attendance-date').value;
  const available = availableLessons(date);
  if (!available.includes(activeLesson)) activeLesson = available[0] || null;
  const marks = state.attendance[date]?.[activeLesson] || {};
  renderCalendar(date);
  const dateCaption = `за ${numericDate(date)}${activeLesson ? ' · ' + lessonLabels[activeLesson] : ''}`;
  $('#present-date').textContent = dateCaption;
  $('#absent-date').textContent = dateCaption;
  const eligible = state.students.filter(s => s.joined <= date);
  const groups = [...new Set(state.students.map(s => s.group))].sort((a,b) => a.localeCompare(b, 'ru'));
  const oldGroup = $('#group-filter').value;
  $('#group-filter').innerHTML = '<option value="">Все группы</option>' + groups.map(g => `<option value="${escape(g)}">${escape(g)}</option>`).join('');
  if (groups.includes(oldGroup)) $('#group-filter').value = oldGroup;
  $('#groups').innerHTML = groups.map(g => `<option value="${escape(g)}"></option>`).join('');
  $('#total').textContent = state.students.length;
  $('#nav-count').textContent = state.students.length;
  $('#group-summary').textContent = `Групп: ${groups.length}`;
  $('#present').innerHTML = `${eligible.filter(s => marks[s.id] === 'present').length} <span>учеников</span>`;
  $('#absent').innerHTML = `${eligible.filter(s => marks[s.id] === 'absent').length} <span>учеников</span>`;
  $('#unmarked').textContent = !activeLesson ? 'Выходной день' : `Без отметки: ${eligible.filter(s => !marks[s.id]).length} · Уважительная: ${eligible.filter(s => marks[s.id] === 'excused').length}`;
  const month = selectedMonth();
  const monthStudents = state.students.filter(s => s.joined.slice(0, 7) <= month);
  const paid = monthStudents.filter(s => isDepositPaid(state, s.id, month)).length;
  $('#deposit-month').textContent = monthName(month);
  const undated = state.students.filter(s => s.deposit).length;
  $('#legacy-deposit-note').hidden = !undated;
  $('#legacy-deposit-note').textContent = `Без месяца: ${undated} прежних отметок`;
  $('#legacy-deposit-note').title = 'Прежние отметки без даты сохранены, но не входят в сумму месяца. Выберите нужный месяц и отметьте учеников заново.';
  $('#deposit-filter').options[0].textContent = `Любой депозит · ${month.split('-').reverse().join('.')}`;
  $('#deposit').innerHTML = `${paid} <span>из ${monthStudents.length}</span>`;
  $('#deposit-progress').style.width = `${monthStudents.length ? paid / monthStudents.length * 100 : 0}%`;
  const query = $('#search').value.trim().toLocaleLowerCase('ru');
  const group = $('#group-filter').value;
  const deposit = $('#deposit-filter').value;
  const students = state.students.filter(s => (!query || `${s.name} ${s.phone}`.toLocaleLowerCase('ru').includes(query)) && (!group || s.group === group) && (!deposit || isDepositPaid(state, s.id, month) === (deposit === 'paid'))).sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  $('#list-count').textContent = students.length;
  $('#result-count').textContent = `Показано ${students.length} из ${state.students.length} учеников`;
  $('#list-description').textContent = view === 'attendance' ? `${activeLesson ? lessonLabels[activeLesson] : 'Нет занятий'} · ${numericDate(date)}` : 'Контакты, группы и информация об учениках';
  if (!students.length) {
    $('#student-list').innerHTML = `<div class="empty"><div class="empty-icon">${state.students.length ? '⌕' : '♧'}</div><h3>${state.students.length ? 'Никого не нашли' : 'Здесь начинается ваш класс'}</h3><p>${state.students.length ? 'Попробуйте изменить поиск или фильтры.' : 'Добавьте первого ученика, чтобы отмечать посещаемость<br>и хранить всю важную информацию в одном месте.'}</p>${state.students.length ? '<button class="button secondary" id="reset-filters">Сбросить фильтры</button>' : '<button class="button primary" id="empty-add">＋ Добавить первого ученика</button>'}</div>`;
    $('#empty-add')?.addEventListener('click', () => openStudent());
    $('#reset-filters')?.addEventListener('click', () => { $('#search').value = ''; $('#group-filter').value = ''; $('#deposit-filter').value = ''; render(); });
    updateControls(); return;
  }
  $('#student-list').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Ученик</th><th>Группа</th><th>${view === 'students' ? 'Присоединился' : 'Посещаемость'}</th><th>Депозит<small class="column-month">${escape(monthName(month))}</small></th><th><span class="sr-only">Редактировать</span></th></tr></thead><tbody>${students.map(s => {
    const index = groups.indexOf(s.group) % palette.length;
    const initials = s.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('');
    return `<tr><td><button class="student-name" data-edit="${s.id}"><span class="avatar ${palette[index]}">${escape(initials)}</span><span><strong>${escape(s.name)}</strong><small>${escape(s.phone || 'Телефон не указан')}</small></span></button></td><td><span class="group-tag ${palette[index]}">${escape(s.group)}</span></td><td>${view === 'students' ? `<span class="joined-date">${formatDate(s.joined)}</span>` : !activeLesson ? '<span class="not-joined">Нет занятия</span>' : s.joined > date ? '<span class="not-joined">Ещё не присоединился</span>' : `<select class="attendance-select ${marks[s.id] || ''}" data-attendance="${s.id}" aria-label="Посещаемость: ${escape(s.name)}"><option value="">Без отметки</option><option value="present" ${marks[s.id] === 'present' ? 'selected' : ''}>✓ Присутствует</option><option value="absent" ${marks[s.id] === 'absent' ? 'selected' : ''}>− Отсутствует</option><option value="excused" ${marks[s.id] === 'excused' ? 'selected' : ''}>Уважительная</option></select>`}</td><td><button class="deposit-badge ${isDepositPaid(state, s.id, month) ? 'paid' : ''}" data-deposit="${s.id}" aria-label="Депозит: ${escape(s.name)}" title="За ${escape(monthName(month))}" aria-pressed="${isDepositPaid(state, s.id, month)}">${s.joined.slice(0, 7) > month ? 'Ещё не учится' : isDepositPaid(state, s.id, month) ? '✓ Пополнен' : '○ Не пополнен'}</button></td><td><button class="edit-button" data-edit="${s.id}" aria-label="Редактировать: ${escape(s.name)}">✎</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
  updateControls();
}
function openStudent(id = null) {
  if (cloudBusy || (cloud && !cloudReady)) return;
  editingId = id;
  const s = state.students.find(s => s.id === id);
  const form = $('#student-form'); form.reset();
  $('#dialog-title').textContent = s ? 'Редактировать ученика' : 'Новый ученик';
  $('#delete-student').hidden = !s;
  $('#form-error').textContent = '';
  for (const key of ['name', 'group', 'phone', 'joined']) form.elements[key].value = s?.[key] || (key === 'joined' ? today() : '');
  form.elements.deposit.checked = !!s && isDepositPaid(state, s.id, selectedMonth());
  $('#form-deposit-month').textContent = monthName(selectedMonth());
  form.elements.deposit.disabled = form.elements.joined.value.slice(0, 7) > selectedMonth();
  $('#student-dialog').showModal();
}
function confirmAction(title, message) {
  return new Promise(resolve => {
    $('#confirm-title').textContent = title; $('#confirm-text').textContent = message;
    const dialog = $('#confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}
function setTheme(theme, persist = false) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  $('#theme-toggle').setAttribute('aria-pressed', String(dark));
  $('#theme-toggle').setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
  $('#theme-toggle').title = dark ? 'Светлая тема' : 'Тёмная тема';
  $('.theme-label').textContent = dark ? 'Светлая тема' : 'Тёмная тема';
  $('#theme-icon').innerHTML = dark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>'
    : '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>';
  $('meta[name="theme-color"]').content = dark ? '#1c2822' : '#f6f7f3';
  if (persist) { try { localStorage.setItem('classroom.theme', dark ? 'dark' : 'light'); } catch {} }
}
setTheme(document.documentElement.dataset.theme);
$('#theme-toggle').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark', true));
window.addEventListener('storage', event => { if (event.key === 'classroom.theme') setTheme(event.newValue); });
const lessonLabels = { lecture: 'Лекция', practice: 'Практика', legacy: 'Прежние отметки' };
const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
function numericDate(date) { return date.split('-').reverse().join('.'); }
function availableLessons(date) {
  const scheduled = getLessons(state, date);
  return [...scheduled, ...['lecture', 'practice', 'legacy'].filter(type => !scheduled.includes(type) && Object.keys(state.attendance[date]?.[type] || {}).length)];
}
function renderCalendar(date) {
  const [year, month] = calendarMonth.split('-').map(Number);
  const monthStart = new Date(year, month - 1, 1, 12);
  $('#calendar-month-label').textContent = new Intl.DateTimeFormat('ru', { month: 'long', year: 'numeric' }).format(monthStart);
  const first = (monthStart.getDay() + 6) % 7;
  const days = new Date(year, month, 0, 12).getDate();
  $('#calendar-grid').innerHTML = '<span class="calendar-blank"></span>'.repeat(first) + Array.from({ length: days }, (_, index) => {
    const value = `${calendarMonth}-${String(index + 1).padStart(2, '0')}`;
    const types = getLessons(state, value);
    const legacy = Object.keys(state.attendance[value]?.legacy || {}).length > 0;
    const override = Object.hasOwn(state.schedule.overrides, value);
    const label = `${numericDate(value)}: ${types.map(t => lessonLabels[t]).join(', ') || 'выходной'}${override ? ', особый день' : ''}${legacy ? ', есть прежние отметки' : ''}`;
    return `<button class="calendar-cell ${value === date ? 'selected' : ''} ${value === today() ? 'is-today' : ''}" data-date="${value}" aria-label="${escape(label)}" aria-pressed="${value === date}"><span>${index + 1}</span>${override ? '<i class="override-mark" title="Особый день"></i>' : ''}<span class="calendar-dots">${types.map(type => `<i class="lesson-dot ${type}"></i>`).join('')}${legacy ? '<i class="lesson-dot legacy"></i>' : ''}</span></button>`;
  }).join('');
  const scheduled = getLessons(state, date);
  $('#selected-day-label').textContent = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${date}T12:00:00`));
  $('#day-source').textContent = Object.hasOwn(state.schedule.overrides, date) ? 'Особый день' : 'По расписанию';
  $('#lesson-tabs').innerHTML = availableLessons(date).map(type => `<button class="lesson-tab ${type} ${type === activeLesson ? 'active' : ''}" data-lesson="${type}" aria-pressed="${type === activeLesson}"><i class="lesson-dot ${type}"></i>${lessonLabels[type]}${!scheduled.includes(type) && type !== 'legacy' ? '<small>есть отметки</small>' : ''}</button>`).join('');
  $('#lesson-hint').textContent = activeLesson === 'legacy'
    ? 'Старые отметки сохранены отдельно: раньше у них не было типа занятия.'
    : !activeLesson ? 'Занятий нет. Назначьте лекцию или практику на этот день.'
    : scheduled.length > 1 ? 'Два занятия в один день — два независимых списка посещаемости.'
    : !scheduled.includes(activeLesson) ? 'Занятие убрано из расписания, но его отметки сохранены.'
    : 'Отмечайте присутствие учеников на выбранном занятии ниже.';
  $('#weekly-summary').textContent = lessonTypes.map(type => {
    const names = [1,2,3,4,5,6,0].filter(day => state.schedule.week[day].includes(type)).map(day => dayNames[day]);
    return `${type === 'lecture' ? 'Лекции' : 'Практика'}: ${names.join(', ') || 'не назначены'}`;
  }).join(' · ');
}
$('#calendar-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-date]');
  if (button) { $('#attendance-date').value = button.dataset.date; render(); }
});
$('#lesson-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-lesson]');
  if (button) { activeLesson = button.dataset.lesson; render(); }
});
for (const [id, offset] of [['previous-month', -1], ['next-month', 1]]) {
  $(`#${id}`).addEventListener('click', () => {
    const [year, month] = calendarMonth.split('-').map(Number);
    const date = new Date(year, month - 1 + offset, 1, 12);
    if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
    calendarMonth = `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`; render();
  });
}
$('#calendar-today').addEventListener('click', () => { $('#attendance-date').value = today(); calendarMonth = today().slice(0, 7); render(); });
$('#configure-week').addEventListener('click', () => {
  $('#week-error').textContent = '';
  $('#week-fields').innerHTML = '<div class="week-field-header"><span>День</span><span>Лекция</span><span>Практика</span></div>' + [1,2,3,4,5,6,0].map(day => `<div class="week-field-row"><strong>${['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'][day]}</strong>${lessonTypes.map(type => `<label><input type="checkbox" data-week-day="${day}" value="${type}" aria-label="${dayNames[day]}: ${lessonLabels[type]}" ${state.schedule.week[day].includes(type) ? 'checked' : ''}></label>`).join('')}</div>`).join('');
  $('#week-dialog').showModal();
});
async function saveWeek() {
  if (cloudBusy) return;
  const week = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [...document.querySelectorAll(`[data-week-day="${day}"]:checked`)].map(input => input.value)]));
  if (await save({ ...state, schedule: { ...state.schedule, week } })) { $('#week-dialog').close(); toast('Недельное расписание сохранено'); }
  else $('#week-error').textContent = 'Расписание не сохранено. Проверьте сообщение о синхронизации.';
}
$('#save-week').addEventListener('click', event => { event.preventDefault(); saveWeek(); });
$('#week-form').addEventListener('submit', event => { event.preventDefault(); saveWeek(); });
$('#customize-day').addEventListener('click', () => {
  customDate = $('#attendance-date').value;
  $('#day-dialog-title').textContent = numericDate(customDate);
  const types = getLessons(state, customDate);
  lessonTypes.forEach(type => { $('#day-form').elements[type].checked = types.includes(type); });
  $('#day-error').textContent = ''; $('#reset-day').hidden = !Object.hasOwn(state.schedule.overrides, customDate);
  $('#day-dialog').showModal();
});
async function saveDay(reset = false) {
  if (cloudBusy || !customDate) return;
  const overrides = { ...state.schedule.overrides };
  if (reset) delete overrides[customDate];
  else overrides[customDate] = lessonTypes.filter(type => $('#day-form').elements[type].checked);
  if (await save({ ...state, schedule: { ...state.schedule, overrides } })) { $('#day-dialog').close(); toast(reset ? 'День снова по недельному расписанию' : 'Настройки дня сохранены'); }
  else $('#day-error').textContent = 'День не сохранён. Проверьте сообщение о синхронизации.';
}
$('#save-day').addEventListener('click', event => { event.preventDefault(); saveDay(); });
$('#day-form').addEventListener('submit', event => { event.preventDefault(); saveDay(); });
$('#reset-day').addEventListener('click', () => saveDay(true));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => { if (!cloudBusy) document.getElementById(button.dataset.close).close(); }));
$('#attendance-date').value = isPreview ? '2027-03-27' : today();
calendarMonth = $('#attendance-date').value.slice(0, 7);
$('#attendance-date').addEventListener('change', () => { if (!validDate($('#attendance-date').value)) $('#attendance-date').value = today(); calendarMonth = $('#attendance-date').value.slice(0, 7); render(); });
for (const id of ['search', 'group-filter', 'deposit-filter']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', render);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
  $('#page-title').textContent = $('#breadcrumb').textContent = view === 'students' ? 'Ученики' : 'Посещаемость';
  $('#page-description').textContent = view === 'students' ? 'Ваши ученики и всё важное о каждом из них.' : 'Каждый ученик на виду. Каждое занятие под контролем.';
  $('#list-title').innerHTML = `${view === 'students' ? 'Список учеников' : 'Журнал посещаемости'} <span id="list-count"></span>`;
  $('.date-control').hidden = false; $('#calendar-panel').hidden = view === 'students'; render();
}));
$('#add-student').addEventListener('click', () => openStudent());
for (const id of ['close-dialog', 'cancel-dialog']) $(`#${id}`).addEventListener('click', () => $('#student-dialog').close());
$('#student-list').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit]'); if (edit) openStudent(edit.dataset.edit);
  const deposit = event.target.closest('[data-deposit]');
  if (deposit) await save(setDeposit(state, deposit.dataset.deposit, selectedMonth(), !isDepositPaid(state, deposit.dataset.deposit, selectedMonth())));
});
$('#student-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-attendance]');
  if (select) { await save(setAttendance(state, select.dataset.attendance, $('#attendance-date').value, select.value || null, activeLesson)); render(); }
});
async function submitStudent(form) {
  // randomUUID is unavailable on plain HTTP (e.g. a phone accessing a LAN server).
  const id = editingId || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `s-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('')}`);
  const student = { id, name: form.elements.name.value.trim(), group: form.elements.group.value.trim(), phone: form.elements.phone.value.trim(), joined: form.elements.joined.value, deposit: state.students.find(s => s.id === id)?.deposit || false };
  const historicalDates = Object.entries(state.attendance).filter(([, lessons]) => Object.values(lessons).some(entries => entries[student.id])).map(([date]) => date);
  if (historicalDates.some(date => date < student.joined)) { $('#form-error').textContent = 'До этой даты уже есть отметки. Сначала удалите их или выберите более раннюю дату присоединения.'; return; }
  try {
    const next = validateState({ ...state, students: editingId ? state.students.map(s => s.id === editingId ? student : s) : [...state.students, student] });
    if (Object.entries(next.deposits).some(([month, marks]) => marks[id] && month < student.joined.slice(0, 7))) { $('#form-error').textContent = 'До даты присоединения уже есть пополнения. Выберите более раннюю дату.'; return; }
    const monthly = student.joined.slice(0, 7) > selectedMonth() && !form.elements.deposit.checked ? next : setDeposit(next, id, selectedMonth(), form.elements.deposit.checked);
    if (await save(monthly)) { $('#student-dialog').close(); toast(editingId ? 'Карточка обновлена' : 'Ученик добавлен'); }
  } catch (e) { $('#form-error').textContent = e.message; }
}
$('#student-form [name=joined]').addEventListener('change', event => { const input = $('#student-form').elements.deposit; input.disabled = event.target.value.slice(0, 7) > selectedMonth(); if (input.disabled) input.checked = false; });
$('#student-form').addEventListener('submit', event => { event.preventDefault(); submitStudent(event.target); });
// All data stays in JS: do not depend on sandbox permission to submit HTML forms.
$('#save-student').addEventListener('click', event => {
  event.preventDefault();
  if ($('#student-form').reportValidity()) submitStudent($('#student-form'));
});
$('#confirm-dialog').addEventListener('click', event => {
  const button = event.target.closest('button[value]');
  if (button) { event.preventDefault(); $('#confirm-dialog').close(button.value); }
});
$('#delete-student').addEventListener('click', async () => {
  const id = editingId;
  if (await confirmAction('Удалить ученика?', 'Карточка и все отметки этого ученика будут удалены. Это действие нельзя отменить.')) {
    if (await save(removeStudent(state, id))) { $('#student-dialog').close(); toast('Ученик удалён'); }
  }
});
$('#export').addEventListener('click', () => {
  let content;
  try { content = storageBroken && !cloudReady ? localStorage.getItem(STORAGE_KEY) : JSON.stringify(state, null, 2); } catch { toast('Не удалось прочитать данные'); return; }
  const url = URL.createObjectURL(new Blob([content || '{}'], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `classroom-${today()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Резервная копия выгружена. Она содержит телефоны учеников — храните её бережно.');
});
$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Файл слишком большой (максимум 5 МБ).');
    const next = validateState(JSON.parse(await file.text()));
    if (await confirmAction('Восстановить журнал?', `Ученики в копии: ${next.students.length}. Текущие данные будут полностью заменены. Перед этим рекомендуем сделать экспорт.`)) {
      const previousBroken = storageBroken; storageBroken = false;
      if (await save(next)) toast('Резервная копия восстановлена'); else storageBroken = previousBroken;
    }
  } catch (e) { toast(e instanceof SyntaxError ? 'Файл не является корректной JSON-копией.' : e.message); }
  event.target.value = '';
});
function updateAccount() {
  const signedIn = !!cloud?.session;
  $('#account-description').textContent = cloudConfigError || (!cloud
    ? 'Владелец сайта ещё не подключил облачную базу. Инструкция подключения находится в README репозитория.'
    : signedIn ? `Вы вошли: ${cloud.session.user?.email || 'ваш аккаунт'}. Используйте этот же аккаунт на всех устройствах.`
    : 'Войдите на всех устройствах с одним email и паролем. Перед входом экспортируйте старый локальный журнал, если он вам нужен.');
  $('#account-form').hidden = !cloud || signedIn;
  $('#signout').hidden = !signedIn;
}
async function refreshCloud({ manual = false } = {}) {
  if (!cloud?.session || cloudBusy) return;
  if (!manual && [...document.querySelectorAll('dialog')].some(d => d.open)) return;
  cloudBusy = true;
  const epoch = cloudEpoch;
  try {
    const result = await cloud.load();
    if (epoch !== cloudEpoch) return;
    state = result.state; cloudRevision = result.revision; cloudReady = true; needsMigration = false;
    cloudMessage = 'Обновлено. Другие устройства проверяются каждые 10 секунд.';
  } catch (error) { if (epoch === cloudEpoch) handleCloudError(error); }
  finally { cloudBusy = false; render(); updateAccount(); }
}
$('#account-button').addEventListener('click', () => { updateAccount(); $('#account-error').textContent = ''; $('#account-dialog').showModal(); });
$('#close-account').addEventListener('click', () => $('#account-dialog').close());
async function authenticate(signup) {
  if (!cloud || cloudBusy || !$('#account-form').reportValidity()) return;
  cloudBusy = true; $('#signin').disabled = $('#signup').disabled = true;
  $('#account-error').textContent = '';
  const form = $('#account-form');
  try {
    if (signup) await cloud.signUp(form.elements.email.value.trim(), form.elements.password.value);
    else await cloud.signIn(form.elements.email.value.trim(), form.elements.password.value);
    form.elements.password.value = '';
    if (!cloud.session) { $('#account-error').textContent = 'Подтвердите email по письму, затем войдите здесь с паролем.'; return; }
    cloudEpoch++; cloudReady = false; state = emptyState();
    cloudBusy = false; await refreshCloud({ manual: true });
    if (cloudReady || needsMigration) $('#account-dialog').close();
  } catch (error) { $('#account-error').textContent = error.message; }
  finally { cloudBusy = false; $('#signin').disabled = $('#signup').disabled = false; render(); updateAccount(); }
}
$('#account-form').addEventListener('submit', event => { event.preventDefault(); authenticate(false); });
$('#signin').addEventListener('click', event => { event.preventDefault(); authenticate(false); });
$('#signup').addEventListener('click', () => authenticate(true));
$('#signout').addEventListener('click', async () => {
  if (cloudBusy) { toast('Дождитесь синхронизации.'); return; }
  const epoch = ++cloudEpoch; cloudReady = false; cloudBusy = true;
  state = emptyState(); cloudMessage = ''; render();
  try { await cloud.signOut(); }
  catch { toast('Вы вышли на этом устройстве. Сервер не подтвердил завершение сессии.'); }
  finally {
    if (epoch === cloudEpoch) { cloudBusy = false; render(); updateAccount(); $('#account-dialog').close(); }
  }
});
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (cloudBusy) event.preventDefault(); }));
// Email confirmation redirects may include tokens. We use password login, not URL tokens.
if (/access_token=|refresh_token=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
$('#refresh-cloud').addEventListener('click', () => refreshCloud({ manual: true }));
window.addEventListener('online', () => refreshCloud());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloud(); });
setInterval(() => { if (!document.hidden) refreshCloud(); }, 10000);
if (cloud?.session) { state = emptyState(); refreshCloud({ manual: true }); }

render();
if (storageBroken) toast('Сохранённые данные не удалось прочитать. Экспортируйте их для восстановления; перезапись заблокирована.');
// The downloadable file / embedded preview needs no external files or network.
// Only the hosted build enables the install manifest and offline cache.
if (document.querySelector('meta[name="classroom-hosted"]') && /^https?:$/.test(location.protocol)) {
  const manifest = document.createElement('link');
  manifest.rel = 'manifest'; manifest.href = './manifest.webmanifest'; document.head.append(manifest);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
