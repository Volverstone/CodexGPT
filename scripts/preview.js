import { readFile, writeFile } from 'node:fs/promises';
import { emptyState } from '../src/model.js';
const demo = emptyState();
demo.students = ['Алина Соколова', 'Даниил Волков', 'Мария Ким', 'Тимур Алиев', 'София Орлова'].map((name, index) => ({ id: `demo-${index + 1}`, name, group: index < 3 ? 'Группа A1' : 'Группа B1', phone: '', joined: '2027-03-01', deposit: false, notes: index === 0 ? 'Повторить предыдущую тему.\nНа следующем занятии проверить домашнее задание.' : index === 2 ? 'Хороший прогресс на практике.' : '' }));
demo.deposits = { '2027-02': { 'demo-1': true, 'demo-3': true }, '2027-03': { 'demo-2': true, 'demo-3': true, 'demo-4': true } };
demo.students.forEach(s => { s.joined = '2027-02-01'; });
demo.deposits['2027-08'] = { 'demo-1': true, 'demo-3': true, 'demo-4': true };
demo.deposits['2027-09'] = { 'demo-2': true };
demo.schedule.overrides['2027-03-27'] = ['lecture', 'practice'];
demo.attendance['2027-03-27'] = {
  lecture: { 'demo-1': 'present', 'demo-2': 'present', 'demo-3': 'absent', 'demo-4': 'present' },
  practice: { 'demo-1': 'absent', 'demo-2': 'present', 'demo-3': 'present' },
};
demo.attendance['2027-03-26'] = { legacy: { 'demo-1': 'present', 'demo-2': 'absent' } };
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const output = html.replace('<title>Класс — журнал учеников</title>', '<title>Предпросмотр календаря — Класс</title>')
  .replace('<script>(() => {', () => `<script>globalThis.CLASSROOM_PREVIEW = ${JSON.stringify(demo)};\n(() => {`)
  .replace('href="/" class="brand"', 'href="#" class="brand"');
await Promise.all(['preview-calendar.html', 'preview-deposits.html', 'preview-notes.html'].map(file => writeFile(new URL(`../${file}`, import.meta.url), output)));
console.log('Preview ready: preview-calendar.html — fictional data, memory-only, no cloud connection.');
