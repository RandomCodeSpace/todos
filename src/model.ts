export type View = 'today' | 'upcoming' | 'anytime' | 'done';
export type Filter = View | 'all';

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  /** Local calendar day, YYYY-MM-DD. */
  due?: string;
  flagged?: boolean;
  notes?: string;
  completedAt?: number;
}

export interface Counts extends Record<View, number> {
  overdue: number;
  doneToday: number;
}

export const VIEWS: readonly View[] = ['today', 'upcoming', 'anytime', 'done'];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function normalizeText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new Error('Use between 1 and 2,000 characters.');
  }
  return value.trim();
}

export function normalizeNotes(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 4000) throw new Error('Keep notes under 4,000 characters.');
  return value.trim();
}

export function isDate(value: unknown): value is string { return typeof value === 'string' && DATE.test(value); }

// Local calendar dates as YYYY-MM-DD strings avoid time zone drift.
export function localDate(date = new Date()): string {
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parts(day: string): [number, number, number] {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return [year, month, date];
}

export function addDays(day: string, count: number): string {
  const [year, month, date] = parts(day);
  return localDate(new Date(year, month - 1, date + count));
}

export function nextWeekend(day: string): string {
  const [year, month, date] = parts(day);
  const weekday = new Date(year, month - 1, date).getDay();
  return addDays(day, weekday === 6 ? 7 : 6 - weekday);
}

export function viewOf(todo: Todo, today: string): View {
  if (todo.completed) return 'done';
  if (!todo.due) return 'anytime';
  return todo.due <= today ? 'today' : 'upcoming';
}

function isSafeTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

export function parseBackup(source: string): Todo[] {
  const data: unknown = JSON.parse(source);
  if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1) {
    throw new Error('Choose a Tuck backup with at most 10,000 todos.');
  }
  const list = (data as { todos?: unknown }).todos;
  if (!Array.isArray(list) || list.length > 10000) throw new Error('Choose a Tuck backup with at most 10,000 todos.');
  const ids = new Set<string>();
  return list.map((raw: unknown) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100 || ids.has(item.id)
      || typeof item.completed !== 'boolean' || !isSafeTime(item.createdAt)
      || !isSafeTime(item.updatedAt) || item.updatedAt < item.createdAt
      || (item.due !== undefined && !isDate(item.due))
      || (item.flagged !== undefined && typeof item.flagged !== 'boolean')
      || (item.completedAt !== undefined && !isSafeTime(item.completedAt))) {
      throw new Error('This backup contains an invalid or duplicate todo.');
    }
    ids.add(item.id);
    const todo: Todo = { id: item.id, text: normalizeText(item.text), completed: item.completed, createdAt: item.createdAt, updatedAt: item.updatedAt };
    if (item.due !== undefined) todo.due = item.due;
    if (item.flagged) todo.flagged = true;
    const notes = normalizeNotes(item.notes);
    if (notes) todo.notes = notes;
    if (item.completedAt !== undefined) todo.completedAt = item.completedAt;
    return todo;
  });
}

function compare(a: Todo, b: Todo): number {
  if (a.completed || b.completed) {
    return Number(a.completed) - Number(b.completed)
      || (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt) || a.id.localeCompare(b.id);
  }
  return (a.due || '9999').localeCompare(b.due || '9999')
    || Number(Boolean(b.flagged)) - Number(Boolean(a.flagged))
    || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
}

export function selectTodos(todos: readonly Todo[], view: Filter, query: string, today = localDate()): Todo[] {
  const search = query.trim().toLocaleLowerCase();
  return todos.filter(todo => (view === 'all' || viewOf(todo, today) === view)
    && (!search || todo.text.toLocaleLowerCase().includes(search) || (todo.notes || '').toLocaleLowerCase().includes(search)))
    .sort(compare);
}

export function countViews(todos: readonly Todo[], today = localDate()): Counts {
  const counts: Counts = { today: 0, upcoming: 0, anytime: 0, done: 0, overdue: 0, doneToday: 0 };
  for (const todo of todos) {
    counts[viewOf(todo, today)]++;
    if (!todo.completed && todo.due && todo.due < today) counts.overdue++;
    if (todo.completed && localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today) counts.doneToday++;
  }
  return counts;
}
