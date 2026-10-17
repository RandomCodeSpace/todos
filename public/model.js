export const VIEWS = ['today', 'upcoming', 'anytime', 'done'];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function normalizeText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new Error('Use between 1 and 2,000 characters.');
  }
  return value.trim();
}

export function normalizeNotes(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 4000) throw new Error('Keep notes under 4,000 characters.');
  return value.trim();
}

export function isDate(value) { return typeof value === 'string' && DATE.test(value); }

// Local calendar dates as YYYY-MM-DD strings avoid time zone drift.
export function localDate(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function addDays(day, count) {
  const [year, month, date] = day.split('-').map(Number);
  return localDate(new Date(year, month - 1, date + count));
}

export function nextWeekend(day) {
  const [year, month, date] = day.split('-').map(Number);
  const weekday = new Date(year, month - 1, date).getDay();
  return addDays(day, weekday === 6 ? 7 : 6 - weekday);
}

export function viewOf(todo, today) {
  if (todo.completed) return 'done';
  if (!todo.due) return 'anytime';
  return todo.due <= today ? 'today' : 'upcoming';
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
      || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < item.createdAt
      || (item.due !== undefined && !isDate(item.due))
      || (item.flagged !== undefined && typeof item.flagged !== 'boolean')
      || (item.completedAt !== undefined && (!Number.isSafeInteger(item.completedAt) || item.completedAt < 0))) {
      throw new Error('This backup contains an invalid or duplicate todo.');
    }
    ids.add(item.id);
    const todo = { id: item.id, text: normalizeText(item.text), completed: item.completed, createdAt: item.createdAt, updatedAt: item.updatedAt };
    if (item.due !== undefined) todo.due = item.due;
    if (item.flagged) todo.flagged = true;
    const notes = normalizeNotes(item.notes);
    if (notes) todo.notes = notes;
    if (item.completedAt !== undefined) todo.completedAt = item.completedAt;
    return todo;
  });
}

function compare(a, b) {
  if (a.completed || b.completed) {
    return Number(a.completed) - Number(b.completed)
      || (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt) || a.id.localeCompare(b.id);
  }
  return (a.due || '9999').localeCompare(b.due || '9999')
    || Number(Boolean(b.flagged)) - Number(Boolean(a.flagged))
    || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function selectTodos(todos, view, query, today = localDate()) {
  const search = query.trim().toLocaleLowerCase();
  return todos.filter(todo => (view === 'all' || viewOf(todo, today) === view)
    && (!search || todo.text.toLocaleLowerCase().includes(search) || (todo.notes || '').toLocaleLowerCase().includes(search)))
    .sort(compare);
}

export function countViews(todos, today = localDate()) {
  const counts = { today: 0, upcoming: 0, anytime: 0, done: 0, overdue: 0, doneToday: 0 };
  for (const todo of todos) {
    counts[viewOf(todo, today)]++;
    if (!todo.completed && todo.due && todo.due < today) counts.overdue++;
    if (todo.completed && localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today) counts.doneToday++;
  }
  return counts;
}
