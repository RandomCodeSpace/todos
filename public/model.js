export function normalizeText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new Error('Use between 1 and 2,000 characters.');
  }
  return value.trim();
}

export function parseBackup(source) {
  const data = JSON.parse(source);
  if (!data || data.version !== 1 || !Array.isArray(data.todos) || data.todos.length > 10000) {
    throw new Error('Choose a Tuck backup with at most 10,000 todos.');
  }
  const ids = new Set();
  return data.todos.map(item => {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
      || typeof item.completed !== 'boolean' || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0
      || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < item.createdAt) {
      throw new Error('This backup contains an invalid or duplicate todo.');
    }
    ids.add(item.id);
    return { id: item.id, text: normalizeText(item.text), completed: item.completed, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
}

export function selectTodos(todos, filter, query) {
  const search = query.trim().toLocaleLowerCase();
  return todos.filter(todo => (filter === 'all' || todo.completed === (filter === 'completed'))
    && todo.text.toLocaleLowerCase().includes(search))
    .sort((a, b) => Number(a.completed) - Number(b.completed) || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}
