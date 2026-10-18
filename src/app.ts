import {
  normalizeText, normalizeNotes, normalizeListName, parseBackup, parseQuickAdd, selectTodos, countViews, viewOf, localDate, dateOf,
  addDays, nextWeekend, nextWeek, nextDue, byId, subtasksOf, blockersOf, dependentsOf, canDepend, isTopLevel, isView, SMART, COLORS
} from './model.js';
import type { Todo, List, View, Smart, Repeat, Color, Counts, QuickAdd, TokenKind } from './model.js';
import * as storage from './storage.js';
import type { TodoChanges } from './storage.js';

interface InstallPromptEvent extends Event { prompt(): Promise<void>; }
type Focus = { id?: string | undefined; control?: string | null | undefined; index?: number };
interface When { due?: string | undefined; time?: string | undefined; repeat?: Repeat | undefined }
interface Draft extends When { listId?: string | undefined; flagged: boolean; blockers: string[]; skip: Set<TokenKind> }
interface EditState extends When { listId?: string | undefined; flagged: boolean }
interface Choice { value: string; label: string; color?: Color | undefined; danger?: boolean; selected?: boolean }

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}
const shell = $('#shell');
const newTodo = $<HTMLTextAreaElement>('#new-todo');
const searchInput = $<HTMLInputElement>('#search');
const editText = $<HTMLTextAreaElement>('#edit-text');
const editNotes = $<HTMLTextAreaElement>('#edit-notes');
const newSubInput = $<HTMLInputElement>('#new-sub-input');
const badgeToggle = $<HTMLInputElement>('#badge-toggle');
const addForm = $<HTMLFormElement>('#add-form');
const editForm = $<HTMLFormElement>('#edit-form');
const listForm = $<HTMLFormElement>('#list-form');
const editDialog = $<HTMLDialogElement>('#edit-dialog');
const settingsDialog = $<HTMLDialogElement>('#settings-dialog');
const actionsDialog = $<HTMLDialogElement>('#actions-dialog');
const listsDialog = $<HTMLDialogElement>('#lists-dialog');
const listDialog = $<HTMLDialogElement>('#list-dialog');
const dateDialog = $<HTMLDialogElement>('#date-dialog');
const pickerDialog = $<HTMLDialogElement>('#picker-dialog');
const dateDue = $<HTMLInputElement>('#date-due');
const dateTime = $<HTMLInputElement>('#date-time');
const dateRepeat = $<HTMLSelectElement>('#date-repeat');
const list = $('#todo-list');
const NAMES: Record<Smart, string> = { today: 'Today', upcoming: 'Upcoming', starred: 'Starred', all: 'All', done: 'Completed' };
const REPEAT_NAMES: Record<Repeat, string> = { daily: 'Every day', weekdays: 'Weekdays', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' };
const COLOR_NAMES: Record<Color, string> = { blue: 'Blue', orange: 'Orange', purple: 'Purple', teal: 'Teal', green: 'Green', red: 'Red', pink: 'Pink', graphite: 'Graphite' };
const SWIPE_VIEWS: readonly View[] = ['today', 'upcoming', 'starred', 'all'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarse = matchMedia('(pointer: coarse)');
const desktop = matchMedia('(min-width: 900px)');
let todos: Todo[] = [];
let lists: List[] = [];
let index = new Map<string, Todo>();
// Subtasks grouped by parent once per render, so rows do not rescan every task.
let children = new Map<string, Todo[]>();
let view: View = 'today';
let today = localDate();
let editingId = '';
let editingSnapshot = '';
let edit: EditState = { flagged: false };
let actionTodo: Todo | undefined;
let undoAction: (() => void) | undefined;
let busy = false;
let storageReady = false;
let deferredInstall: InstallPromptEvent | undefined;
let registration: ServiceWorkerRegistration | undefined;
let refreshing = false;
let showCompleted = false;
let reordering = false;
let editingList: List | undefined;
let draft: Draft = { flagged: false, blockers: [], skip: new Set() };
let blockedBefore = new Set<string>();
let unlocked = new Set<string>();
// Tasks completed in this session stay visible until the view changes, so a mis-tap is easy to reverse.
const lingering = new Set<string>();
const expanded = new Set<string>();
// Keep the original channel so existing installations see changes from Tuck.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('randomcodespace-todos') : null;
const supportsSwitch = 'switch' in HTMLInputElement.prototype;
if (!supportsSwitch) document.documentElement.classList.add('no-switch');

// iOS 18 Safari plays a system haptic when a switch control toggles; there is no other web haptics API on iPhone.
function haptic() {
  if (supportsSwitch && coarse.matches) $('.haptic').click();
}

let errorTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function errorName(error: unknown): string { return error instanceof Error ? error.name : ''; }
function clip(text: string, length = 28): string { return text.length > length ? `${text.slice(0, length - 1)}…` : text; }

function reportError(message: string): void {
  $('#notice').hidden = true;
  const target = editDialog.open ? $('#edit-error') : listDialog.open ? $('#list-error') : $('#error');
  target.textContent = message;
  target.hidden = false;
  if (target === $('#error')) { clearTimeout(errorTimer); errorTimer = setTimeout(() => { target.hidden = true; }, 8000); }
}

function notify(message: string, undo?: () => void): void {
  $('#error').hidden = true;
  $('#edit-error').hidden = true;
  $('#notice-text').textContent = message;
  undoAction = undo;
  $('#undo').hidden = !undo;
  $('#notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (!$('#notice').contains(document.activeElement)) $('#notice').hidden = true; }, undo ? 6000 : 3000);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#add-button, #export, #import, #import-file, #clear-completed, #undo, #todo-list button, #todo-list input')) {
    control.disabled = value || !storageReady;
  }
  newTodo.disabled = !storageReady;
  addForm.setAttribute('aria-busy', String(value));
}

function animate(update: () => void): Promise<void> {
  if (!document.startViewTransition || reducedMotion.matches || document.hidden) { update(); return Promise.resolve(); }
  return document.startViewTransition(update).updateCallbackDone.catch(() => {});
}

// Dates
function dayDiff(day: string): number {
  const utc = (value: string) => { const date = dateOf(value); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
  return Math.round((utc(day) - utc(today)) / 864e5);
}
function format(day: string, options: Intl.DateTimeFormatOptions): string {
  if (day.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, options).format(dateOf(day));
}
function dueLabel(day: string): string {
  const diff = dayDiff(day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return format(day, { weekday: 'long' });
  return format(day, { month: 'short', day: 'numeric' });
}
function sectionLabel(day: string): string {
  const diff = dayDiff(day);
  const date = format(day, { weekday: 'short', month: 'short', day: 'numeric' });
  if (diff === 1) return `Tomorrow · ${date}`;
  return date;
}
function timeLabel(time: string): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, hour, minute));
}
function whenLabel(when: When): string {
  if (!when.due) return '';
  return when.time ? `${dueLabel(when.due)}, ${timeLabel(when.time)}` : dueLabel(when.due);
}
function shortWhen(when: When): string {
  if (!when.due) return '';
  const diff = dayDiff(when.due);
  const day = diff === 0 ? 'Today' : diff === 1 ? 'Tmrw' : diff > 1 && diff < 7 ? format(when.due, { weekday: 'short' }) : format(when.due, { month: 'short', day: 'numeric' });
  if (!when.time) return day;
  const [hour = 0, minute = 0] = when.time.split(':').map(Number);
  return `${day} ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', ...(minute ? { minute: '2-digit' } : {}) }).format(new Date(2000, 0, 1, hour, minute))}`;
}
function laterDate(due: string | undefined): string { return due && due > today ? addDays(due, 1) : addDays(today, 1); }

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className: string, label?: string): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  return node;
}

const listById = (id: string | undefined) => (id ? lists.find(item => item.id === id) : undefined);
const sortedLists = () => [...lists].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
function viewName(value: View): string { return value.startsWith('list:') ? listById(value.slice(5))?.name ?? 'List' : NAMES[value as Smart]; }
function isOpen(todo: Todo): boolean { return !todo.completed; }
function openTasks(): Todo[] { return todos.filter(todo => isOpen(todo) && isTopLevel(todo, index)); }

function captureFocus(): Focus {
  const focused = document.activeElement;
  const row = focused?.closest<HTMLElement>('.todo');
  return { id: row?.dataset.id, control: focused?.getAttribute('data-control'), index: row ? [...list.querySelectorAll('.todo')].indexOf(row) : -1 };
}
function restoreFocus(focus: Focus): void {
  if (!focus.id || !focus.control || document.querySelector('dialog[open]')) return;
  const rows = [...list.querySelectorAll<HTMLElement>('.todo')];
  const row = rows.find(item => item.dataset.id === focus.id) || rows[Math.min(focus.index ?? 0, rows.length - 1)];
  const fallback = [...document.querySelectorAll<HTMLElement>('#views [aria-pressed="true"], #side-nav [aria-pressed="true"]')].find(node => node.checkVisibility());
  (row?.querySelector<HTMLElement>(`[data-control="${focus.control}"]`) || fallback)?.focus({ preventScroll: !row });
}

// Completion. Completing a task completes its subtasks; a repeating task moves to its next date instead.
function completionEntries(todo: Todo, completed: boolean): { entries: Array<[string, TodoChanges]>; note?: string } {
  if (!completed) return { entries: [[todo.id, { completed: false, completedAt: undefined }]] };
  const subs = todo.parentId && index.has(todo.parentId) ? [] : subtasksOf(todos, todo.id);
  if (todo.repeat && !todo.parentId) {
    let next = todo.due ?? today;
    do next = nextDue(next, todo.repeat); while (next <= today);
    const entries: Array<[string, TodoChanges]> = [[todo.id, { due: next, completed: false, completedAt: undefined }]];
    for (const sub of subs) if (sub.completed) entries.push([sub.id, { completed: false, completedAt: undefined }]);
    return { entries, note: `Done. Next: ${dueLabel(next)}.` };
  }
  const now = Date.now();
  return { entries: [[todo.id, { completed: true, completedAt: now }], ...subs.filter(isOpen).map(sub => [sub.id, { completed: true, completedAt: now }] as [string, TodoChanges])] };
}
function refuseBlocked(todo: Todo): void {
  const blockers = blockersOf(todo, index);
  const row = list.querySelector<HTMLElement>(`.todo[data-id="${CSS.escape(todo.id)}"]`);
  row?.classList.remove('refused');
  void row?.offsetWidth;
  row?.classList.add('refused');
  haptic();
  notify(`Finish "${clip(blockers[0]?.text ?? '')}" first.`);
}
function toggleTodo(todo: Todo, completed: boolean): void {
  if (completed && blockersOf(todo, index).length) { refuseBlocked(todo); render(); return; }
  const { entries, note } = completionEntries(todo, completed);
  if (completed) { haptic(); if (!todo.repeat) lingering.add(todo.id); }
  void mutate(() => storage.changeTodos(entries), () => { if (note) notify(note); });
}
function deleteTask(todo: Todo): void {
  const removed = [todo, ...subtasksOf(todos, todo.id)];
  void mutate(() => storage.deleteTodos(removed.map(item => item.id)), () => {
    notify(`Deleted "${clip(todo.text)}"`, () => void mutate(() => storage.addTodos(removed), () => notify('Restored.')));
  });
}
function moveTask(todo: Todo, due: string): void {
  void mutate(() => storage.changeTodo(todo.id, { due, completed: false, completedAt: undefined }), () => {
    if (!selectTodos([{ ...todo, due, completed: false }], view, '', today).length) notify(`Moved to ${dueLabel(due)}.`);
  });
}

// Rows
function checkControl(todo: Todo, control: string, blocked: boolean, small = false): HTMLLabelElement {
  const label = element('label', small ? 'check check-sm' : 'check');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = todo.completed;
  input.dataset.control = control;
  input.setAttribute('aria-label', `${todo.completed ? 'Reopen' : 'Complete'} ${todo.text}`);
  if (blocked) input.setAttribute('aria-disabled', 'true');
  input.addEventListener('click', event => { if (blocked) { event.preventDefault(); refuseBlocked(todo); } });
  input.addEventListener('change', () => toggleTodo(todo, input.checked));
  const box = element('span', 'check-box');
  box.append(icon('check'), icon('lock'));
  label.append(input, box);
  return label;
}

function buildRow(todo: Todo): HTMLLIElement {
  const subs = children.get(todo.id) ?? [];
  const blockers = todo.completed ? [] : blockersOf(todo, index);
  const row = element('li', 'todo');
  row.classList.toggle('completed', todo.completed);
  row.classList.toggle('flagged', Boolean(todo.flagged));
  row.classList.toggle('blocked', blockers.length > 0);
  row.classList.toggle('unlocked', unlocked.has(todo.id));
  row.classList.toggle('expanded', expanded.has(todo.id));
  row.dataset.id = todo.id;
  if (todos.length <= 80) row.style.setProperty('view-transition-name', `t-${todo.id.replace(/[^\w-]/g, '_')}`);

  const hint = element('div', 'swipe-hint');
  hint.setAttribute('aria-hidden', 'true');
  const hintDone = element('span', 'hint-done');
  hintDone.append(icon('check'), todo.completed ? 'Reopen' : 'Complete');
  const actions = element('span', 'swipe-actions');
  const later = button('swipe-later');
  later.tabIndex = -1;
  later.append(icon('later'), 'Later');
  later.addEventListener('click', () => { closeReveal(); moveTask(todo, laterDate(todo.due)); });
  const remove = button('swipe-delete');
  remove.tabIndex = -1;
  remove.append(icon('trash'), 'Delete');
  remove.addEventListener('click', () => { closeReveal(); deleteTask(todo); });
  actions.append(later, remove);
  hint.append(hintDone, actions);

  const surface = element('div', 'row');
  const body = button('body');
  body.dataset.control = 'edit';
  body.setAttribute('aria-label', `Edit ${todo.text}`);
  const meta = element('span', 'meta');
  const searching = Boolean(searchInput.value.trim());
  if (todo.due && !todo.completed) {
    const showDate = searching || (view !== 'upcoming' && !(view === 'today' && todo.due === today));
    const label = showDate ? whenLabel(todo) : todo.time ? timeLabel(todo.time) : '';
    if (label) meta.append(element('span', todo.due < today ? 'late' : todo.due === today ? 'soon' : '', label));
  }
  if (subs.length) {
    const done = subs.filter(sub => sub.completed).length;
    const progress = element('span', 'progress-chip');
    const bar = element('span', 'bar');
    const fill = element('i');
    fill.style.setProperty('--fill', String(done / subs.length));
    bar.append(fill);
    progress.append(bar, `${done}/${subs.length}`);
    meta.append(progress);
  }
  if (todo.repeat && !todo.completed) { const span = element('span'); span.append(icon('repeat'), REPEAT_NAMES[todo.repeat]); meta.append(span); }
  const owner = listById(todo.listId);
  if (owner && view !== `list:${owner.id}`) { const span = element('span'); span.append(element('i', `dot c-${owner.color}`), owner.name); meta.append(span); }
  if (blockers[0]) {
    const span = element('span', 'wait');
    span.append(icon('link'), `After ${clip(blockers[0].text, 24)}${blockers.length > 1 ? ` +${blockers.length - 1}` : ''}`);
    meta.append(span);
  }
  if (todo.notes) meta.append(element('span', '', 'Note'));
  body.append(element('span', 'todo-text', todo.text), meta);
  body.addEventListener('click', () => { if (!gesture.suppressClick) openEditor(todo); });

  const trail = element('span', 'trail');
  if (todo.flagged && !todo.completed) { const star = element('span', 'star'); star.append(icon('star')); trail.append(star); }
  if (subs.length) {
    const toggle = button('expand');
    toggle.dataset.control = 'expand';
    toggle.setAttribute('aria-expanded', String(expanded.has(todo.id)));
    toggle.setAttribute('aria-label', `Subtasks of ${todo.text}`);
    toggle.append(icon('chevron'));
    toggle.addEventListener('click', () => {
      const open = !expanded.has(todo.id);
      if (open) expanded.add(todo.id); else expanded.delete(todo.id);
      row.classList.toggle('expanded', open);
      toggle.setAttribute('aria-expanded', String(open));
    });
    trail.append(toggle);
  }
  const rowDelete = button('row-delete');
  rowDelete.dataset.control = 'delete';
  rowDelete.setAttribute('aria-label', `Delete ${todo.text}`);
  rowDelete.append(icon('trash'));
  rowDelete.addEventListener('click', () => deleteTask(todo));
  surface.append(checkControl(todo, 'check', blockers.length > 0), body, trail, rowDelete);
  surface.addEventListener('pointerdown', event => rowPointerDown(event, todo, row, surface));
  surface.addEventListener('contextmenu', event => { event.preventDefault(); openActions(todo); });
  row.append(hint, surface);

  if (subs.length) {
    const panel = element('div', 'subs');
    const inner = element('ul', 'sub-rows');
    for (const sub of subs) {
      const item = element('li', `sub${sub.completed ? ' completed' : ''}`);
      const text = button('sub-text', sub.text);
      text.tabIndex = -1;
      text.addEventListener('click', () => openEditor(todo));
      item.append(checkControl(sub, `sub-${sub.id}`, false, true), text);
      inner.append(item);
    }
    panel.append(inner);
    row.append(panel);
  }
  return row;
}

function heading(label: string, className = '', day?: string): HTMLLIElement {
  const node = element('li', `section ${className}`, label);
  node.setAttribute('role', 'presentation');
  if (day) node.dataset.day = day;
  return node;
}

function sectionOf(todo: Todo, searching: boolean, counts: Counts): [string, string, string?] | [] {
  if (searching) { const kind = viewOf(todo, today); return [kind, kind === 'all' ? 'No date' : kind === 'done' ? 'Completed' : NAMES[kind]]; }
  if (view === 'today' && counts.overdue) return todo.due && todo.due < today ? ['late', 'Overdue', 'late'] : ['today', 'Today'];
  if (view === 'upcoming' && todo.due) return [todo.due, sectionLabel(todo.due)];
  if (view === 'all') { const owner = listById(todo.listId); return [owner?.id ?? '', owner?.name ?? 'No list']; }
  if (view === 'done') { const day = localDate(new Date(todo.completedAt ?? todo.updatedAt)); return [day, dueLabel(day)]; }
  return [];
}

function render(): void {
  today = localDate();
  index = byId(todos);
  const grouped = new Map<string, Todo[]>();
  for (const todo of todos) if (todo.parentId) grouped.set(todo.parentId, [...(grouped.get(todo.parentId) ?? []), todo]);
  children = new Map([...grouped].map(([id, items]) => [id, subtasksOf(items, id)]));
  const focus = captureFocus();
  const query = searchInput.value;
  const searching = Boolean(query.trim());
  const counts = countViews(todos, today);
  const blockedNow = new Set(todos.filter(todo => !todo.completed && blockersOf(todo, index).length).map(todo => todo.id));
  unlocked = new Set([...blockedBefore].filter(id => !blockedNow.has(id) && index.get(id)?.completed === false));
  blockedBefore = blockedNow;

  let selected = selectTodos(todos, view, query, today, lingering);
  if (!searching && view === 'all') {
    const rank = new Map(sortedLists().map((item, position) => [item.id, position]));
    const position = (todo: Todo) => rank.get(todo.listId ?? '') ?? Infinity;
    selected = selected.map((todo, order) => ({ todo, order })).sort((a, b) => position(a.todo) - position(b.todo) || a.order - b.order).map(({ todo }) => todo);
  }
  const fragment = document.createDocumentFragment();
  let group: string | undefined;
  for (const todo of selected) {
    const [key, label, className] = sectionOf(todo, searching, counts);
    if (key !== undefined && label && key !== group) { fragment.append(heading(label, className, view === 'upcoming' ? key : undefined)); group = key; }
    fragment.append(buildRow(todo));
  }
  const finished = !searching && view === 'today'
    ? todos.filter(todo => todo.completed && !lingering.has(todo.id) && isTopLevel(todo, index) && localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today)
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
    : [];
  if (finished.length) {
    const item = element('li', 'completed-toggle');
    const toggle = button('', `${finished.length} completed`);
    toggle.setAttribute('aria-expanded', String(showCompleted));
    toggle.append(icon('chevron'));
    toggle.addEventListener('click', () => { showCompleted = !showCompleted; void animate(render); });
    item.append(toggle);
    fragment.append(item);
    if (showCompleted) for (const todo of finished) fragment.append(buildRow(todo));
  }
  list.replaceChildren(fragment);

  $('#count-today').textContent = String(counts.today || '');
  const lifted = !searching && !SWIPE_VIEWS.slice(0, 2).includes(view);
  for (const tab of document.querySelectorAll<HTMLElement>('#views [data-view]')) tab.setAttribute('aria-pressed', String(!searching && tab.dataset.view === view));
  $('#open-lists').setAttribute('aria-pressed', String(lifted));
  $('#views').style.setProperty('--tab', String(searching ? 3 : view === 'today' ? 0 : view === 'upcoming' ? 1 : 2));
  shell.dataset.view = view.startsWith('list:') ? 'list' : view;
  const owner = view.startsWith('list:') ? listById(view.slice(5)) : undefined;
  const title = $('#view-title');
  title.textContent = searching ? 'Search' : viewName(view);
  title.className = owner && !searching ? `c-${owner.color}` : '';

  const eyebrow = $('#eyebrow');
  const summary = $('#summary');
  let text: string;
  if (searching) text = `${selected.length} ${selected.length === 1 ? 'match' : 'matches'}`;
  else if (view === 'today') text = counts.today ? `${counts.today} to do${counts.overdue ? `, ${counts.overdue} overdue` : ''}` : counts.doneToday ? 'All done for today' : 'Nothing due';
  else if (view === 'upcoming') text = counts.upcoming ? `${counts.upcoming} scheduled` : 'Nothing scheduled';
  else if (view === 'starred') text = `${counts.starred} starred`;
  else if (view === 'all') text = `${counts.all} open`;
  else if (view === 'done') text = counts.doneToday ? `${counts.doneToday} today, ${counts.done} in total` : `${counts.done} finished`;
  else text = `${owner ? counts.lists[owner.id] ?? 0 : 0} open`;
  summary.textContent = text;
  eyebrow.textContent = view === 'today' && !searching ? new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()) : text;
  const total = counts.today + counts.doneToday;
  const progress = $('#progress');
  progress.hidden = searching || view !== 'today' || total === 0;
  progress.setAttribute('aria-label', `${counts.doneToday} of ${total} done today`);
  $('#progress-text').textContent = `${counts.doneToday}/${total}`;
  $('#progress-arc').style.setProperty('--done', String(total ? (counts.doneToday / total) * 100 : 0));

  const empty = selected.length === 0 && finished.length === 0;
  $('#empty').hidden = !empty;
  if (empty) {
    const copy: [string, string] = searching ? ['No matches', `Nothing contains "${query.trim()}".`]
      : view === 'today' ? ['A clear day', 'Tap + or pull down to add a task.']
        : view === 'upcoming' ? ['Nothing scheduled', 'Give a task a date and it waits here.']
          : view === 'starred' ? ['No stars yet', 'Star what matters most. Type ! in a new task.']
            : view === 'all' ? ['No open tasks', 'Everything is done.']
              : view === 'done' ? ['Nothing finished yet', 'Completed tasks collect here.']
                : ['An empty list', `Type #${owner?.name.replace(/\s+/g, '') ?? 'list'} in a new task to file it here.`];
    $('#empty-title').textContent = copy[0];
    $('#empty-description').textContent = copy[1];
  }
  $('#clear-completed').hidden = counts.done === 0;
  renderWeek();
  renderNav($('#side-nav'), counts);
  renderNav($('#sheet-nav'), counts);
  if (editDialog.open) renderEditor();
  updateBadge(counts.today);
  syncComposer();
  setBusy(busy);
  if (!busy) restoreFocus(focus);
}

function renderWeek(): void {
  const week = $('#week');
  const fragment = document.createDocumentFragment();
  for (let offset = 0; offset < 7; offset++) {
    const day = addDays(today, offset);
    const count = todos.filter(todo => todo.due === day && isOpen(todo) && isTopLevel(todo, index)).length;
    const cell = button(`day${offset === 0 ? ' today' : ''}`);
    cell.dataset.day = day;
    cell.setAttribute('aria-label', `${format(day, { weekday: 'long', month: 'long', day: 'numeric' })}, ${count} ${count === 1 ? 'task' : 'tasks'}`);
    const pips = element('span', 'pips');
    for (let pip = 0; pip < Math.min(count, 3); pip++) pips.append(element('i'));
    cell.append(element('span', 'weekday', format(day, { weekday: 'short' })), element('b', '', String(dateOf(day).getDate())), pips);
    fragment.append(cell);
  }
  week.replaceChildren(fragment);
}
$('#week').addEventListener('click', event => {
  const day = (event.target as Element).closest<HTMLElement>('[data-day]')?.dataset.day;
  if (!day || gesture.suppressClick) return;
  if (view !== 'upcoming' && day !== today) setView('upcoming');
  if (day === today) { setView('today'); return; }
  const target = [...list.querySelectorAll<HTMLElement>('.section[data-day]')].find(item => (item.dataset.day ?? '') >= day);
  if (target) target.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
  else notify(`Nothing on ${dueLabel(day)}.`);
});

// Lists navigation, shared by the phone sheet and the desktop sidebar.
function renderNav(target: HTMLElement, counts: Counts): void {
  const sheet = target.id === 'sheet-nav';
  const grid = element('div', 'smart-grid');
  const tiles: Array<[Smart, string, string, number]> = [['today', 'sun', 'green', counts.today], ['upcoming', 'cal', 'blue', counts.upcoming], ['starred', 'star', 'amber', counts.starred], ['all', 'grid', 'ink', counts.all]];
  for (const [key, glyph, tone, count] of tiles) {
    const tile = button(`tile t-${tone}`);
    tile.dataset.nav = key;
    tile.setAttribute('aria-pressed', String(view === key && !searchInput.value));
    tile.setAttribute('aria-label', `${NAMES[key]}, ${count}`);
    const ico = element('span', 'ico');
    ico.append(icon(glyph));
    tile.append(ico, element('span', 'tile-count', String(count)), element('span', 'tile-name', NAMES[key]));
    grid.append(tile);
  }
  const mine = element('ul', 'my-lists');
  mine.setAttribute('aria-label', 'My lists');
  for (const item of sortedLists()) {
    const li = element('li');
    li.dataset.id = item.id;
    const row = button('list-row');
    row.dataset.nav = `list:${item.id}`;
    row.dataset.list = item.id;
    row.setAttribute('aria-pressed', String(view === `list:${item.id}`));
    row.setAttribute('aria-label', `${item.name}, ${counts.lists[item.id] ?? 0}`);
    const ico = element('span', `ico c-${item.color}`);
    ico.append(icon('list'));
    row.append(ico, element('span', 'list-name', item.name), element('span', 'list-count', String(counts.lists[item.id] ?? '')));
    li.append(row);
    if (sheet && reordering) {
      const handle = button('handle');
      handle.dataset.handle = '';
      handle.setAttribute('aria-label', `Move ${item.name}`);
      handle.append(icon('handle'));
      li.append(handle);
    }
    mine.append(li);
  }
  const done = button('list-row completed-row');
  done.dataset.nav = 'done';
  done.setAttribute('aria-pressed', String(view === 'done'));
  done.setAttribute('aria-label', `Completed, ${counts.done}`);
  const doneIco = element('span', 'ico c-graphite');
  doneIco.append(icon('check'));
  done.append(doneIco, element('span', 'list-name', 'Completed'), element('span', 'list-count', String(counts.done || '')));
  const children: Node[] = [grid, element('h3', 'nav-heading', 'My lists')];
  if (lists.length) children.push(mine);
  else children.push(element('p', 'nav-note', 'Group tasks into lists, such as Work or Groceries.'));
  children.push(done);
  if (!sheet) {
    const add = button('list-row new-list');
    add.dataset.newList = '';
    const ico = element('span', 'ico c-plain');
    ico.append(icon('plus'));
    add.append(ico, element('span', 'list-name', 'New list'));
    children.splice(children.length - 1, 0, add);
  }
  target.replaceChildren(...children);
  target.classList.toggle('reordering', sheet && reordering);
}

for (const nav of [$('#side-nav'), $('#sheet-nav')]) {
  nav.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-nav], [data-new-list]');
    if (!target || hold.fired) return;
    if (target.dataset.newList !== undefined) { openListEditor(); return; }
    if (reordering && nav.id === 'sheet-nav' && target.dataset.list) { openListEditor(listById(target.dataset.list)); return; }
    const next = target.dataset.nav;
    if (isView(next)) { if (listsDialog.open) listsDialog.close(); setView(next); }
  });
  nav.addEventListener('contextmenu', event => {
    const id = (event.target as Element).closest<HTMLElement>('[data-list]')?.dataset.list;
    if (id) { event.preventDefault(); openListEditor(listById(id)); }
  });
  nav.addEventListener('pointerdown', event => {
    const id = (event.target as Element).closest<HTMLElement>('[data-list]')?.dataset.list;
    if (!id || event.pointerType === 'mouse') return;
    holdStart(event, () => openListEditor(listById(id)));
  });
  sortable(nav, ids => void mutate(() => storage.putLists(ids.map((id, order) => ({ ...(listById(id) as List), order, updatedAt: Date.now() })))));
}
$('#reorder-lists').addEventListener('click', () => {
  reordering = !reordering;
  $('#reorder-lists').textContent = reordering ? 'Done' : 'Edit';
  $('#reorder-lists').setAttribute('aria-pressed', String(reordering));
  render();
});
listsDialog.addEventListener('close', () => { if (reordering) $('#reorder-lists').click(); });
$('#open-lists').addEventListener('click', () => { if (!gesture.suppressClick) openLists(); });
function openLists(): void { if (!listsDialog.open) { closeSearch(); listsDialog.showModal(); } }
$('#lists-search').addEventListener('click', () => { listsDialog.close(); openSearch(); });
for (const add of document.querySelectorAll('[data-new-list]')) add.addEventListener('click', () => openListEditor());

// A press held for 480ms without moving.
const hold: { timer?: ReturnType<typeof setTimeout>; fired: boolean } = { fired: false };
function holdStart(event: PointerEvent, action: () => void): void {
  clearTimeout(hold.timer);
  hold.fired = false;
  const x = event.clientX;
  const y = event.clientY;
  const cancel = (move: PointerEvent) => { if (move.type !== 'pointermove' || Math.hypot(move.clientX - x, move.clientY - y) > 10) stop(); };
  const stop = () => { clearTimeout(hold.timer); document.removeEventListener('pointermove', cancel); document.removeEventListener('pointerup', cancel); document.removeEventListener('pointercancel', cancel); };
  document.addEventListener('pointermove', cancel);
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  hold.timer = setTimeout(() => { stop(); hold.fired = true; haptic(); action(); setTimeout(() => { hold.fired = false; }, 400); }, 480);
}

// Drag handles reorder siblings; arrow keys on a handle do the same.
function sortable(container: HTMLElement, onDrop: (ids: string[]) => void): void {
  container.addEventListener('pointerdown', event => {
    const handle = (event.target as Element).closest<HTMLElement>('[data-handle]');
    const item = handle?.closest<HTMLElement>('li[data-id]');
    const parent = item?.parentElement;
    if (!handle || !item || !parent) return;
    event.preventDefault();
    const items = [...parent.children].filter((child): child is HTMLElement => child instanceof HTMLElement && Boolean(child.dataset.id));
    const from = items.indexOf(item);
    const boxes = items.map(child => child.getBoundingClientRect());
    const step = (boxes[1] && boxes[0] ? boxes[1].top - boxes[0].top : item.offsetHeight) || item.offsetHeight;
    const startY = event.clientY;
    let to = from;
    item.classList.add('sorting');
    try { handle.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
    const move = (moveEvent: PointerEvent) => {
      const dy = moveEvent.clientY - startY;
      item.style.transform = `translateY(${dy}px)`;
      const own = boxes[from];
      const center = (own ? own.top + own.height / 2 : 0) + dy;
      const found = boxes.findIndex(box => center < box.top + box.height);
      const next = found < 0 ? items.length - 1 : found;
      if (next !== to) { to = next; haptic(); }
      items.forEach((other, position) => {
        if (other === item) return;
        const shift = from < to && position > from && position <= to ? -step : from > to && position >= to && position < from ? step : 0;
        other.style.transform = shift ? `translateY(${shift}px)` : '';
      });
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      for (const other of items) other.style.transform = '';
      item.classList.remove('sorting');
      if (to === from) return;
      const ids = items.map(child => child.dataset.id ?? '');
      ids.splice(to, 0, ...ids.splice(from, 1));
      onDrop(ids);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });
  container.addEventListener('keydown', event => {
    const handle = (event.target as Element).closest<HTMLElement>('[data-handle]');
    const item = handle?.closest<HTMLElement>('li[data-id]');
    if (!item?.parentElement || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const ids = [...item.parentElement.children].map(child => (child as HTMLElement).dataset.id ?? '').filter(Boolean);
    const from = ids.indexOf(item.dataset.id ?? '');
    const to = from + (event.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onDrop(ids);
  });
}

async function refresh(): Promise<void> { ({ todos, lists } = await storage.listAll()); render(); }

async function mutate(operation: () => Promise<void>, onSuccess?: () => void): Promise<void> {
  if (busy || !storageReady) return;
  const focus: Focus = editDialog.open ? { id: editingId, control: 'edit' } : captureFocus();
  setBusy(true);
  $('#error').hidden = true;
  $('#edit-error').hidden = true;
  try {
    await operation();
  } catch (error) {
    render();
    reportError(errorName(error) === 'NotFoundError' ? errorMessage(error) : 'Your change could not be saved. Check available storage and try again. Your draft is still here.');
    setBusy(false);
    restoreFocus(focus);
    if (editDialog.open) editText.focus();
    return;
  }
  try {
    let refreshFailed = false;
    try { ({ todos, lists } = await storage.listAll()); } catch { refreshFailed = true; }
    await animate(render);
    channel?.postMessage('changed');
    onSuccess?.();
    if (refreshFailed) reportError('Your change was saved, but the list could not refresh. Reload the app to see it.');
  } finally { setBusy(false); restoreFocus(focus); }
}

function setView(next: View): void {
  if (next === view && !searchInput.value) return;
  lingering.clear();
  showCompleted = false;
  view = next;
  if (!newTodo.value.trim()) draft = freshDraft();
  searchInput.value = '';
  shell.classList.remove('searching');
  $('#workspace').scrollTop = 0;
  void animate(render);
}

// Composer: one line that understands dates, times, #lists and ! for a star.
function freshDraft(): Draft {
  const next: Draft = { flagged: view === 'starred', blockers: [], skip: new Set() };
  if (view === 'today') next.due = today;
  else if (view === 'upcoming') next.due = addDays(today, 1);
  else if (view.startsWith('list:')) next.listId = view.slice(5);
  return next;
}
function parsed(): QuickAdd { return parseQuickAdd(newTodo.value, today, lists, draft.skip); }
function effective(quick = parsed()): Required<Pick<Draft, 'flagged'>> & When & { listId?: string | undefined } {
  const due = quick.due ?? draft.due ?? (quick.time ? today : undefined);
  return { due, time: due ? quick.time ?? draft.time : undefined, repeat: due ? draft.repeat : undefined, listId: quick.listId ?? draft.listId, flagged: Boolean(quick.flagged || draft.flagged) };
}
function stripTokens(kinds: TokenKind[]): void {
  let value = newTodo.value;
  for (const token of parsed().tokens.filter(item => kinds.includes(item.kind)).sort((a, b) => b.start - a.start)) value = value.slice(0, token.start) + value.slice(token.end);
  newTodo.value = value.replace(/ {2,}/g, ' ');
}
function draftSubs(): HTMLInputElement[] { return [...document.querySelectorAll<HTMLInputElement>('#draft-subs input')]; }
function hasComposerDraft(): boolean { return Boolean(newTodo.value.trim()) || draftSubs().some(input => input.value.trim()); }
function syncComposer(): void {
  const quick = parsed();
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const token of [...quick.tokens].sort((a, b) => a.start - b.start)) {
    fragment.append(newTodo.value.slice(cursor, token.start), element('mark', `tok tok-${token.kind}`, newTodo.value.slice(token.start, token.end)));
    cursor = token.end;
  }
  fragment.append(`${newTodo.value.slice(cursor)}​`);
  $('#mirror').replaceChildren(fragment);
  const value = effective(quick);
  const date = $('#new-date');
  date.classList.toggle('set', Boolean(value.due));
  date.classList.toggle('late', Boolean(value.due && value.due < today));
  $('#new-date-label').textContent = shortWhen(value) || 'Date';
  date.setAttribute('aria-label', value.due ? `Date: ${whenLabel(value)}${value.repeat ? `, ${REPEAT_NAMES[value.repeat]}` : ''}` : 'Date');
  const owner = listById(value.listId);
  $('#new-list').className = `tool${owner ? ` set c-${owner.color}` : ''}`;
  $('#new-list-dot').className = `dot c-${owner?.color ?? 'plain'}`;
  $('#new-list-label').textContent = owner?.name ?? 'List';
  $('#new-list').setAttribute('aria-label', owner ? `List: ${owner.name}` : 'List');
  $('#new-flag').setAttribute('aria-pressed', String(value.flagged));
  const blocker = index.get(draft.blockers[0] ?? '');
  $('#new-dep').classList.toggle('set', Boolean(blocker));
  $('#new-dep-label').textContent = blocker ? `After ${clip(blocker.text, 14)}` : '';
  $('#new-dep').setAttribute('aria-label', blocker ? `Waits on ${blocker.text}` : 'Wait on another task');
  updateComposing();
}
function updateComposing(): void {
  const focused = addForm.contains(document.activeElement);
  const composing = focused || hasComposerDraft();
  addForm.classList.toggle('composing', composing);
  shell.classList.toggle('composing', composing);
  shell.classList.toggle('typing', focused);
}
function startComposing(): void {
  closeSearch();
  addForm.classList.add('composing');
  shell.classList.add('composing');
  newTodo.focus();
  updateComposing();
}
function addDraftSub(after?: HTMLElement): HTMLInputElement {
  const item = element('li');
  const input = element('input');
  input.type = 'text';
  input.maxLength = 2000;
  input.placeholder = 'Add subtask';
  input.enterKeyHint = 'next';
  input.autocapitalize = 'sentences';
  item.append(icon('sub'), input);
  if (after?.parentElement?.parentElement === $('#draft-subs')) after.parentElement.after(item); else $('#draft-subs').append(item);
  draftSubs().forEach((field, position) => field.setAttribute('aria-label', `Subtask ${position + 1}`));
  return input;
}
// The draft always ends with an empty "Add subtask" line.
function ensureTrailingSub(): void {
  const last = draftSubs().at(-1);
  if (!last || last.value.trim()) addDraftSub();
}
$('#draft-subs').addEventListener('keydown', event => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const fields = draftSubs();
  const position = fields.indexOf(input);
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    const next = fields[position + 1];
    if (!input.value.trim()) addForm.requestSubmit();
    else if (next && !next.value.trim()) next.focus();
    else addDraftSub(input).focus();
  } else if (event.key === 'Backspace' && !input.value) {
    event.preventDefault();
    (fields[position - 1] ?? newTodo).focus();
    if (position < fields.length - 1) input.parentElement?.remove();
  }
});
$('#draft-subs').addEventListener('input', () => { ensureTrailingSub(); updateComposing(); });

addForm.addEventListener('submit', event => {
  event.preventDefault();
  const quick = parsed();
  const value = effective(quick);
  let text: string;
  let subTexts: string[];
  try {
    text = normalizeText(quick.text);
    subTexts = draftSubs().map(input => input.value).filter(item => item.trim()).map(normalizeText);
  } catch (error) { reportError(errorMessage(error)); return; }
  const now = Date.now();
  const todo: Todo = { id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now };
  if (value.due) todo.due = value.due;
  if (value.due && value.time) todo.time = value.time;
  if (value.due && value.repeat) todo.repeat = value.repeat;
  if (listById(value.listId)) todo.listId = value.listId as string;
  if (value.flagged) todo.flagged = true;
  const blockers = draft.blockers.filter(id => index.has(id));
  if (blockers.length) todo.blockedBy = blockers;
  const subs: Todo[] = subTexts.map((item, order) => ({ id: crypto.randomUUID(), text: item, completed: false, createdAt: now, updatedAt: now, parentId: todo.id, order }));
  const submitted = newTodo.value;
  void mutate(() => storage.addTodos([todo, ...subs]), () => {
    // Keep anything typed while the add was saving.
    if (newTodo.value === submitted) {
      newTodo.value = '';
      $('#draft-subs').replaceChildren();
      ensureTrailingSub();
      draft = freshDraft();
    }
    haptic();
    if (searchInput.value) { searchInput.value = ''; shell.classList.remove('searching'); }
    if (!selectTodos([todo], view, '', today).length) {
      const landed = viewOf(todo, today);
      notify(`Added to ${owner(todo) ?? NAMES[landed]}${todo.due && landed === 'upcoming' ? `, ${dueLabel(todo.due)}` : ''}.`);
    }
    render();
    if (document.activeElement !== newTodo && addForm.classList.contains('composing') && shell.classList.contains('typing')) newTodo.focus();
    if (todos.length === 1) navigator.storage?.persist?.().catch(() => {});
    setTimeout(autoUpdate);
  });
});
function owner(todo: Todo): string | undefined { return view.startsWith('list:') ? listById(todo.listId)?.name : undefined; }
newTodo.addEventListener('input', () => {
  if (newTodo.value.includes('\n')) newTodo.value = newTodo.value.replace(/\n+/g, ' ');
  syncComposer();
});
newTodo.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addForm.requestSubmit(); }
  else if (event.key === 'Escape') newTodo.blur();
});
newTodo.addEventListener('scroll', () => { $('#mirror').scrollTop = newTodo.scrollTop; });
$('#new-flag').addEventListener('pointerdown', event => event.preventDefault());
$('#new-flag').addEventListener('click', () => {
  if (parsed().flagged) { stripTokens(['star']); draft.flagged = false; } else draft.flagged = !draft.flagged;
  haptic();
  syncComposer();
});
$('#new-date').addEventListener('click', () => {
  const value = effective();
  openDatePicker(value, when => {
    if (when) { stripTokens(['date', 'time']); draft.skip.delete('date'); draft.skip.delete('time'); }
    else { draft.skip.add('date'); draft.skip.add('time'); }
    draft.due = when?.due;
    draft.time = when?.time;
    draft.repeat = when?.repeat;
    syncComposer();
  });
});
$('#new-list').addEventListener('click', () => void (async () => {
  const current = effective().listId;
  const choice = await pick('List', [{ value: '', label: 'No list', selected: !current }, ...sortedLists().map(item => ({ value: item.id, label: item.name, color: item.color, selected: item.id === current }))]);
  if (choice === undefined) return;
  stripTokens(['list']);
  draft.listId = choice || undefined;
  syncComposer();
  newTodo.focus();
})());
$('#new-dep').addEventListener('click', () => void (async () => {
  const choices: Choice[] = openTasks().map(todo => ({ value: todo.id, label: todo.text, selected: draft.blockers.includes(todo.id) }));
  if (draft.blockers.length) choices.unshift({ value: '', label: 'No dependency' });
  const choice = await pick('Wait on', choices, { search: true, empty: 'Add another task first.' });
  if (choice === undefined) return;
  draft.blockers = choice ? [choice] : [];
  syncComposer();
  newTodo.focus();
})());
$('#fab').addEventListener('click', startComposing);
$('#composer-scrim').addEventListener('click', () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
addForm.addEventListener('focusin', updateComposing);
addForm.addEventListener('focusout', () => setTimeout(() => {
  for (const input of draftSubs().slice(0, -1)) if (!input.value.trim() && document.activeElement !== input) input.parentElement?.remove();
  updateComposing();
}, 120));

// Date sheet, shared by the composer and the task sheet. Changes apply live.
let dateApply: ((when: When | null) => void) | undefined;
function openDatePicker(initial: When, apply: (when: When | null) => void): void {
  dateDue.value = initial.due ?? '';
  dateTime.value = initial.time ?? '';
  dateRepeat.value = initial.repeat ?? '';
  dateApply = apply;
  syncDateDialog();
  dateDialog.showModal();
}
function currentWhen(): When {
  if (!dateDue.value && (dateTime.value || dateRepeat.value)) dateDue.value = today;
  return { due: dateDue.value || undefined, time: dateTime.value || undefined, repeat: (dateRepeat.value || undefined) as Repeat | undefined };
}
function quickDate(kind: string | undefined): string {
  return kind === 'today' ? today : kind === 'tomorrow' ? addDays(today, 1) : kind === 'weekend' ? nextWeekend(today) : nextWeek(today);
}
function syncDateDialog(): void {
  for (const quick of document.querySelectorAll<HTMLElement>('[data-quick]')) quick.setAttribute('aria-pressed', String(dateDue.value === quickDate(quick.dataset.quick)));
  $('#date-clear').hidden = !dateDue.value;
}
function applyDate(): void { dateApply?.(currentWhen()); syncDateDialog(); }
for (const quick of document.querySelectorAll<HTMLElement>('[data-quick]')) {
  quick.addEventListener('click', () => { dateDue.value = quickDate(quick.dataset.quick); applyDate(); haptic(); });
}
for (const input of [dateDue, dateTime, dateRepeat]) input.addEventListener('change', applyDate);
$('#date-clear').addEventListener('click', () => { dateApply?.(null); dateDialog.close(); });
$('#date-done').addEventListener('click', () => dateDialog.close());
dateDialog.addEventListener('close', () => { dateApply = undefined; });

// Picker sheet: choose a list, a task or an action.
let pickerResolve: ((value: string | undefined) => void) | undefined;
let pickerChoices: Choice[] = [];
function drawPicker(): void {
  const query = $<HTMLInputElement>('#picker-search').value.trim().toLocaleLowerCase();
  const shown = pickerChoices.filter(choice => !query || choice.label.toLocaleLowerCase().includes(query));
  $('#picker-options').replaceChildren(...shown.map(choice => {
    const option = button(`group-row${choice.danger ? ' danger' : ''}`);
    option.dataset.value = choice.value;
    option.setAttribute('role', 'listitem');
    if (choice.color) option.append(element('i', `dot c-${choice.color}`));
    option.append(element('span', 'option-label', choice.label));
    if (choice.selected) { option.append(icon('check')); option.setAttribute('aria-current', 'true'); }
    return option;
  }));
  $('#picker-empty').hidden = shown.length > 0;
}
function pick(title: string, choices: Choice[], options: { search?: boolean; empty?: string } = {}): Promise<string | undefined> {
  pickerResolve?.(undefined);
  pickerChoices = choices;
  $('#picker-title').textContent = title;
  $<HTMLInputElement>('#picker-search').value = '';
  $('#picker-search-bar').hidden = !options.search;
  $('#picker-empty').textContent = options.empty ?? 'Nothing to choose.';
  drawPicker();
  pickerDialog.showModal();
  if (options.search && !coarse.matches) $('#picker-search').focus();
  return new Promise(resolve => { pickerResolve = resolve; });
}
$('#picker-search').addEventListener('input', drawPicker);
$('#picker-options').addEventListener('click', event => {
  const value = (event.target as Element).closest<HTMLElement>('[data-value]')?.dataset.value;
  if (value === undefined) return;
  const resolve = pickerResolve;
  pickerResolve = undefined;
  pickerDialog.close();
  resolve?.(value);
});
$('#picker-close').addEventListener('click', () => pickerDialog.close());
pickerDialog.addEventListener('close', () => { pickerResolve?.(undefined); pickerResolve = undefined; });

// Task sheet: closing by swipe, backdrop, Escape or Done saves. Subtasks and dependencies save as you change them.
function editorState(): string { return JSON.stringify([editText.value, editNotes.value, edit]); }
function openEditor(todo: Todo): void {
  const current = index.get(todo.id) ?? todo;
  editingId = current.id;
  $('#edit-error').hidden = true;
  $('#error').hidden = true;
  editText.value = current.text;
  editNotes.value = current.notes || '';
  edit = { due: current.due, time: current.time, repeat: current.repeat, listId: current.listId, flagged: Boolean(current.flagged) };
  newSubInput.value = '';
  renderEditor();
  editingSnapshot = editorState();
  if (!editDialog.open) editDialog.showModal();
  editDialog.querySelector('.sheet-body')?.scrollTo({ top: 0 });
  if (!coarse.matches) editText.focus();
}
function dismissEditor(): void {
  if (editorState() !== editingSnapshot) editForm.requestSubmit();
  else editDialog.close();
}
function formChanges(): TodoChanges {
  return {
    text: normalizeText(editText.value), notes: normalizeNotes(editNotes.value) || undefined, due: edit.due,
    time: edit.due ? edit.time : undefined, repeat: edit.due ? edit.repeat : undefined,
    flagged: edit.flagged || undefined, listId: listById(edit.listId) ? edit.listId : undefined
  };
}
function renderEditor(): void {
  const todo = index.get(editingId);
  if (!todo) return;
  const owner = listById(edit.listId);
  $('#edit-list-dot').className = `dot c-${owner?.color ?? 'plain'}`;
  $('#edit-list-label').textContent = owner?.name ?? 'No list';
  $('#edit-list').className = `crumb${owner ? ` c-${owner.color}` : ''}`;
  $('#edit-list').setAttribute('aria-label', `List: ${owner?.name ?? 'none'}`);
  $('#edit-flag').setAttribute('aria-pressed', String(edit.flagged));
  $('#edit-box').classList.toggle('done', todo.completed);
  const when = whenLabel(edit);
  const whenNode = $('#edit-when');
  whenNode.textContent = [when, edit.due && edit.repeat ? REPEAT_NAMES[edit.repeat] : ''].filter(Boolean).join(' · ');
  whenNode.className = `when${edit.due && edit.due < today ? ' late' : edit.due === today ? ' soon' : ''}`;
  $('#edit-date-label').textContent = when || 'None';
  $('#edit-repeat-label').textContent = edit.due && edit.repeat ? REPEAT_NAMES[edit.repeat] : 'Never';

  const subs = subtasksOf(todos, todo.id);
  const done = subs.filter(sub => sub.completed).length;
  $('#subs-count').textContent = subs.length ? `${done} of ${subs.length}` : '';
  $('#subs-bar').style.setProperty('--fill', String(subs.length ? done / subs.length : 0));
  $('#subs-heading').classList.toggle('has-subs', subs.length > 0);
  const subList = $('#edit-subs');
  if (!subList.contains(document.activeElement)) {
    subList.replaceChildren(...subs.map(sub => {
      const item = element('li', `sub-item${sub.completed ? ' completed' : ''}`);
      item.dataset.id = sub.id;
      const text = element('input', 'sub-input');
      text.type = 'text';
      text.value = sub.text;
      text.maxLength = 2000;
      text.enterKeyHint = 'done';
      text.setAttribute('aria-label', `Subtask: ${sub.text}`);
      text.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); text.blur(); } });
      text.addEventListener('change', () => {
        if (!text.value.trim()) { void mutate(() => storage.deleteTodos([sub.id])); return; }
        let value: string;
        try { value = normalizeText(text.value); } catch (error) { reportError(errorMessage(error)); return; }
        if (value !== sub.text) void mutate(() => storage.changeTodo(sub.id, { text: value }));
      });
      const handle = button('handle');
      handle.dataset.handle = '';
      handle.setAttribute('aria-label', `Move ${sub.text}`);
      handle.append(icon('handle'));
      const remove = button('sub-remove');
      remove.setAttribute('aria-label', `Delete subtask ${sub.text}`);
      remove.append(icon('close'));
      remove.addEventListener('click', () => void mutate(() => storage.deleteTodos([sub.id])));
      item.append(checkControl(sub, `edit-sub-${sub.id}`, false, true), text, handle, remove);
      return item;
    }));
  }

  const topLevel = isTopLevel(todo, index);
  $('#deps-block').hidden = !topLevel;
  const waits = (todo.blockedBy ?? []).map(id => index.get(id)).filter((item): item is Todo => item !== undefined);
  const blocks = dependentsOf(todos, todo.id).filter(isOpen);
  const rows: HTMLLIElement[] = [];
  for (const blocker of waits) {
    const item = element('li', 'dep');
    const box = element('span', `box${blocker.completed ? ' done' : ' lock'}`);
    box.append(icon(blocker.completed ? 'check' : 'lock'));
    const open = button('dep-link');
    open.append(element('span', 'dep-kind', 'Waits on'), element('span', 'dep-text', blocker.text));
    open.setAttribute('aria-label', `Waits on ${blocker.text}${blocker.completed ? ', done' : ''}`);
    open.addEventListener('click', () => switchEditor(blocker));
    const remove = button('sub-remove');
    remove.setAttribute('aria-label', `Stop waiting on ${blocker.text}`);
    remove.append(icon('close'));
    remove.addEventListener('click', () => void mutate(() => storage.changeTodo(todo.id, { blockedBy: (todo.blockedBy ?? []).filter(id => id !== blocker.id) })));
    item.append(box, open, remove);
    rows.push(item);
  }
  for (const dependent of blocks) {
    const item = element('li', 'dep');
    const box = element('span', 'box lock');
    box.append(icon('lock'));
    const open = button('dep-link');
    open.append(element('span', 'dep-kind', 'Blocks'), element('span', 'dep-text', dependent.text));
    open.setAttribute('aria-label', `Blocks ${dependent.text}`);
    open.addEventListener('click', () => switchEditor(dependent));
    item.append(box, open);
    rows.push(item);
  }
  $('#edit-deps').replaceChildren(...rows);
  const blocked = !todo.completed && blockersOf(todo, index).length > 0;
  $('#edit-complete').setAttribute('aria-disabled', String(blocked));
  $('#edit-complete-label').textContent = todo.completed ? 'Reopen' : blocked ? `Waiting on ${blockersOf(todo, index).length}` : 'Complete';
  $('#edit-complete').classList.toggle('reopen', todo.completed);
}
function switchEditor(next: Todo): void {
  if (editorState() === editingSnapshot) { openEditor(next); return; }
  let changes: TodoChanges;
  try { changes = formChanges(); } catch (error) { reportError(errorMessage(error)); return; }
  void mutate(() => storage.changeTodo(editingId, changes), () => openEditor(next));
}
$('#edit-flag').addEventListener('click', () => { edit.flagged = !edit.flagged; haptic(); renderEditor(); });
$('#edit-list').addEventListener('click', () => void (async () => {
  const choice = await pick('List', [{ value: '', label: 'No list', selected: !edit.listId }, ...sortedLists().map(item => ({ value: item.id, label: item.name, color: item.color, selected: item.id === edit.listId }))]);
  if (choice === undefined) return;
  edit.listId = choice || undefined;
  renderEditor();
})());
for (const id of ['#edit-date', '#edit-repeat']) {
  $(id).addEventListener('click', () => {
    openDatePicker(edit, when => { edit = { ...edit, due: when?.due, time: when?.time, repeat: when?.repeat }; renderEditor(); });
    if (id === '#edit-repeat') dateRepeat.focus();
  });
}
newSubInput.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing) return;
  event.preventDefault();
  if (!newSubInput.value.trim()) { newSubInput.blur(); return; }
  let text: string;
  try { text = normalizeText(newSubInput.value); } catch (error) { reportError(errorMessage(error)); return; }
  const now = Date.now();
  const order = Math.max(-1, ...subtasksOf(todos, editingId).map(sub => sub.order ?? 0)) + 1;
  const sub: Todo = { id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now, parentId: editingId, order };
  void mutate(() => storage.addTodos([sub]), () => { newSubInput.value = ''; newSubInput.focus(); });
});
sortable($('#edit-subs'), ids => void mutate(() => storage.changeTodos(ids.map((id, order) => [id, { order }]))));
$('#add-dep').addEventListener('click', () => void (async () => {
  const todo = index.get(editingId);
  if (!todo) return;
  const choices = openTasks().filter(item => !todo.blockedBy?.includes(item.id) && canDepend(todos, todo.id, item.id)).map(item => ({ value: item.id, label: item.text }));
  const choice = await pick('Wait on', choices, { search: true, empty: 'No other open task can come first.' });
  if (!choice) return;
  void mutate(() => storage.changeTodo(todo.id, { blockedBy: [...(todo.blockedBy ?? []), choice] }));
})());
editForm.addEventListener('submit', event => {
  event.preventDefault();
  let changes: TodoChanges;
  try { changes = formChanges(); } catch (error) { reportError(errorMessage(error)); return; }
  void mutate(() => storage.changeTodo(editingId, changes), () => { editDialog.close(); });
});
editText.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); editForm.requestSubmit(); }
});
$('#edit-complete').addEventListener('click', () => {
  const todo = index.get(editingId);
  if (!todo) return;
  if (!todo.completed && blockersOf(todo, index).length) { refuseBlocked(todo); return; }
  let changes: TodoChanges;
  try { changes = formChanges(); } catch (error) { reportError(errorMessage(error)); return; }
  const merged = { ...todo, ...changes } as Todo;
  const { entries, note } = completionEntries(merged, !todo.completed);
  const [first, ...rest] = entries;
  if (!first) return;
  if (!todo.completed) { haptic(); if (!merged.repeat) lingering.add(todo.id); }
  void mutate(() => storage.changeTodos([[first[0], { ...changes, ...first[1] }], ...rest]), () => { editDialog.close(); if (note) notify(note); });
});
$('#edit-later').addEventListener('click', () => {
  edit.due = laterDate(edit.due);
  const label = dueLabel(edit.due);
  let changes: TodoChanges;
  try { changes = formChanges(); } catch (error) { reportError(errorMessage(error)); return; }
  void mutate(() => storage.changeTodo(editingId, { ...changes, completed: false, completedAt: undefined }), () => { editDialog.close(); notify(`Moved to ${label}.`); });
});
$('#edit-more').addEventListener('click', () => void (async () => {
  const choice = await pick('Task', [{ value: 'share', label: 'Share' }, { value: 'delete', label: 'Delete task', danger: true }]);
  const todo = index.get(editingId);
  if (!todo) return;
  if (choice === 'delete') { editDialog.close(); deleteTask(todo); }
  else if (choice === 'share') {
    const subs = subtasksOf(todos, todo.id).map(sub => `${sub.completed ? '☑' : '☐'} ${sub.text}`);
    const text = [editText.value.trim(), subs.join('\n'), editNotes.value.trim()].filter(Boolean).join('\n\n');
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); editDialog.close(); notify('Copied to clipboard.'); }
    } catch (error) { if (errorName(error) !== 'AbortError') reportError('Sharing is unavailable here.'); }
  }
})());
editDialog.addEventListener('cancel', event => { event.preventDefault(); dismissEditor(); });

// List editor
const swatches = $('#swatches');
for (const color of COLORS) {
  const label = element('label', `swatch c-${color}`);
  const input = element('input');
  input.type = 'radio';
  input.name = 'color';
  input.value = color;
  input.setAttribute('aria-label', COLOR_NAMES[color]);
  label.append(input, icon('check'));
  swatches.append(label);
}
function openListEditor(item?: List): void {
  editingList = item;
  $('#list-title').textContent = item ? 'Edit list' : 'New list';
  $<HTMLInputElement>('#list-name').value = item?.name ?? '';
  const color = item?.color ?? COLORS[lists.length % COLORS.length] ?? 'blue';
  for (const input of swatches.querySelectorAll('input')) input.checked = input.value === color;
  $('#delete-list').hidden = !item;
  $('#list-error').hidden = true;
  listDialog.showModal();
  if (!coarse.matches || !item) $('#list-name').focus();
}
listForm.addEventListener('submit', event => {
  event.preventDefault();
  let name: string;
  try { name = normalizeListName($<HTMLInputElement>('#list-name').value); } catch (error) { reportError(errorMessage(error)); return; }
  const color = (swatches.querySelector<HTMLInputElement>('input:checked')?.value ?? 'blue') as Color;
  const now = Date.now();
  const item: List = editingList ? { ...editingList, name, color, updatedAt: now }
    : { id: crypto.randomUUID(), name, color, order: Math.max(-1, ...lists.map(entry => entry.order)) + 1, createdAt: now, updatedAt: now };
  const created = !editingList;
  void mutate(() => storage.putList(item), () => {
    listDialog.close();
    if (created) { if (listsDialog.open) listsDialog.close(); setView(`list:${item.id}`); }
  });
});
$('#delete-list').addEventListener('click', () => {
  const item = editingList;
  if (!item || !confirm(`Delete "${item.name}"? Its tasks stay in All.`)) return;
  void mutate(() => storage.deleteList(item.id), () => {
    listDialog.close();
    if (view === `list:${item.id}`) setView('all');
    notify(`Deleted "${clip(item.name)}".`);
  });
});

// Long-press quick actions
function openActions(todo: Todo): void {
  if (busy) return;
  actionTodo = todo;
  haptic();
  $('#actions-title').textContent = todo.text;
  $('#action-flag-label').textContent = todo.flagged ? 'Unstar' : 'Star';
  $('[data-action="flag"]').classList.toggle('on', Boolean(todo.flagged));
  actionsDialog.showModal();
}
for (const action of document.querySelectorAll<HTMLElement>('[data-action]')) {
  action.addEventListener('click', () => {
    const todo = actionTodo;
    const kind = action.dataset.action;
    actionsDialog.close();
    if (!todo) return;
    if (kind === 'delete') deleteTask(todo);
    else if (kind === 'flag') void mutate(() => storage.changeTodo(todo.id, { flagged: todo.flagged ? undefined : true }));
    else moveTask(todo, quickDate(kind));
  });
}

// Every sheet: tap the backdrop or swipe down to close.
function closeSheet(dialog: HTMLDialogElement): void {
  if (dialog === editDialog) dismissEditor();
  else dialog.close();
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSheet(dialog); });
  dialog.addEventListener('close', () => { dialog.style.removeProperty('--drag'); dialog.classList.remove('dragging', 'settling'); });
  let start: { x: number; y: number; time: number; dy: number; active: boolean } | null = null;
  dialog.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || !coarse.matches || desktop.matches) return;
    const target = event.target as Element;
    const body = target.closest('.sheet-body');
    if (target.closest('textarea:focus, input:focus, [data-handle], select')) return;
    if (body && body.scrollTop > 0) return;
    start = { y: touch.clientY, x: touch.clientX, time: Date.now(), dy: 0, active: false };
  }, { passive: true });
  dialog.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (!start.active) {
      if (dy > 8 && dy > Math.abs(dx)) { start.active = true; dialog.classList.add('dragging'); }
      else if (Math.abs(dy) > 8 || Math.abs(dx) > 8) { start = null; return; }
      else return;
    }
    event.preventDefault();
    start.dy = Math.max(0, dy);
    dialog.style.setProperty('--drag', `${start.dy}px`);
  }, { passive: false });
  dialog.addEventListener('touchend', () => {
    if (!start?.active) { start = null; return; }
    const { dy, time } = start;
    start = null;
    dialog.classList.remove('dragging');
    dialog.classList.add('settling');
    const fast = dy / Math.max(1, Date.now() - time) > 0.6;
    if (dy > 120 || (fast && dy > 40)) {
      dialog.style.setProperty('--drag', `${dialog.offsetHeight}px`);
      setTimeout(() => closeSheet(dialog), 200);
      setTimeout(() => { if (dialog.open) { dialog.style.removeProperty('--drag'); } dialog.classList.remove('settling'); }, 280);
    } else {
      dialog.style.removeProperty('--drag');
      setTimeout(() => dialog.classList.remove('settling'), 280);
    }
  });
}

// Search
searchInput.addEventListener('input', () => render());
searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') $('#cancel-search').click(); });
function openSearch(): void { shell.classList.add('searching'); searchInput.focus(); render(); }
function closeSearch(): void {
  if (!shell.classList.contains('searching') && !searchInput.value) return;
  searchInput.value = '';
  shell.classList.remove('searching');
  render();
}
$('#open-search').addEventListener('click', () => { if (!gesture.suppressClick) openSearch(); });
$('#cancel-search').addEventListener('click', closeSearch);

// Dock: slide along Today and Upcoming to switch; swipe the dock up for lists.
const viewNav = $('#views');
let scrub: { start: string | undefined; y: number; moved: boolean } | null = null;
for (const tab of document.querySelectorAll<HTMLElement>('#views [data-view]')) tab.addEventListener('click', () => {
  if (!gesture.suppressClick && isView(tab.dataset.view)) setView(tab.dataset.view);
});
viewNav.addEventListener('pointerdown', event => {
  scrub = event.pointerType === 'mouse' ? null : { start: (event.target as Element).closest<HTMLElement>('[data-view]')?.dataset.view, y: event.clientY, moved: false };
});
viewNav.addEventListener('pointermove', event => {
  if (!scrub) return;
  // Hit-test the tab boxes directly: elementFromPoint sees the overlay while a view transition runs.
  const next = [...viewNav.querySelectorAll<HTMLElement>('[data-view]')].find(tab => {
    const box = tab.getBoundingClientRect();
    return event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
  })?.dataset.view;
  if (!isView(next) || (!scrub.moved && next === scrub.start)) return;
  scrub.moved = true;
  if (next !== view || searchInput.value) { setView(next); haptic(); }
});
for (const type of ['pointerup', 'pointercancel'] as const) viewNav.addEventListener(type, event => {
  const swipedUp = type === 'pointerup' && scrub !== null && !scrub.moved && scrub.y - event.clientY > 32;
  if (scrub?.moved || swipedUp) suppressClick();
  scrub = null;
  if (swipedUp) { haptic(); openLists(); }
});
$('#undo').addEventListener('click', () => {
  const action = undoAction;
  undoAction = undefined;
  $('#notice').hidden = true;
  action?.();
});
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });

// Row gestures: swipe right completes; swipe left reveals Later and Delete, and a long swipe deletes.
// Hold to lift a task: release for quick actions, or drag it onto a day in the week strip.
interface Drag {
  todo: Todo; row: HTMLElement; surface: HTMLElement; id: number; x: number; y: number; dx: number; width: number;
  axis: 'x' | null; armed: boolean; lifted: boolean; dragging: boolean; ghost?: HTMLElement; days?: Array<[string, DOMRect]>; day?: string | undefined;
}
const REVEAL = 156;
const gesture: { suppressClick: boolean; timer?: ReturnType<typeof setTimeout>; drag: Drag | null; revealed: HTMLElement | null } = { suppressClick: false, drag: null, revealed: null };
function closeReveal(): void {
  const row = gesture.revealed;
  gesture.revealed = null;
  if (!row) return;
  const surface = row.querySelector<HTMLElement>('.row');
  if (surface) surface.style.transform = '';
  surface?.addEventListener('transitionend', () => { if (gesture.revealed !== row) delete row.dataset.swipe; }, { once: true });
}
document.addEventListener('pointerdown', event => { if (gesture.revealed && !gesture.revealed.contains(event.target as Node)) closeReveal(); }, true);
function rowPointerDown(event: PointerEvent, todo: Todo, row: HTMLElement, surface: HTMLElement): void {
  if (event.pointerType === 'mouse' || busy || (event.target as Element).closest('.row-delete, .check, .expand')) return;
  if (event.clientX < 20 || gesture.revealed === row) return;
  clearTimeout(gesture.timer);
  gesture.drag = { todo, row, surface, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, width: row.offsetWidth, axis: null, armed: false, lifted: false, dragging: false };
  surface.classList.add('pressing');
  gesture.timer = setTimeout(() => {
    const drag = gesture.drag;
    if (!drag || drag.axis) return;
    drag.lifted = true;
    surface.classList.remove('pressing');
    row.classList.add('lifted');
    shell.classList.add('lifting');
    drag.days = [...document.querySelectorAll<HTMLElement>('#week [data-day]')].map(cell => [cell.dataset.day ?? '', cell.getBoundingClientRect()]);
    haptic();
  }, 450);
}
function suppressClick(): void {
  gesture.suppressClick = true;
  setTimeout(() => { gesture.suppressClick = false; }, 400);
}
// Once a task is lifted or swiping sideways, the list must not scroll under the finger.
document.addEventListener('touchmove', event => { if (gesture.drag?.lifted || gesture.drag?.axis === 'x') event.preventDefault(); }, { passive: false });
document.addEventListener('pointermove', event => {
  const drag = gesture.drag;
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  if (drag.lifted) {
    if (!drag.dragging && Math.hypot(dx, dy) < 8) return;
    if (!drag.dragging) {
      drag.dragging = true;
      drag.ghost = element('div', 'drag-ghost');
      drag.ghost.append(element('span', 'box'), drag.todo.text);
      document.body.append(drag.ghost);
      drag.row.classList.add('ghosted');
    }
    drag.ghost?.style.setProperty('transform', `translate(${event.clientX - 40}px, ${event.clientY - 28}px) rotate(-3deg)`);
    const day = drag.days?.find(([, box]) => event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top - 24 && event.clientY <= box.bottom + 24)?.[0];
    if (day !== drag.day) {
      drag.day = day;
      for (const cell of document.querySelectorAll<HTMLElement>('#week [data-day]')) cell.classList.toggle('drop', cell.dataset.day === day);
      if (day) haptic();
    }
    return;
  }
  if (!drag.axis) {
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      drag.axis = 'x';
      clearTimeout(gesture.timer);
      drag.surface.classList.remove('pressing');
      drag.surface.classList.add('dragging');
      try { drag.surface.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
    } else if (Math.abs(dy) > 10 || Math.abs(dx) > 10) {
      clearTimeout(gesture.timer);
      drag.surface.classList.remove('pressing');
      gesture.drag = null;
      return;
    } else return;
  }
  drag.dx = Math.max(-drag.width * 0.9, Math.min(drag.width * 0.75, dx));
  drag.surface.style.transform = `translateX(${drag.dx}px)`;
  drag.row.dataset.swipe = drag.dx > 0 ? 'right' : 'left';
  const armed = drag.dx > 0 ? drag.dx > drag.width * 0.3 : drag.dx < -drag.width * 0.6;
  if (armed !== drag.armed) { drag.armed = armed; drag.row.classList.toggle('armed', armed); if (armed) haptic(); }
});
function rowPointerEnd(event: PointerEvent): void {
  const drag = gesture.drag;
  if (!drag || event.pointerId !== drag.id) return;
  clearTimeout(gesture.timer);
  gesture.drag = null;
  const { row, surface, todo, armed, dx, axis } = drag;
  surface.classList.remove('pressing');
  if (drag.lifted) {
    suppressClick();
    row.classList.remove('lifted', 'ghosted');
    shell.classList.remove('lifting');
    drag.ghost?.remove();
    for (const cell of document.querySelectorAll('#week .drop')) cell.classList.remove('drop');
    if (!drag.dragging && event.type === 'pointerup') openActions(todo);
    else if (drag.day && event.type === 'pointerup') moveTask(todo, drag.day);
    return;
  }
  if (axis !== 'x') return;
  suppressClick();
  surface.classList.remove('dragging');
  row.classList.remove('armed');
  if (event.type === 'pointerup' && dx > 0 && armed) {
    surface.style.transform = '';
    toggleTodo(todo, !todo.completed);
  } else if (event.type === 'pointerup' && dx < 0 && armed) {
    surface.style.transform = 'translateX(-110%)';
    setTimeout(() => deleteTask(todo), 160);
  } else if (event.type === 'pointerup' && dx < -48) {
    surface.style.transform = `translateX(${-REVEAL}px)`;
    gesture.revealed = row;
  } else {
    surface.style.transform = '';
    surface.addEventListener('transitionend', () => { delete row.dataset.swipe; }, { once: true });
  }
}
document.addEventListener('pointerup', rowPointerEnd);
document.addEventListener('pointercancel', rowPointerEnd);

// Pull the list down to add a task.
{
  const area = $('#workspace');
  const pull = $('#pull');
  const threshold = 72;
  let start: { x: number; y: number; distance: number; active: boolean } | null = null;
  area.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || area.scrollTop > 0 || busy || !storageReady) { start = null; return; }
    start = { y: touch.clientY, x: touch.clientX, distance: 0, active: false };
  }, { passive: true });
  area.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (!start || !touch || gesture.drag?.lifted) return;
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (!start.active) {
      if (dy > 6 && dy > Math.abs(dx) * 1.2 && area.scrollTop <= 0) start.active = true;
      else if (Math.abs(dx) > 6 || dy < -6) { start = null; return; }
      else return;
    }
    event.preventDefault();
    start.distance = Math.max(0, dy * 0.55);
    area.style.setProperty('--pull', `${Math.min(start.distance, 120)}px`);
    area.style.setProperty('--pull-opacity', String(Math.min(1, start.distance / 40)));
    const armed = start.distance >= threshold;
    if (armed !== pull.classList.contains('armed')) {
      pull.classList.toggle('armed', armed);
      $('#pull-label').textContent = armed ? 'Release to add' : 'Pull to add a task';
      if (armed) haptic();
    }
  }, { passive: false });
  const finish = () => {
    if (!start?.active) { start = null; return; }
    const armed = start.distance >= threshold;
    start = null;
    area.classList.add('releasing');
    area.style.setProperty('--pull', '0px');
    area.style.setProperty('--pull-opacity', '0');
    pull.classList.remove('armed');
    $('#pull-label').textContent = 'Pull to add a task';
    setTimeout(() => area.classList.remove('releasing'), 240);
    if (armed) startComposing();
  };
  area.addEventListener('touchend', finish);
  area.addEventListener('touchcancel', finish);
}

// Swipe left or right outside the task cards and controls to move between views.
{
  let start: { x: number; y: number } | null = null;
  shell.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    const outside = !(event.target as Element).closest('.todo, .dock, .composer, .search-field, .week, button, input, textarea');
    start = touch && event.touches.length === 1 && outside && !shell.classList.contains('searching') ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  shell.addEventListener('touchend', event => {
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const position = SWIPE_VIEWS.indexOf(view);
    const next = position < 0 ? undefined : SWIPE_VIEWS[position + (dx < 0 ? 1 : -1)];
    if (next) { setView(next); haptic(); }
  }, { passive: true });
}

// Swipe down on the search field to close search.
{
  const bar = $('#search-bar');
  let startY: number | null = null;
  bar.addEventListener('touchstart', event => { startY = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null; }, { passive: true });
  bar.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (startY !== null && touch && touch.clientY - startY > 30 && shell.classList.contains('searching')) { startY = null; searchInput.blur(); closeSearch(); }
  }, { passive: true });
}

// Swipe down on the composer to put the keyboard away; the draft stays.
{
  let startY: number | null = null;
  addForm.addEventListener('touchstart', event => { startY = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null; }, { passive: true });
  addForm.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    const focused = document.activeElement;
    if (startY !== null && touch && touch.clientY - startY > 30 && focused instanceof HTMLElement && addForm.contains(focused)) { focused.blur(); startY = null; }
  }, { passive: true });
}

// Settings
for (const opener of document.querySelectorAll('[data-open-settings]')) opener.addEventListener('click', () => {
  if (listsDialog.open) listsDialog.close();
  settingsDialog.showModal();
});
$('#close-settings').addEventListener('click', () => settingsDialog.close());
$('#clear-completed').addEventListener('click', () => {
  if (confirm('Permanently delete all completed tasks?')) void mutate(storage.clearCompleted, () => notify('Completed tasks cleared.'));
});
$('#export').addEventListener('click', () => void (async () => {
  try {
    const saved = await storage.listAll();
    const name = `tuck-${localDate()}.json`;
    const file = new File([JSON.stringify({ version: 2, todos: saved.todos, lists: saved.lists }, null, 2)], name, { type: 'application/json' });
    if (coarse.matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Tuck backup' }); return; }
      catch (error) { if (errorName(error) === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { reportError('The backup could not be exported. Try again.'); }
})());
$('#import').addEventListener('click', () => $('#import-file').click());
const importFile = $<HTMLInputElement>('#import-file');
importFile.addEventListener('change', () => void (async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a backup smaller than 10 MB.');
    const imported = parseBackup(await file.text());
    settingsDialog.close();
    await mutate(() => storage.importBackup(imported), () => notify('Backup merged. Newer changes on this device were kept.'));
  } catch (error) { settingsDialog.close(); reportError(`Import failed. ${errorMessage(error)}`); }
  finally { importFile.value = ''; }
})());

// App icon badge (home-screen apps on iOS 16.4+ after notification permission)
const badgeKey = 'tuck:badge';
function badgeEnabled(): boolean { try { return localStorage.getItem(badgeKey) === '1'; } catch { return false; } }
function updateBadge(count: number): void {
  if (!('setAppBadge' in navigator) || !badgeEnabled()) return;
  (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
if ('setAppBadge' in navigator) {
  $('#badge-row').hidden = false;
  badgeToggle.checked = badgeEnabled();
  badgeToggle.addEventListener('change', () => void (async () => {
    const toggle = badgeToggle;
    if (toggle.checked && 'Notification' in window && Notification.permission === 'default') {
      if (await Notification.requestPermission() !== 'granted') toggle.checked = false;
    }
    try { localStorage.setItem(badgeKey, toggle.checked ? '1' : '0'); } catch { /* private mode */ }
    if (toggle.checked) updateBadge(countViews(todos, today).today);
    else navigator.clearAppBadge().catch(() => {});
  })());
}

channel?.addEventListener('message', () => { refresh().catch(() => reportError('Could not refresh your list. Reload to try again.')); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && storageReady) refresh().catch(() => reportError('Could not refresh your list. Reload to try again.'));
});
// Roll the views over at midnight while the app stays open.
setInterval(() => { if (storageReady && localDate() !== today) { if (draft.due === today) draft.due = localDate(); render(); } }, 60000);

// Keyboard shortcuts for desktop
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
  if (event.key === 'n' || event.key === 'N') { event.preventDefault(); startComposing(); }
  else if (event.key === '/') { event.preventDefault(); openSearch(); }
  else if (/^[1-5]$/.test(event.key)) { const next = SMART[Number(event.key) - 1]; if (next) setView(next); }
});

function connectionChanged(): void { $('#rail-status').textContent = navigator.onLine ? 'Saved on this device' : 'Offline, still saving'; }
window.addEventListener('online', connectionChanged);
window.addEventListener('offline', connectionChanged);
connectionChanged();

// Track the visual viewport so the composer rides above the iOS keyboard.
function fitViewport(): void {
  if (!window.visualViewport || window.visualViewport.scale > 1.01) return;
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${window.visualViewport.height}px`);
  root.setProperty('--app-top', `${window.visualViewport.offsetTop}px`);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
fitViewport();
new ResizeObserver(() => document.documentElement.style.setProperty('--dock-height', `${$('#dock').offsetHeight}px`)).observe($('#dock'));

// Older WebKit ports need an edge-only fallback. Modern Safari scrolls natively.
if (!CSS.supports('overscroll-behavior', 'none')) {
  let touchY = 0;
  document.addEventListener('touchstart', event => {
    if (event.touches.length === 1) touchY = event.touches[0]?.clientY ?? 0;
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (event.touches.length !== 1) return;
    const delta = (event.touches[0]?.clientY ?? touchY) - touchY;
    touchY = event.touches[0]?.clientY ?? touchY;
    let node = event.target instanceof Element ? event.target : null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        if ((delta < 0 && node.scrollTop + node.clientHeight < node.scrollHeight - 1) || (delta > 0 && node.scrollTop > 0)) return;
      }
      node = node.parentElement;
    }
    if (delta) event.preventDefault();
  }, { passive: false });
}

const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event as InstallPromptEvent; });
window.addEventListener('appinstalled', () => { deferredInstall = undefined; $('#install').hidden = true; });
$('#install').hidden = standalone;
$('#install').addEventListener('click', () => void (async () => {
  if (deferredInstall) { await deferredInstall.prompt(); deferredInstall = undefined; }
  else $('#install-help').hidden = !$('#install-help').hidden;
})());

$('#persist').addEventListener('click', () => void (async () => {
  try {
    const granted = await navigator.storage.persist();
    $('#persistence-status').textContent = granted ? 'Storage is protected. Keep a backup too.' : 'Your browser manages storage automatically. Keep a backup.';
    $('#persist').hidden = granted;
  } catch { $('#persistence-status').textContent = 'Storage protection is unavailable. Keep a backup.'; }
})());

// Updates apply themselves as soon as nothing unsaved would be lost by the reload.
// A real update is a different, fully installed worker waiting behind the active one. During a first install
// WebKit can briefly report the activating worker as waiting, which must not trigger a reload.
function hasDraft(): boolean { return hasComposerDraft() || Boolean(document.querySelector('dialog[open]')); }
function updateWaiting(): boolean {
  const waiting = registration?.waiting;
  return Boolean(waiting && waiting.state === 'installed' && registration?.active && registration.active !== waiting && navigator.serviceWorker.controller);
}
function applyUpdate(): void {
  const waiting = registration?.waiting;
  if (!waiting || !updateWaiting() || refreshing) return;
  refreshing = true;
  try { sessionStorage.setItem('tuck:updated', '1'); } catch { /* the toast is optional */ }
  waiting.postMessage('ACTIVATE_UPDATE');
}
function autoUpdate(): void { if (updateWaiting() && !busy && !hasDraft()) applyUpdate(); }
function checkForUpdate(): void { registration?.update().catch(() => {}); }

async function startOffline(): Promise<void> {
  if (!('serviceWorker' in navigator)) { $('#offline-status').textContent = 'Unavailable'; return; }
  try {
    const current = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    registration = current;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) location.reload(); });
    const updateReady = () => { $('#update-app').hidden = !updateWaiting(); autoUpdate(); };
    current.addEventListener('updatefound', () => {
      const worker = current.installing;
      worker?.addEventListener('statechange', updateReady);
    });
    updateReady();
    await navigator.serviceWorker.ready;
    $('#offline-status').textContent = 'Ready for offline';
    setInterval(checkForUpdate, 60 * 60 * 1000);
  } catch { $('#offline-status').textContent = 'Connect once to enable'; }
}
$('#update-app').addEventListener('click', () => {
  if (hasDraft() && !confirm('Updating reloads the app. Discard your unsaved draft?')) return;
  applyUpdate();
});
newTodo.addEventListener('input', autoUpdate);
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => setTimeout(autoUpdate));
document.addEventListener('visibilitychange', () => { if (document.hidden) autoUpdate(); else checkForUpdate(); });

try {
  ({ todos, lists } = await storage.listAll());
  storageReady = true;
  index = byId(todos);
  const counts = countViews(todos, today);
  if (!counts.today && !counts.doneToday && counts.upcoming) view = 'upcoming';
  else if (!counts.today && !counts.doneToday && counts.all) view = 'all';
  draft = freshDraft();
  ensureTrailingSub();
  render();
  if (new URLSearchParams(location.search).has('new')) startComposing();
  try { if (sessionStorage.getItem('tuck:updated')) { sessionStorage.removeItem('tuck:updated'); notify('Tuck updated.'); } } catch { /* private mode */ }
  if ('storage' in navigator && 'persist' in navigator.storage) {
    const persistent = await navigator.storage.persisted();
    $('#persist').hidden = persistent;
    if (persistent) $('#persistence-status').textContent = 'Storage is protected. Keep a backup too.';
  }
} catch { reportError('Storage is unavailable. Allow site storage in your browser, then reload.'); }
void startOffline();
