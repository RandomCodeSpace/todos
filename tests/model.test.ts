import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, normalizeListName, parseBackup, selectTodos, countViews, viewOf, addDays, nextWeekend, nextWeek, nextDue, localDate,
  canDepend, blockersOf, byId, subtasksOf, parseQuickAdd
} from '../src/model.ts';
import type { List, Todo } from '../src/model.ts';

const today = '2026-10-17';
const todo: Todo = { id: 'one', text: 'Plan the day', completed: false, createdAt: 100, updatedAt: 100 };
const list: List = { id: 'work', name: 'Work', color: 'orange', order: 0, createdAt: 100, updatedAt: 100 };
test('text is trimmed; empty and oversized todos and list names are rejected', () => {
  assert.equal(normalizeText('  Buy milk\n  '), 'Buy milk');
  for (const input of ['', '   ', null, 123, 'x'.repeat(2001)]) assert.throws(() => normalizeText(input));
  assert.equal(normalizeListName(' Groceries '), 'Groceries');
  for (const input of ['', ' ', 'x'.repeat(61), 5]) assert.throws(() => normalizeListName(input));
});
test('backups round trip valid records and strip unrecognized fields', () => {
  assert.deepEqual(parseBackup(JSON.stringify({ version: 1, todos: [{ ...todo, ignored: true }] })), { todos: [todo], lists: [] });
  assert.deepEqual(parseBackup('{"version":1,"todos":[]}'), { todos: [], lists: [] });
});
test('backups keep dates, times, stars, notes, lists, subtasks, dependencies and repeats', () => {
  const rich: Todo = { ...todo, completed: true, due: '2026-10-20', time: '09:30', flagged: true, notes: 'Bring forms', completedAt: 150, listId: 'work', blockedBy: ['two'], repeat: 'weekly' };
  const sub: Todo = { ...todo, id: 'sub', parentId: 'one', order: 2 };
  assert.deepEqual(parseBackup(JSON.stringify({ version: 2, todos: [rich, sub], lists: [list] })), { todos: [rich, sub], lists: [list] });
});
test('malformed backups are rejected before writes', () => {
  for (const value of [null, [], {}, { version: 3, todos: [] }, { version: 1, todos: [todo, todo] },
    { version: 1, todos: [{ ...todo, completed: 'false' }] }, { version: 1, todos: [{ ...todo, createdAt: -1 }] },
    { version: 1, todos: [{ ...todo, id: '' }] }, { version: 1, todos: [{ ...todo, text: ' ' }] },
    { version: 1, todos: [{ ...todo, due: '2026-13-01' }] }, { version: 1, todos: [{ ...todo, due: 'tomorrow' }] },
    { version: 1, todos: [{ ...todo, flagged: 'yes' }] }, { version: 1, todos: [{ ...todo, notes: 'x'.repeat(4001) }] },
    { version: 1, todos: [{ ...todo, completedAt: -5 }] }, { version: 2, todos: [{ ...todo, time: '25:00' }], lists: [] },
    { version: 2, todos: [{ ...todo, repeat: 'hourly' }], lists: [] }, { version: 2, todos: [{ ...todo, blockedBy: 'two' }], lists: [] },
    { version: 2, todos: [{ ...todo, parentId: 7 }], lists: [] }, { version: 2, todos: [], lists: [{ ...list, color: 'mauve' }] },
    { version: 2, todos: [], lists: [list, list] }, { version: 2, todos: [], lists: [{ ...list, name: '' }] }]) {
    assert.throws(() => parseBackup(JSON.stringify(value)));
  }
  assert.throws(() => parseBackup('not JSON'));
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, todos: Array(10001).fill(todo) })));
});
test('views follow due dates; undated records from older versions land in All', () => {
  assert.equal(viewOf(todo, today), 'all');
  assert.equal(viewOf({ ...todo, due: '2026-10-15' }, today), 'today');
  assert.equal(viewOf({ ...todo, due: today }, today), 'today');
  assert.equal(viewOf({ ...todo, due: '2026-10-18' }, today), 'upcoming');
  assert.equal(viewOf({ ...todo, due: today, completed: true }, today), 'done');
});
test('selection sorts by date, time, star and age, hides subtasks and searches them', () => {
  const items: Todo[] = [
    { ...todo, id: 'late', text: 'Late', due: '2026-10-19', createdAt: 500 },
    { ...todo, id: 'soon', text: 'Soon', due: '2026-10-18', time: '10:00', createdAt: 100 },
    { ...todo, id: 'early', text: 'Early', due: '2026-10-18', time: '08:00', createdAt: 90 },
    { ...todo, id: 'flag', text: 'Flag', due: '2026-10-19', flagged: true, createdAt: 50, listId: 'work' },
    { ...todo, id: 'milk', text: 'Buy MILK', notes: 'oat', completed: true, createdAt: 200, completedAt: 300 },
    { ...todo, id: 'step', text: 'Pack the passport', parentId: 'late' }
  ];
  assert.deepEqual(selectTodos(items, 'upcoming', '', today).map(item => item.id), ['early', 'soon', 'flag', 'late']);
  assert.deepEqual(selectTodos(items, 'all', '', today).map(item => item.id), ['early', 'soon', 'flag', 'late']);
  assert.deepEqual(selectTodos(items, 'starred', '', today).map(item => item.id), ['flag']);
  assert.deepEqual(selectTodos(items, 'list:work', '', today).map(item => item.id), ['flag']);
  assert.deepEqual(selectTodos(items, 'done', '', today).map(item => item.id), ['milk']);
  assert.deepEqual(selectTodos(items, 'today', 'OAT', today).map(item => item.id), ['milk']);
  assert.deepEqual(selectTodos(items, 'today', 'passport', today).map(item => item.id), ['late']);
  assert.deepEqual(selectTodos(items, 'all', 'missing', today), []);
  // Tasks completed in this session keep their place.
  assert.deepEqual(selectTodos([{ ...items[0] as Todo, completed: true }], 'upcoming', '', today, new Set(['late'])).map(item => item.id), ['late']);
  // A subtask whose parent is missing behaves as a task.
  assert.deepEqual(selectTodos([{ ...todo, parentId: 'gone' }], 'all', '', today).map(item => item.id), ['one']);
});
test('subtasks follow their manual order', () => {
  const items: Todo[] = [{ ...todo, id: 'b', parentId: 'one', order: 1 }, { ...todo, id: 'a', parentId: 'one', order: 0 }, todo];
  assert.deepEqual(subtasksOf(items, 'one').map(item => item.id), ['a', 'b']);
});
test('counts cover views, stars, lists, overdue and completed today, ignoring subtasks', () => {
  const now = new Date(2026, 9, 17, 12).getTime();
  const counts = countViews([
    { ...todo, id: 'a', due: '2026-10-10' }, { ...todo, id: 'b', due: today, flagged: true, listId: 'work' }, { ...todo, id: 'c' },
    { ...todo, id: 'd', due: '2026-11-01' }, { ...todo, id: 'e', completed: true, completedAt: now }, { ...todo, id: 'f', parentId: 'b' }
  ], today);
  assert.deepEqual(counts, { today: 2, upcoming: 1, starred: 1, all: 4, done: 1, overdue: 1, doneToday: 1, lists: { work: 1 } });
});
test('dependencies block until done and refuse cycles, self links and subtasks', () => {
  const items: Todo[] = [
    { ...todo, id: 'a' }, { ...todo, id: 'b', blockedBy: ['a', 'gone'] }, { ...todo, id: 'c', blockedBy: ['b'] },
    { ...todo, id: 'sub', parentId: 'a' }, { ...todo, id: 'd', completed: true }
  ];
  const index = byId(items);
  assert.deepEqual(blockersOf(items[1] as Todo, index).map(item => item.id), ['a']);
  assert.deepEqual(blockersOf({ ...todo, blockedBy: ['d'] }, index), []);
  assert.equal(canDepend(items, 'c', 'a'), true);
  assert.equal(canDepend(items, 'a', 'c'), false);
  assert.equal(canDepend(items, 'a', 'a'), false);
  assert.equal(canDepend(items, 'a', 'sub'), false);
  assert.equal(canDepend(items, 'sub', 'b'), false);
});
test('date helpers stay on local calendar days', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(nextWeekend('2026-10-15'), '2026-10-17');
  assert.equal(nextWeekend('2026-10-17'), '2026-10-24');
  assert.equal(nextWeek('2026-10-17'), '2026-10-19');
  assert.equal(nextWeek('2026-10-19'), '2026-10-26');
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});
test('repeats advance to the next matching day', () => {
  assert.equal(nextDue('2026-10-17', 'daily'), '2026-10-18');
  assert.equal(nextDue('2026-10-16', 'weekdays'), '2026-10-19');
  assert.equal(nextDue('2026-10-17', 'weekly'), '2026-10-24');
  assert.equal(nextDue('2026-01-31', 'monthly'), '2026-02-28');
  assert.equal(nextDue('2024-02-29', 'yearly'), '2025-02-28');
});
test('quick add reads dates, times, lists and stars, and leaves the rest as text', () => {
  const lists: List[] = [list, { ...list, id: 'home', name: 'Home Life' }];
  assert.deepEqual(parseQuickAdd('Call dentist tomorrow 9am #work !', today, lists), {
    text: 'Call dentist', due: '2026-10-18', time: '09:00', listId: 'work', flagged: true,
    tokens: [{ start: 13, end: 21, kind: 'date' }, { start: 22, end: 25, kind: 'time' }, { start: 26, end: 31, kind: 'list' }, { start: 32, end: 33, kind: 'star' }]
  });
  assert.equal(parseQuickAdd('Report on friday at 5:30 pm', today, lists).due, '2026-10-23');
  assert.equal(parseQuickAdd('Report on friday at 5:30 pm', today, lists).time, '17:30');
  assert.equal(parseQuickAdd('Report on friday at 5:30 pm', today, lists).text, 'Report');
  assert.equal(parseQuickAdd('Rent Nov 1', today, lists).due, '2026-11-01');
  assert.equal(parseQuickAdd('Taxes 15 april', today, lists).due, '2027-04-15');
  assert.equal(parseQuickAdd('Stretch in 3 days', today, lists).due, '2026-10-20');
  assert.equal(parseQuickAdd('Plan next week', today, lists).due, '2026-10-19');
  assert.equal(parseQuickAdd('Sync 14:00', today, lists).time, '14:00');
  assert.equal(parseQuickAdd('Sync 14:00', today, lists).due, undefined);
  assert.equal(parseQuickAdd('Laundry #homelife', today, lists).listId, 'home');
  // Unknown lists, impossible dates and plain words stay literal.
  assert.deepEqual(parseQuickAdd('Read #unknown on Feb 30', today, lists), { text: 'Read #unknown on Feb 30', tokens: [] });
  assert.deepEqual(parseQuickAdd('Wow!', today, lists).tokens, []);
  // A draft made only of tokens is the task text; skipped kinds are not read.
  assert.deepEqual(parseQuickAdd('Tomorrow', today, lists), { text: 'Tomorrow', tokens: [] });
  assert.equal(parseQuickAdd('Monday night recap', today, lists, new Set(['date'])).text, 'Monday night recap');
});
