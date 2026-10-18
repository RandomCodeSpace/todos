export type Smart = 'today' | 'upcoming' | 'starred' | 'all' | 'done';
export type View = Smart | `list:${string}`;
export type Repeat = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly';
export const COLORS = ['blue', 'orange', 'purple', 'teal', 'green', 'red', 'pink', 'graphite'] as const;
export type Color = typeof COLORS[number];

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
  /** Local calendar day, YYYY-MM-DD. */
  due?: string;
  /** Local time of day, HH:MM. Only meaningful with a due date. */
  time?: string;
  /** Shown as Starred. The field name predates the rename. */
  flagged?: boolean;
  notes?: string;
  completedAt?: number;
  listId?: string;
  /** Subtasks are one level deep: the parent is always a top-level task. */
  parentId?: string;
  /** Ids of top-level tasks that must be completed first. */
  blockedBy?: string[];
  repeat?: Repeat;
  /** Manual position among a parent's subtasks. */
  order?: number;
}

export interface List {
  id: string;
  name: string;
  color: Color;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Backup { todos: Todo[]; lists: List[] }

export interface Counts {
  today: number;
  upcoming: number;
  starred: number;
  all: number;
  done: number;
  overdue: number;
  doneToday: number;
  lists: Record<string, number>;
}

export const SMART: readonly Smart[] = ['today', 'upcoming', 'starred', 'all', 'done'];
export const REPEATS: readonly Repeat[] = ['daily', 'weekdays', 'weekly', 'monthly', 'yearly'];
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

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

export function normalizeListName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60) throw new Error('Name the list with 1 to 60 characters.');
  return value.trim();
}

export function isDate(value: unknown): value is string { return typeof value === 'string' && DATE.test(value); }
export function isTime(value: unknown): value is string { return typeof value === 'string' && TIME.test(value); }
export function isView(value: unknown): value is View {
  return SMART.includes(value as Smart) || (typeof value === 'string' && value.startsWith('list:') && value.length > 5);
}

// Local calendar dates as YYYY-MM-DD strings avoid time zone drift.
export function localDate(date = new Date()): string {
  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parts(day: string): [number, number, number] {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return [year, month, date];
}
export function dateOf(day: string): Date { const [year, month, date] = parts(day); return new Date(year, month - 1, date); }

export function addDays(day: string, count: number): string {
  const [year, month, date] = parts(day);
  return localDate(new Date(year, month - 1, date + count));
}

export function nextWeekend(day: string): string {
  const weekday = dateOf(day).getDay();
  return addDays(day, weekday === 6 ? 7 : 6 - weekday);
}

export function nextWeek(day: string): string {
  const weekday = dateOf(day).getDay();
  return addDays(day, ((8 - weekday) % 7) || 7);
}

function addMonths(day: string, count: number): string {
  const [year, month, date] = parts(day);
  const last = new Date(year, month - 1 + count + 1, 0).getDate();
  return localDate(new Date(year, month - 1 + count, Math.min(date, last)));
}

export function nextDue(day: string, repeat: Repeat): string {
  switch (repeat) {
    case 'daily': return addDays(day, 1);
    case 'weekly': return addDays(day, 7);
    case 'monthly': return addMonths(day, 1);
    case 'yearly': return addMonths(day, 12);
    case 'weekdays': {
      let next = addDays(day, 1);
      while ([0, 6].includes(dateOf(next).getDay())) next = addDays(next, 1);
      return next;
    }
  }
}

export function byId(todos: readonly Todo[]): Map<string, Todo> { return new Map(todos.map(todo => [todo.id, todo])); }

// A subtask whose parent is gone, for example after a partial import, behaves as a task.
export function isTopLevel(todo: Todo, index: ReadonlyMap<string, Todo>): boolean {
  return !todo.parentId || !index.has(todo.parentId);
}

export function subtasksOf(todos: readonly Todo[], parentId: string): Todo[] {
  return todos.filter(todo => todo.parentId === parentId)
    .sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** Open tasks this one waits on. Missing blockers no longer block. */
export function blockersOf(todo: Todo, index: ReadonlyMap<string, Todo>): Todo[] {
  return (todo.blockedBy ?? []).map(id => index.get(id)).filter((item): item is Todo => item !== undefined && !item.completed);
}

export function dependentsOf(todos: readonly Todo[], id: string): Todo[] {
  return todos.filter(todo => todo.blockedBy?.includes(id));
}

/** Whether `taskId` may wait on `blockerId`: both top-level, distinct and without a cycle. */
export function canDepend(todos: readonly Todo[], taskId: string, blockerId: string): boolean {
  const index = byId(todos);
  const task = index.get(taskId);
  const blocker = index.get(blockerId);
  if (!task || !blocker || taskId === blockerId || !isTopLevel(task, index) || !isTopLevel(blocker, index)) return false;
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === taskId) return false;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(index.get(id)?.blockedBy ?? []));
  }
  return true;
}

export function viewOf(todo: Todo, today: string): 'today' | 'upcoming' | 'all' | 'done' {
  if (todo.completed) return 'done';
  if (!todo.due) return 'all';
  return todo.due <= today ? 'today' : 'upcoming';
}

function inView(todo: Todo, view: View, today: string): boolean {
  switch (view) {
    case 'today': return Boolean(todo.due && todo.due <= today);
    case 'upcoming': return Boolean(todo.due && todo.due > today);
    case 'starred': return Boolean(todo.flagged);
    case 'all': return true;
    case 'done': return todo.completed;
    default: return todo.listId === view.slice(5);
  }
}

function contains(todo: Todo, search: string): boolean {
  return todo.text.toLocaleLowerCase().includes(search) || (todo.notes || '').toLocaleLowerCase().includes(search);
}

/**
 * Top-level tasks in a view, sorted by date, time, star and age. Tasks in `keep` were completed
 * in this session and stay in place so a mis-tap is easy to reverse. A query searches every
 * task, its notes and its subtasks, regardless of the view.
 */
export function selectTodos(todos: readonly Todo[], view: View, query: string, today = localDate(), keep: ReadonlySet<string> = new Set()): Todo[] {
  const index = byId(todos);
  const search = query.trim().toLocaleLowerCase();
  const open = (todo: Todo) => !todo.completed || keep.has(todo.id);
  return todos.filter(todo => {
    if (!isTopLevel(todo, index)) return false;
    if (search) return contains(todo, search) || todos.some(sub => sub.parentId === todo.id && contains(sub, search));
    return inView(todo, view, today) && (view === 'done' ? todo.completed : open(todo));
  }).sort((a, b) => {
    if (!open(a) || !open(b)) {
      return Number(!open(a)) - Number(!open(b)) || (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt) || a.id.localeCompare(b.id);
    }
    return (a.due || '9999').localeCompare(b.due || '9999') || (a.time || '99').localeCompare(b.time || '99')
      || Number(Boolean(b.flagged)) - Number(Boolean(a.flagged)) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  });
}

export function countViews(todos: readonly Todo[], today = localDate()): Counts {
  const counts: Counts = { today: 0, upcoming: 0, starred: 0, all: 0, done: 0, overdue: 0, doneToday: 0, lists: {} };
  const index = byId(todos);
  for (const todo of todos) {
    if (!isTopLevel(todo, index)) continue;
    if (todo.completed) {
      counts.done++;
      if (localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today) counts.doneToday++;
      continue;
    }
    counts.all++;
    if (todo.due && todo.due <= today) counts.today++;
    if (todo.due && todo.due > today) counts.upcoming++;
    if (todo.due && todo.due < today) counts.overdue++;
    if (todo.flagged) counts.starred++;
    if (todo.listId) counts.lists[todo.listId] = (counts.lists[todo.listId] ?? 0) + 1;
  }
  return counts;
}

function isSafeTime(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 100; }

function parseList(raw: unknown): List {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!isId(item.id) || !COLORS.includes(item.color as Color) || typeof item.order !== 'number' || !Number.isFinite(item.order)
    || !isSafeTime(item.createdAt) || !isSafeTime(item.updatedAt) || item.updatedAt < item.createdAt) {
    throw new Error('This backup contains an invalid list.');
  }
  return { id: item.id, name: normalizeListName(item.name), color: item.color as Color, order: item.order, createdAt: item.createdAt, updatedAt: item.updatedAt };
}

/** Accepts version 1 (todos only) and version 2 (todos and lists) backups. */
export function parseBackup(source: string): Backup {
  const data: unknown = JSON.parse(source);
  const version = data && typeof data === 'object' ? (data as { version?: unknown }).version : undefined;
  const list = (data as { todos?: unknown } | null)?.todos;
  if ((version !== 1 && version !== 2) || !Array.isArray(list) || list.length > 10000) {
    throw new Error('Choose a Tuck backup with at most 10,000 todos.');
  }
  const rawLists = version === 2 ? (data as { lists?: unknown }).lists : [];
  if (!Array.isArray(rawLists) || rawLists.length > 1000) throw new Error('This backup contains an invalid list.');
  const lists = rawLists.map(parseList);
  if (new Set(lists.map(item => item.id)).size !== lists.length) throw new Error('This backup contains an invalid list.');
  const ids = new Set<string>();
  const todos = list.map((raw: unknown) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (!isId(item.id) || ids.has(item.id)
      || typeof item.completed !== 'boolean' || !isSafeTime(item.createdAt)
      || !isSafeTime(item.updatedAt) || item.updatedAt < item.createdAt
      || (item.due !== undefined && !isDate(item.due))
      || (item.time !== undefined && !isTime(item.time))
      || (item.flagged !== undefined && typeof item.flagged !== 'boolean')
      || (item.completedAt !== undefined && !isSafeTime(item.completedAt))
      || (item.listId !== undefined && !isId(item.listId))
      || (item.parentId !== undefined && !isId(item.parentId))
      || (item.blockedBy !== undefined && (!Array.isArray(item.blockedBy) || item.blockedBy.length > 100 || !item.blockedBy.every(isId)))
      || (item.repeat !== undefined && !REPEATS.includes(item.repeat as Repeat))
      || (item.order !== undefined && (typeof item.order !== 'number' || !Number.isFinite(item.order)))) {
      throw new Error('This backup contains an invalid or duplicate todo.');
    }
    ids.add(item.id);
    const todo: Todo = { id: item.id, text: normalizeText(item.text), completed: item.completed, createdAt: item.createdAt, updatedAt: item.updatedAt };
    if (item.due !== undefined) todo.due = item.due;
    if (item.time !== undefined) todo.time = item.time;
    if (item.flagged) todo.flagged = true;
    const notes = normalizeNotes(item.notes);
    if (notes) todo.notes = notes;
    if (item.completedAt !== undefined) todo.completedAt = item.completedAt;
    if (item.listId !== undefined) todo.listId = item.listId;
    if (item.parentId !== undefined) todo.parentId = item.parentId;
    if (Array.isArray(item.blockedBy) && item.blockedBy.length) todo.blockedBy = [...new Set<string>(item.blockedBy)];
    if (item.repeat !== undefined) todo.repeat = item.repeat as Repeat;
    if (item.order !== undefined) todo.order = item.order;
    return todo;
  });
  return { todos, lists };
}

// Quick add: "Call dentist tomorrow 9am #health !" becomes a task with a date, time, list and star.
export type TokenKind = 'date' | 'time' | 'list' | 'star';
export interface Token { start: number; end: number; kind: TokenKind }
export interface QuickAdd { text: string; due?: string; time?: string; listId?: string; flagged?: boolean; tokens: Token[] }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const END = '(?=$|[\\s.,;!?])';
const pad = (value: number) => String(value).padStart(2, '0');

function monthDay(today: string, month: number, date: number): string | undefined {
  const [year] = parts(today);
  for (const candidate of [year, year + 1]) {
    const value = `${candidate}-${pad(month + 1)}-${pad(date)}`;
    if (dateOf(value).getDate() !== date) return undefined;
    if (value >= today) return value;
  }
  return undefined;
}
function monthIndex(word: string): number { return MONTHS.findIndex(name => name.startsWith(word.toLowerCase().slice(0, 3))); }

const DATE_RULES: Array<[RegExp, (match: RegExpExecArray, today: string) => string | undefined]> = [
  [new RegExp(`\\btoday${END}`, 'i'), (_match, today) => today],
  [new RegExp(`\\b(?:tomorrow|tmrw)${END}`, 'i'), (_match, today) => addDays(today, 1)],
  [new RegExp(`\\bnext week${END}`, 'i'), (_match, today) => nextWeek(today)],
  [new RegExp(`\\b(?:this )?weekend${END}`, 'i'), (_match, today) => nextWeekend(today)],
  [new RegExp(`\\bin (\\d{1,3}) (day|days|week|weeks)${END}`, 'i'), (match, today) => addDays(today, Number(match[1]) * (match[2]?.startsWith('week') ? 7 : 1))],
  [new RegExp(`\\b(?:on |next )?(${WEEKDAYS.join('|')})${END}`, 'i'), (match, today) => {
    const target = WEEKDAYS.indexOf((match[1] ?? '').toLowerCase());
    return addDays(today, ((target - dateOf(today).getDay() + 7) % 7) || 7);
  }],
  [new RegExp(`\\b(?:on )?${MONTH}\\.? (\\d{1,2})(?:st|nd|rd|th)?${END}`, 'i'), (match, today) => monthDay(today, monthIndex(match[1] ?? ''), Number(match[2]))],
  [new RegExp(`\\b(?:on )?(\\d{1,2})(?:st|nd|rd|th)? ${MONTH}${END}`, 'i'), (match, today) => monthDay(today, monthIndex(match[2] ?? ''), Number(match[1]))]
];
const TIME_RULES: Array<[RegExp, (match: RegExpExecArray) => string | undefined]> = [
  [new RegExp(`\\b(?:at )?(\\d{1,2})(?::([0-5]\\d))? ?(am|pm)${END}`, 'i'), match => {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) return undefined;
    return `${pad((hour % 12) + (match[3]?.toLowerCase() === 'pm' ? 12 : 0))}:${match[2] ?? '00'}`;
  }],
  [new RegExp(`\\b(?:at )?([01]?\\d|2[0-3]):([0-5]\\d)${END}`, 'i'), match => `${pad(Number(match[1]))}:${match[2] ?? '00'}`],
  [new RegExp(`\\b(?:at )?noon${END}`, 'i'), () => '12:00']
];
function listKey(name: string): string { return name.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

export function parseQuickAdd(input: string, today: string, lists: readonly List[], skip: ReadonlySet<TokenKind> = new Set()): QuickAdd {
  const tokens: Token[] = [];
  const result: QuickAdd = { text: input.trim(), tokens };
  const free = (start: number, end: number) => tokens.every(token => end <= token.start || start >= token.end);
  const take = (kind: TokenKind, match: RegExpExecArray | null, offset = 0): boolean => {
    if (!match || skip.has(kind)) return false;
    const start = match.index + offset;
    const end = match.index + match[0].length;
    if (!free(start, end)) return false;
    tokens.push({ start, end, kind });
    return true;
  };
  for (const [pattern, resolve] of DATE_RULES) {
    const match = pattern.exec(input);
    const due = match ? resolve(match, today) : undefined;
    if (due && take('date', match)) { result.due = due; break; }
  }
  for (const [pattern, resolve] of TIME_RULES) {
    const match = pattern.exec(input);
    const time = match ? resolve(match) : undefined;
    if (time && take('time', match)) { result.time = time; break; }
  }
  const tag = /(^|\s)#([\p{L}\p{N}_-]+)/u.exec(input);
  const list = tag ? lists.find(item => listKey(item.name) === listKey(tag[2] ?? '')) : undefined;
  if (list && take('list', tag, tag?.[1]?.length ?? 0)) result.listId = list.id;
  const star = /(^|\s)!{1,3}(?=$|\s)/.exec(input);
  if (take('star', star, star?.[1]?.length ?? 0)) result.flagged = true;

  tokens.sort((a, b) => a.start - b.start);
  let text = '';
  let cursor = 0;
  for (const token of tokens) { text += `${input.slice(cursor, token.start)} `; cursor = token.end; }
  text = (text + input.slice(cursor)).replace(/\s+/g, ' ').trim();
  // A draft made only of tokens, such as "Tomorrow", is the task text itself.
  if (!text) return { text: input.trim(), tokens: [] };
  result.text = text;
  return result;
}
