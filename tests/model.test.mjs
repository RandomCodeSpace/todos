import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, parseBackup, selectTodos } from '../public/model.js';

const todo = { id: 'one', text: 'Plan the day', completed: false, createdAt: 100, updatedAt: 100 };
test('text is trimmed; empty and oversized todos are rejected', () => {
  assert.equal(normalizeText('  Buy milk\n  '), 'Buy milk');
  for (const input of ['', '   ', null, 123, 'x'.repeat(2001)]) assert.throws(() => normalizeText(input));
});
test('backups round trip valid records and strip unrecognized fields', () => {
  assert.deepEqual(parseBackup(JSON.stringify({ version: 1, todos: [{ ...todo, ignored: true }] })), [todo]);
  assert.deepEqual(parseBackup('{"version":1,"todos":[]}'), []);
});
test('malformed backups are rejected before writes', () => {
  for (const value of [null, [], {}, { version: 2, todos: [] }, { version: 1, todos: [todo, todo] },
    { version: 1, todos: [{ ...todo, completed: 'false' }] }, { version: 1, todos: [{ ...todo, createdAt: -1 }] },
    { version: 1, todos: [{ ...todo, id: '' }] }, { version: 1, todos: [{ ...todo, text: ' ' }] }]) {
    assert.throws(() => parseBackup(JSON.stringify(value)));
  }
  assert.throws(() => parseBackup('not JSON'));
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, todos: Array(10001).fill(todo) })));
});
test('filter and search are case insensitive and keep newest active items first', () => {
  const done = { ...todo, id: 'two', text: 'Buy MILK', completed: true, createdAt: 200 };
  const newer = { ...todo, id: 'three', text: 'Go outside', createdAt: 300 };
  const items = [todo, done, newer];
  assert.deepEqual(selectTodos(items, 'all', '').map(item => item.id), ['three', 'one', 'two']);
  assert.deepEqual(selectTodos(items, 'active', '').map(item => item.id), ['three', 'one']);
  assert.deepEqual(selectTodos(items, 'completed', 'milk'), [done]);
  assert.deepEqual(selectTodos(items, 'all', 'missing'), []);
});
