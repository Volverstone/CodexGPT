import { CloudClient } from './src/cloud.js';
import { STORAGE_KEY, today, emptyState, validateState, setAttendance, removeStudent, validDate } from './src/model.js';

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
const config = globalThis.CLASSROOM_CONFIG || {};
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
let cloudEpoch = 0;
let view = 'attendance';
let editingId = null;
let toastTimer;
const palette = ['sage', 'lavender', 'sand', 'rose'];
function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}
async function save(next) {
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
function formatDate(date) { return new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`)); }
function updateControls() {
  const locked = !!cloudConfigError || !!(cloud && (!cloudReady || !cloud.session || cloudBusy));
  document.querySelectorAll('#add-student, #empty-add, #import, [data-edit], [data-deposit], [data-attendance], #save-student, #delete-student').forEach(element => { element.disabled = locked; });
  document.querySelectorAll('#close-dialog, #cancel-dialog, #signout, #close-account').forEach(element => { element.disabled = cloudBusy; });
}
function handleCloudError(error) {
  if (cloud && !cloud.session) {
    cloudReady = false; state = emptyState();
    $('#student-dialog').close();
  }
  cloudMessage = error.message;
}
function render() {
  const signedIn = !!cloud?.session;
  $('#sync-title').textContent = cloud ? (signedIn ? 'Общий журнал' : 'Войдите для синхронизации') : 'Локальный журнал';
  $('#sync-message').textContent = cloudConfigError || (cloud
    ? (cloudMessage || (signedIn ? 'Изменения загружаются автоматически каждые 10 секунд.' : 'Один аккаунт на компьютере, Android и iPhone. Старые локальные записи можно экспортировать перед входом.'))
    : 'Облачная база не подключена. На разных устройствах записи пока отдельные.');
  $('#account-button').textContent = signedIn ? 'Мой аккаунт' : 'Вход и синхронизация';
  $('#storage-location').textContent = cloudReady ? 'Данные в общей базе' : 'Локальные данные устройства';
  $('#refresh-cloud').hidden = !signedIn;
  $('#refresh-cloud').disabled = cloudBusy;
  $('#storage-warning').hidden = cloudReady || (!sessionOnly && !storageBroken);
  $('#storage-warning').textContent = storageBroken
    ? 'Сохранённые данные повреждены. Изменения заблокированы, чтобы не потерять журнал. Сначала экспортируйте копию, затем восстановите корректный файл.'
    : 'Режим просмотра: браузер не разрешает сохранять данные. Изменения действуют только до закрытия страницы. Экспортируйте журнал или откройте скачанный файл в обычном браузере.';
  $('#save-status').textContent = sessionOnly ? 'Данные только в этой сессии · сделайте экспорт' : storageBroken ? 'Сохранение заблокировано' : '● Изменения сохраняются автоматически';
  if (cloud) $('#save-status').textContent = cloudBusy ? 'Синхронизация…' : cloudReady ? 'Общая база · для изменений нужен интернет' : 'Нет подключения к общему журналу';
  const date = $('#attendance-date').value;
  const marks = state.attendance[date] || {};
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
  $('#unmarked').textContent = `Без отметки: ${eligible.filter(s => !marks[s.id]).length} · Уважительная: ${eligible.filter(s => marks[s.id] === 'excused').length}`;
  const paid = state.students.filter(s => s.deposit).length;
  $('#deposit').innerHTML = `${paid} <span>из ${state.students.length}</span>`;
  $('#deposit-progress').style.width = `${state.students.length ? paid / state.students.length * 100 : 0}%`;
  const query = $('#search').value.trim().toLocaleLowerCase('ru');
  const group = $('#group-filter').value;
  const deposit = $('#deposit-filter').value;
  const students = state.students.filter(s => (!query || `${s.name} ${s.phone}`.toLocaleLowerCase('ru').includes(query)) && (!group || s.group === group) && (!deposit || s.deposit === (deposit === 'paid'))).sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  $('#list-count').textContent = students.length;
  $('#result-count').textContent = `Показано ${students.length} из ${state.students.length} учеников`;
  $('#list-description').textContent = view === 'attendance' ? `Отметки за ${formatDate(date)}` : 'Контакты, группы и информация об учениках';
  if (!students.length) {
    $('#student-list').innerHTML = `<div class="empty"><div class="empty-icon">${state.students.length ? '⌕' : '♧'}</div><h3>${state.students.length ? 'Никого не нашли' : 'Здесь начинается ваш класс'}</h3><p>${state.students.length ? 'Попробуйте изменить поиск или фильтры.' : 'Добавьте первого ученика, чтобы отмечать посещаемость<br>и хранить всю важную информацию в одном месте.'}</p>${state.students.length ? '<button class="button secondary" id="reset-filters">Сбросить фильтры</button>' : '<button class="button primary" id="empty-add">＋ Добавить первого ученика</button>'}</div>`;
    $('#empty-add')?.addEventListener('click', () => openStudent());
    $('#reset-filters')?.addEventListener('click', () => { $('#search').value = ''; $('#group-filter').value = ''; $('#deposit-filter').value = ''; render(); });
    updateControls(); return;
  }
  $('#student-list').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Ученик</th><th>Группа</th><th>${view === 'students' ? 'Присоединился' : 'Посещаемость'}</th><th>Депозит</th><th><span class="sr-only">Редактировать</span></th></tr></thead><tbody>${students.map(s => {
    const index = groups.indexOf(s.group) % palette.length;
    const initials = s.name.split(/\s+/).slice(0, 2).map(n => n[0]).join('');
    return `<tr><td><button class="student-name" data-edit="${s.id}"><span class="avatar ${palette[index]}">${escape(initials)}</span><span><strong>${escape(s.name)}</strong><small>${escape(s.phone || 'Телефон не указан')}</small></span></button></td><td><span class="group-tag ${palette[index]}">${escape(s.group)}</span></td><td>${view === 'students' ? `<span class="joined-date">${formatDate(s.joined)}</span>` : s.joined > date ? '<span class="not-joined">Ещё не присоединился</span>' : `<select class="attendance-select ${marks[s.id] || ''}" data-attendance="${s.id}" aria-label="Посещаемость: ${escape(s.name)}"><option value="">Без отметки</option><option value="present" ${marks[s.id] === 'present' ? 'selected' : ''}>✓ Присутствует</option><option value="absent" ${marks[s.id] === 'absent' ? 'selected' : ''}>− Отсутствует</option><option value="excused" ${marks[s.id] === 'excused' ? 'selected' : ''}>Уважительная</option></select>`}</td><td><button class="deposit-badge ${s.deposit ? 'paid' : ''}" data-deposit="${s.id}" aria-label="Депозит: ${escape(s.name)}" aria-pressed="${s.deposit}">${s.deposit ? '✓ Пополнен' : '○ Не пополнен'}</button></td><td><button class="edit-button" data-edit="${s.id}" aria-label="Редактировать: ${escape(s.name)}">✎</button></td></tr>`;
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
  form.elements.deposit.checked = s?.deposit || false;
  $('#student-dialog').showModal();
}
function confirmAction(title, message) {
  return new Promise(resolve => {
    $('#confirm-title').textContent = title; $('#confirm-text').textContent = message;
    const dialog = $('#confirm-dialog'); dialog.returnValue = ''; dialog.showModal();
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
  });
}
$('#attendance-date').value = today();
$('#attendance-date').addEventListener('change', () => { if (!validDate($('#attendance-date').value)) $('#attendance-date').value = today(); render(); });
for (const id of ['search', 'group-filter', 'deposit-filter']) $(`#${id}`).addEventListener(id === 'search' ? 'input' : 'change', render);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  view = button.dataset.view;
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
  $('#page-title').textContent = $('#breadcrumb').textContent = view === 'students' ? 'Ученики' : 'Посещаемость';
  $('#page-description').textContent = view === 'students' ? 'Ваши ученики и всё важное о каждом из них.' : 'Каждый ученик на виду. Каждое занятие под контролем.';
  $('#list-title').innerHTML = `${view === 'students' ? 'Список учеников' : 'Журнал посещаемости'} <span id="list-count"></span>`;
  $('.date-control').hidden = view === 'students'; render();
}));
$('#add-student').addEventListener('click', () => openStudent());
for (const id of ['close-dialog', 'cancel-dialog']) $(`#${id}`).addEventListener('click', () => $('#student-dialog').close());
$('#student-list').addEventListener('click', async event => {
  const edit = event.target.closest('[data-edit]'); if (edit) openStudent(edit.dataset.edit);
  const deposit = event.target.closest('[data-deposit]');
  if (deposit) await save({ ...state, students: state.students.map(s => s.id === deposit.dataset.deposit ? { ...s, deposit: !s.deposit } : s) });
});
$('#student-list').addEventListener('change', async event => {
  const select = event.target.closest('[data-attendance]');
  if (select) { await save(setAttendance(state, select.dataset.attendance, $('#attendance-date').value, select.value || null)); render(); }
});
async function submitStudent(form) {
  // randomUUID is unavailable on plain HTTP (e.g. a phone accessing a LAN server).
  const id = editingId || (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `s-${Date.now().toString(36)}-${Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, '0')).join('')}`);
  const student = { id, name: form.elements.name.value.trim(), group: form.elements.group.value.trim(), phone: form.elements.phone.value.trim(), joined: form.elements.joined.value, deposit: form.elements.deposit.checked };
  const historicalDates = Object.entries(state.attendance).filter(([, entries]) => entries[student.id]).map(([date]) => date);
  if (historicalDates.some(date => date < student.joined)) { $('#form-error').textContent = 'До этой даты уже есть отметки. Сначала удалите их или выберите более раннюю дату присоединения.'; return; }
  try {
    const next = validateState({ ...state, students: editingId ? state.students.map(s => s.id === editingId ? student : s) : [...state.students, student] });
    if (await save(next)) { $('#student-dialog').close(); toast(editingId ? 'Карточка обновлена' : 'Ученик добавлен'); }
  } catch (e) { $('#form-error').textContent = e.message; }
}
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
    state = result.state; cloudRevision = result.revision; cloudReady = true;
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
    if (cloudReady) $('#account-dialog').close();
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
