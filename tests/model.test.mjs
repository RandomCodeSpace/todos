import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, parseBackup, selectTodos, countViews, viewOf, addDays, nextWeekend, localDate } from '../public/model.js';

const today = '2026-10-17';
const todo = { id: 'one', text: 'Plan the day', completed: false, createdAt: 100, updatedAt: 100 };
test('text is trimmed; empty and oversized todos are rejected', () => {
  assert.equal(normalizeText('  Buy milk\n  '), 'Buy milk');
  for (const input of ['', '   ', null, 123, 'x'.repeat(2001)]) assert.throws(() => normalizeText(input));
});
test('backups round trip valid records and strip unrecognized fields', () => {
  assert.deepEqual(parseBackup(JSON.stringify({ version: 1, todos: [{ ...todo, ignored: true }] })), [todo]);
  assert.deepEqual(parseBackup('{"version":1,"todos":[]}'), []);
});
test('backups keep due dates, flags, notes and completion time', () => {
  const rich = { ...todo, completed: true, due: '2026-10-20', flagged: true, notes: 'Bring forms', completedAt: 150 };
  assert.deepEqual(parseBackup(JSON.stringify({ version: 1, todos: [rich] })), [rich]);
});
test('malformed backups are rejected before writes', () => {
  for (const value of [null, [], {}, { version: 2, todos: [] }, { version: 1, todos: [todo, todo] },
    { version: 1, todos: [{ ...todo, completed: 'false' }] }, { version: 1, todos: [{ ...todo, createdAt: -1 }] },
    { version: 1, todos: [{ ...todo, id: '' }] }, { version: 1, todos: [{ ...todo, text: ' ' }] },
    { version: 1, todos: [{ ...todo, due: '2026-13-01' }] }, { version: 1, todos: [{ ...todo, due: 'tomorrow' }] },
    { version: 1, todos: [{ ...todo, flagged: 'yes' }] }, { version: 1, todos: [{ ...todo, notes: 'x'.repeat(4001) }] },
    { version: 1, todos: [{ ...todo, completedAt: -5 }] }]) {
    assert.throws(() => parseBackup(JSON.stringify(value)));
  }
  assert.throws(() => parseBackup('not JSON'));
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, todos: Array(10001).fill(todo) })));
});
test('views follow due dates; undated records from older versions land in Anytime', () => {
  assert.equal(viewOf(todo, today), 'anytime');
  assert.equal(viewOf({ ...todo, due: '2026-10-15' }, today), 'today');
  assert.equal(viewOf({ ...todo, due: today }, today), 'today');
  assert.equal(viewOf({ ...todo, due: '2026-10-18' }, today), 'upcoming');
  assert.equal(viewOf({ ...todo, due: today, completed: true }, today), 'done');
});
test('selection searches text and notes and sorts by date, then flag, then newest', () => {
  const items = [
    { ...todo, id: 'late', text: 'Late', due: '2026-10-19', createdAt: 500 },
    { ...todo, id: 'soon', text: 'Soon', due: '2026-10-18', createdAt: 100 },
    { ...todo, id: 'flag', text: 'Flag', due: '2026-10-19', flagged: true, createdAt: 50 },
    { ...todo, id: 'milk', text: 'Buy MILK', notes: 'oat', completed: true, createdAt: 200, completedAt: 300 }
  ];
  assert.deepEqual(selectTodos(items, 'upcoming', '', today).map(item => item.id), ['soon', 'flag', 'late']);
  assert.deepEqual(selectTodos(items, 'all', '', today).map(item => item.id), ['soon', 'flag', 'late', 'milk']);
  assert.deepEqual(selectTodos(items, 'done', 'OAT', today).map(item => item.id), ['milk']);
  assert.deepEqual(selectTodos(items, 'all', 'missing', today), []);
});
test('counts include overdue and completed-today totals', () => {
  const now = new Date(2026, 9, 17, 12).getTime();
  const counts = countViews([
    { ...todo, id: 'a', due: '2026-10-10' }, { ...todo, id: 'b', due: today }, { ...todo, id: 'c' },
    { ...todo, id: 'd', due: '2026-11-01' }, { ...todo, id: 'e', completed: true, completedAt: now }
  ], today);
  assert.deepEqual(counts, { today: 2, upcoming: 1, anytime: 1, done: 1, overdue: 1, doneToday: 1 });
});
test('date helpers stay on local calendar days', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(nextWeekend('2026-10-15'), '2026-10-17');
  assert.equal(nextWeekend('2026-10-17'), '2026-10-24');
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});
