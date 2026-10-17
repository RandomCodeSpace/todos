import { normalizeText, normalizeNotes, parseBackup, selectTodos, countViews, viewOf, localDate, addDays, nextWeekend, VIEWS } from './model.js';
import type { Todo, View } from './model.js';
import * as storage from './storage.js';
import type { TodoChanges } from './storage.js';

interface InstallPromptEvent extends Event { prompt(): Promise<void>; }
type Focus = { id?: string | undefined; control?: string | null | undefined; index?: number };

function $<T extends HTMLElement = HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element ${selector}`);
  return node;
}
const newTodo = $<HTMLInputElement>('#new-todo');
const newDue = $<HTMLInputElement>('#new-due');
const searchInput = $<HTMLInputElement>('#search');
const editText = $<HTMLTextAreaElement>('#edit-text');
const editDue = $<HTMLInputElement>('#edit-due');
const editFlag = $<HTMLInputElement>('#edit-flag');
const editNotes = $<HTMLTextAreaElement>('#edit-notes');
const badgeToggle = $<HTMLInputElement>('#badge-toggle');
const addForm = $<HTMLFormElement>('#add-form');
const editForm = $<HTMLFormElement>('#edit-form');
const editDialog = $<HTMLDialogElement>('#edit-dialog');
const settingsDialog = $<HTMLDialogElement>('#settings-dialog');
const actionsDialog = $<HTMLDialogElement>('#actions-dialog');
const list = $('#todo-list');
const NAMES: Record<View, string> = { today: 'Today', upcoming: 'Upcoming', anytime: 'Anytime', done: 'Done' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarse = matchMedia('(pointer: coarse)');
let todos: Todo[] = [];
let view: View = 'today';
let today = localDate();
let editingId = '';
let editingSnapshot = '';
let actionTodo: Todo | undefined;
let deletedTodo: Todo | undefined;
let busy = false;
let storageReady = false;
let deferredInstall: InstallPromptEvent | undefined;
let registration: ServiceWorkerRegistration | undefined;
let refreshing = false;
let draftDue: string | null = null;
let draftFlag = false;
// Tasks completed in this session stay visible until the view changes, so a mis-tap is easy to reverse.
const lingering = new Set<string>();
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

function reportError(message: string): void {
  $('#notice').hidden = true;
  const target = editDialog.open ? $('#edit-error') : $('#error');
  target.textContent = message;
  target.hidden = false;
  if (target === $('#error')) { clearTimeout(errorTimer); errorTimer = setTimeout(() => { target.hidden = true; }, 8000); }
}

function notify(message: string, undo = false): void {
  $('#error').hidden = true;
  $('#edit-error').hidden = true;
  $('#notice-text').textContent = message;
  $('#undo').hidden = !undo;
  $('#notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (!$('#notice').contains(document.activeElement)) $('#notice').hidden = true; }, undo ? 6000 : 3000);
}

function setBusy(value: boolean): void {
  busy = value;
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('#add-button, #export, #import, #import-file, #clear-completed, #undo, #edit-form button, #todo-list button, #todo-list input')) {
    control.disabled = value || !storageReady;
  }
  newTodo.disabled = !storageReady;
  addForm.setAttribute('aria-busy', String(value));
}

function animate(update: () => void): Promise<void> {
  if (!document.startViewTransition || reducedMotion.matches || document.hidden) { update(); return Promise.resolve(); }
  return document.startViewTransition(update).updateCallbackDone.catch(() => {});
}

function dateOf(day: string): Date { const [y = 0, m = 1, d = 1] = day.split('-').map(Number); return new Date(y, m - 1, d); }
function dayDiff(day: string): number {
  const utc = (value: string) => { const date = dateOf(value); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()); };
  return Math.round((utc(day) - utc(today)) / 864e5);
}
function shortDate(day: string): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (day.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, options).format(dateOf(day));
}
function dueLabel(day: string): string {
  const diff = dayDiff(day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(dateOf(day));
  return shortDate(day);
}
function sectionLabel(day: string): string {
  const diff = dayDiff(day);
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(dateOf(day));
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' }).format(dateOf(day));
}

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

function captureFocus(): Focus {
  const focused = document.activeElement;
  const row = focused?.closest<HTMLElement>('.todo');
  return { id: row?.dataset.id, control: focused?.getAttribute('data-control'), index: row ? [...list.querySelectorAll('.todo')].indexOf(row) : -1 };
}
function restoreFocus(focus: Focus): void {
  if (!focus.id || !focus.control || document.querySelector('dialog[open]')) return;
  const rows = [...list.querySelectorAll<HTMLElement>('.todo')];
  const row = rows.find(item => item.dataset.id === focus.id) || rows[Math.min(focus.index ?? 0, rows.length - 1)];
  (row?.querySelector<HTMLElement>(`[data-control="${focus.control}"]`) || $('[data-view][aria-pressed="true"]')).focus({ preventScroll: !row });
}

// Editor sheet: closing by swipe, backdrop or Done saves; Cancel discards.
function editorState(): string { return JSON.stringify([editText.value, editDue.value, editFlag.checked, editNotes.value]); }
function openEditor(todo: Todo): void {
  editingId = todo.id;
  $('#edit-error').hidden = true;
  $('#error').hidden = true;
  editText.value = todo.text;
  editDue.value = todo.due || '';
  editFlag.checked = Boolean(todo.flagged);
  editNotes.value = todo.notes || '';
  syncEditDates();
  editingSnapshot = editorState();
  editDialog.showModal();
  if (!coarse.matches) editText.focus();
}
function dismissEditor(): void {
  if (editorState() !== editingSnapshot) editForm.requestSubmit();
  else editDialog.close();
}

function deleteTodo(todo: Todo): void {
  void mutate(() => storage.deleteTodo(todo.id), () => { deletedTodo = todo; notify(`Deleted "${todo.text.length > 28 ? `${todo.text.slice(0, 27)}…` : todo.text}"`, true); });
}
function toggleTodo(todo: Todo, completed: boolean): void {
  if (completed) { lingering.add(todo.id); haptic(); }
  void mutate(() => storage.changeTodo(todo.id, { completed, completedAt: completed ? Date.now() : undefined }));
}
function statusOf(todo: Todo): View | 'late' {
  if (todo.completed) return 'done';
  if (todo.due && todo.due < today) return 'late';
  return viewOf(todo, today);
}

function buildRow(todo: Todo): HTMLLIElement {
  const row = element('li', `todo${todo.completed ? ' completed' : ''}${todo.flagged ? ' flagged' : ''}`);
  row.dataset.id = todo.id;
  if (todos.length <= 80) row.style.setProperty('view-transition-name', `t-${CSS.escape(todo.id)}`);
  const hint = element('div', 'swipe-hint');
  hint.setAttribute('aria-hidden', 'true');
  const hintDone = element('span', 'hint-done');
  hintDone.append(icon('check'), todo.completed ? 'Reopen' : 'Complete');
  const hintDelete = element('span', 'hint-delete');
  hintDelete.append('Delete', icon('trash'));
  hint.append(hintDone, hintDelete);

  const surface = element('div', 'row');
  const check = element('label', 'check');
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = todo.completed;
  checkbox.dataset.control = 'check';
  checkbox.setAttribute('aria-label', `${todo.completed ? 'Reopen' : 'Complete'} ${todo.text}`);
  checkbox.addEventListener('change', () => toggleTodo(todo, checkbox.checked));
  const box = element('span', 'check-box');
  box.append(icon('check'));
  check.append(checkbox, box);

  const body = element('button', 'body');
  body.type = 'button';
  body.dataset.control = 'edit';
  body.setAttribute('aria-label', `Edit ${todo.text}`);
  const meta = element('span', 'meta');
  if (todo.flagged && !todo.completed) meta.append(element('span', 'important', 'Important'));
  // Section headings already say the date in Today and Upcoming; repeat it only where it adds information.
  const searching = Boolean(searchInput.value.trim());
  if (todo.due && !todo.completed && (searching || (view !== 'upcoming' && !(view === 'today' && todo.due === today)))) {
    meta.append(element('span', todo.due < today ? 'late' : '', dueLabel(todo.due)));
  }
  if (todo.notes) meta.append(element('span', '', 'Note'));
  body.append(element('span', 'todo-text', todo.text), meta);
  body.addEventListener('click', () => { if (!gesture.suppressClick) openEditor(todo); });

  const status = element('span', 'status');
  status.setAttribute('aria-hidden', 'true');
  status.append(element('span', `ring ring-${statusOf(todo)}`));
  const remove = element('button', 'row-delete');
  remove.type = 'button';
  remove.dataset.control = 'delete';
  remove.setAttribute('aria-label', `Delete ${todo.text}`);
  remove.append(icon('trash'));
  remove.addEventListener('click', () => deleteTodo(todo));
  surface.append(check, body, status, remove);
  surface.addEventListener('pointerdown', event => rowPointerDown(event, todo, row, surface));
  surface.addEventListener('contextmenu', event => { event.preventDefault(); openActions(todo); });
  row.append(hint, surface);
  return row;
}

function render(): void {
  today = localDate();
  const focus = captureFocus();
  const query = searchInput.value;
  const searching = Boolean(query.trim());
  const counts = countViews(todos, today);
  let selected = selectTodos(todos, searching ? 'all' : view, query, today);
  if (!searching && view === 'today') {
    const rank = (todo: Todo) => todo.due && todo.due < today ? 0 : 1;
    selected = selected.map((todo, index) => ({ todo, index })).sort((a, b) => rank(a.todo) - rank(b.todo) || a.index - b.index).map(({ todo }) => todo);
    const finished = todos.filter(todo => todo.completed && (lingering.has(todo.id) || localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today))
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
    selected = selected.concat(finished);
  } else if (!searching && view !== 'done') {
    const visible = new Set(selected.map(todo => todo.id));
    selected = selected.concat(todos.filter(todo => lingering.has(todo.id) && todo.completed && !visible.has(todo.id)));
  }
  const fragment = document.createDocumentFragment();
  let group: string | undefined;
  for (const todo of selected) {
    let next: string | undefined;
    let label = '';
    if (searching) { next = NAMES[viewOf(todo, today)]; label = next; }
    else if (todo.completed && view !== 'done') { next = 'completed'; label = 'Completed'; }
    else if (view === 'upcoming' && todo.due) { next = todo.due; label = sectionLabel(todo.due); }
    else if (view === 'today' && counts.overdue) { next = todo.due && todo.due < today ? 'late' : 'today'; label = next === 'late' ? 'Overdue' : 'Today'; }
    if (next && next !== group) {
      const heading = element('li', `section ${next === 'late' ? 'late' : ''}`, label);
      heading.setAttribute('role', 'presentation');
      fragment.append(heading);
      group = next;
    }
    fragment.append(buildRow(todo));
  }
  list.replaceChildren(fragment);

  for (const name of VIEWS) $(`#count-${name}`).textContent = name === 'done' ? '' : String(counts[name] || '');
  for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) button.setAttribute('aria-pressed', String(!searching && button.dataset.view === view));
  $('#view-title').textContent = searching ? 'Search' : NAMES[view];
  const summary = $('#summary');
  summary.replaceChildren();
  if (searching) summary.textContent = `${selected.length} ${selected.length === 1 ? 'match' : 'matches'}`;
  else if (view === 'today') {
    summary.textContent = counts.today ? `${counts.today} to do` : counts.doneToday ? 'All done for today' : 'Nothing due';
    if (counts.overdue) summary.append(' · ', element('span', 'late', `${counts.overdue} overdue`));
    if (counts.today && counts.doneToday) summary.append(` · ${counts.doneToday} done`);
  } else if (view === 'upcoming') summary.textContent = counts.upcoming ? `${counts.upcoming} scheduled` : 'Nothing scheduled';
  else if (view === 'anytime') summary.textContent = counts.anytime ? `${counts.anytime} without a date` : 'No undated tasks';
  else summary.textContent = counts.doneToday ? `${counts.doneToday} finished today, ${counts.done} in total` : `${counts.done} finished`;


  const empty = selected.length === 0;
  $('#empty').hidden = !empty;
  if (empty) {
    const copy: [string, string] = searching ? ['No matches', `Nothing contains "${query.trim()}".`]
      : view === 'today' ? ['A clear day', 'Pull down or tap below to add a task.']
        : view === 'upcoming' ? ['Nothing scheduled', 'Give a task a date and it waits here.']
          : view === 'anytime' ? ['No loose ends', 'Tasks without a date land here.']
            : ['Nothing finished yet', 'Completed tasks collect here.'];
    $('#empty-title').textContent = copy[0];
    $('#empty-description').textContent = copy[1];
  }
  $('#clear-completed').hidden = counts.done === 0;
  updateBadge(counts.today);
  syncChips();
  setBusy(busy);
  if (!busy) restoreFocus(focus);
}

async function refresh(): Promise<void> { todos = await storage.listTodos(); render(); }

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
    try { todos = await storage.listTodos(); } catch { refreshFailed = true; }
    await animate(render);
    channel?.postMessage('changed');
    onSuccess?.();
    if (refreshFailed) reportError('Your change was saved, but the list could not refresh. Reload the app to see it.');
  } finally { setBusy(false); restoreFocus(focus); }
}

function setView(next: View): void {
  if (next === view && !searchInput.value) return;
  lingering.clear();
  view = next;
  draftDue = defaultDue();
  searchInput.value = '';
  $('#shell').classList.remove('searching');
  $('#workspace').scrollTop = 0;
  void animate(render);
}

// Composer
function defaultDue(): string | null { return view === 'today' ? today : view === 'upcoming' ? addDays(today, 1) : null; }
function chipDate(kind: string | undefined): string { return kind === 'today' ? today : kind === 'tomorrow' ? addDays(today, 1) : nextWeekend(today); }
function syncChips(): void {
  let preset = false;
  for (const chip of document.querySelectorAll<HTMLElement>('[data-due]')) {
    const on = draftDue === chipDate(chip.dataset.due);
    chip.setAttribute('aria-pressed', String(on));
    preset ||= on;
  }
  const custom = Boolean(draftDue) && !preset;
  $('#pick-chip').classList.toggle('selected', custom);
  $('#pick-label').textContent = custom && draftDue ? dueLabel(draftDue) : 'Date';
  newDue.value = draftDue || '';
  $('#new-flag').setAttribute('aria-pressed', String(draftFlag));
  updateComposing();
}
function updateComposing(): void {
  const form = addForm;
  const composing = form.contains(document.activeElement) || Boolean(newTodo.value) || draftFlag || draftDue !== defaultDue();
  form.classList.toggle('composing', composing);
  $('#shell').classList.toggle('composing', composing);
}
function startComposing(): void {
  newTodo.focus();
  updateComposing();
}

addForm.addEventListener('submit', event => {
  event.preventDefault();
  let text: string;
  try { text = normalizeText(newTodo.value); }
  catch (error) { reportError(errorMessage(error)); return; }
  const now = Date.now();
  const todo: Todo = { id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now };
  if (draftDue) todo.due = draftDue;
  if (draftFlag) todo.flagged = true;
  void mutate(() => storage.addTodo(todo), () => {
    newTodo.value = '';
    draftFlag = false;
    haptic();
    const landed = viewOf(todo, today);
    if (searchInput.value) { searchInput.value = ''; $('#shell').classList.remove('searching'); }
    if (landed !== view) notify(`Added to ${NAMES[landed]}${todo.due && landed === 'upcoming' ? `, ${dueLabel(todo.due)}` : ''}.`);
    render();
    if (todos.length === 1) navigator.storage?.persist?.().catch(() => {});
    setTimeout(autoUpdate);
  });
});
for (const chip of document.querySelectorAll<HTMLElement>('[data-due]')) {
  chip.addEventListener('pointerdown', event => event.preventDefault());
  chip.addEventListener('click', () => { const value = chipDate(chip.dataset.due); draftDue = draftDue === value ? null : value; syncChips(); });
}
$('#new-flag').addEventListener('pointerdown', event => event.preventDefault());
$('#new-flag').addEventListener('click', () => { draftFlag = !draftFlag; syncChips(); });
newDue.addEventListener('change', () => { draftDue = newDue.value || null; syncChips(); });
newDue.addEventListener('click', () => { try { newDue.showPicker(); } catch { /* the native control opens itself */ } });
addForm.addEventListener('focusin', updateComposing);
addForm.addEventListener('focusout', () => setTimeout(updateComposing, 120));
newTodo.addEventListener('input', updateComposing);
newTodo.addEventListener('keydown', event => { if (event.key === 'Escape') newTodo.blur(); });

// Editor sheet
function syncEditDates(): void {
  for (const chip of document.querySelectorAll<HTMLElement>('[data-edit-due]')) chip.classList.toggle('selected', editDue.value === chipDate(chip.dataset.editDue));
  $('#clear-due').hidden = !editDue.value;
}
for (const chip of document.querySelectorAll<HTMLElement>('[data-edit-due]')) chip.addEventListener('click', () => { editDue.value = chipDate(chip.dataset.editDue); syncEditDates(); });
editDue.addEventListener('change', syncEditDates);
$('#clear-due').addEventListener('click', () => { editDue.value = ''; syncEditDates(); });
editFlag.addEventListener('change', haptic);
editForm.addEventListener('submit', event => {
  event.preventDefault();
  let changes: TodoChanges;
  try { changes = { text: normalizeText(editText.value), notes: normalizeNotes(editNotes.value) || undefined, due: editDue.value || undefined, flagged: editFlag.checked || undefined }; }
  catch (error) { reportError(errorMessage(error)); return; }
  void mutate(() => storage.changeTodo(editingId, changes), () => { editDialog.close(); });
});
editText.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); editForm.requestSubmit(); }
});
$('#cancel-edit').addEventListener('click', () => editDialog.close());
$('#delete-task').addEventListener('click', () => {
  const todo = todos.find(item => item.id === editingId);
  editDialog.close();
  if (todo) deleteTodo(todo);
});
$('#share-task').addEventListener('click', () => void (async () => {
  const text = [editText.value.trim(), editNotes.value.trim()].filter(Boolean).join('\n\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); notify('Copied to clipboard.'); }
  } catch (error) { if (errorName(error) !== 'AbortError') reportError('Sharing is unavailable here.'); }
})());
editDialog.addEventListener('cancel', event => { event.preventDefault(); editDialog.close(); });

// Long-press quick actions
function openActions(todo: Todo): void {
  if (busy) return;
  actionTodo = todo;
  haptic();
  $('#actions-title').textContent = todo.text;
  $('#action-flag-label').textContent = todo.flagged ? 'Not important' : 'Important';
  $('[data-action="flag"]').classList.toggle('on', Boolean(todo.flagged));
  actionsDialog.showModal();
}
for (const button of document.querySelectorAll<HTMLElement>('[data-action]')) {
  button.addEventListener('click', () => {
    const todo = actionTodo;
    const action = button.dataset.action;
    actionsDialog.close();
    if (!todo) return;
    if (action === 'delete') deleteTodo(todo);
    else if (action === 'flag') void mutate(() => storage.changeTodo(todo.id, { flagged: todo.flagged ? undefined : true }));
    else {
      const due = chipDate(action);
      void mutate(() => storage.changeTodo(todo.id, { due, completed: false, completedAt: undefined }), () => {
        if (viewOf({ ...todo, due, completed: false }, today) !== view) notify(`Moved to ${dueLabel(due)}.`);
      });
    }
  });
}

// Every sheet: tap the backdrop or swipe down to close.
function closeSheet(dialog: HTMLDialogElement): void {
  if (dialog.id === 'edit-dialog') dismissEditor();
  else dialog.close();
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSheet(dialog); });
  dialog.addEventListener('close', () => { dialog.style.removeProperty('--drag'); dialog.classList.remove('dragging', 'settling'); });
  let start: { x: number; y: number; time: number; dy: number; active: boolean } | null = null;
  dialog.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || !coarse.matches || matchMedia('(min-width: 900px)').matches) return;
    const target = event.target as Element;
    const body = target.closest('.sheet-body');
    if (target.closest('textarea:focus, input:focus')) return;
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
      setTimeout(() => { if (dialog.open) { dialog.style.removeProperty('--drag'); } dialog.classList.remove('settling'); }, 260);
    } else {
      dialog.style.removeProperty('--drag');
      setTimeout(() => dialog.classList.remove('settling'), 260);
    }
  });
}

// Search
searchInput.addEventListener('input', () => render());
searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') $('#cancel-search').click(); });
function openSearch(): void { $('#shell').classList.add('searching'); searchInput.focus(); }
function closeSearch(): void { searchInput.value = ''; $('#shell').classList.remove('searching'); render(); }
$('#open-search').addEventListener('click', openSearch);
$('#cancel-search').addEventListener('click', closeSearch);

function isView(value: unknown): value is View { return VIEWS.includes(value as View); }
// Sliding a finger along the phone tab bar switches views and swiping up opens search;
// the click that ends either gesture is ignored.
const viewNav = $('#views');
let scrub: { start: string | undefined; y: number; moved: boolean } | null = null;
for (const button of document.querySelectorAll<HTMLElement>('[data-view]')) button.addEventListener('click', () => {
  if (!gesture.suppressClick && isView(button.dataset.view)) setView(button.dataset.view);
});
viewNav.addEventListener('pointerdown', event => {
  scrub = event.pointerType === 'mouse' ? null : { start: (event.target as Element).closest<HTMLElement>('[data-view]')?.dataset.view, y: event.clientY, moved: false };
});
viewNav.addEventListener('pointermove', event => {
  if (!scrub) return;
  // Hit-test the tab boxes directly: elementFromPoint sees the overlay while a view transition runs.
  const next = [...viewNav.querySelectorAll<HTMLElement>('[data-view]')].find(button => {
    const box = button.getBoundingClientRect();
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
  if (swipedUp) { haptic(); openSearch(); }
});
$('#undo').addEventListener('click', () => {
  const restore = deletedTodo;
  if (!restore) return;
  void mutate(() => storage.addTodo(restore), () => { deletedTodo = undefined; notify('Restored.'); });
});
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });

// Row gestures: swipe right completes, swipe left deletes, a long press opens quick actions.
interface Drag { todo: Todo; row: HTMLElement; surface: HTMLElement; id: number; x: number; y: number; dx: number; axis: 'x' | null; armed: boolean }
const gesture: { suppressClick: boolean; timer?: ReturnType<typeof setTimeout>; drag: Drag | null } = { suppressClick: false, drag: null };
function rowPointerDown(event: PointerEvent, todo: Todo, row: HTMLElement, surface: HTMLElement): void {
  if (event.pointerType === 'mouse' || busy || (event.target as Element).closest('.row-delete, .check')) return;
  if (event.clientX < 20) return;
  clearTimeout(gesture.timer);
  gesture.drag = { todo, row, surface, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null, armed: false };
  surface.classList.add('pressing');
  gesture.timer = setTimeout(() => {
    if (!gesture.drag || gesture.drag.axis) return;
    surface.classList.remove('pressing');
    gesture.drag = null;
    suppressClick();
    openActions(todo);
  }, 480);
}
function suppressClick(): void {
  gesture.suppressClick = true;
  setTimeout(() => { gesture.suppressClick = false; }, 400);
}
document.addEventListener('pointermove', event => {
  const drag = gesture.drag;
  if (!drag || event.pointerId !== drag.id) return;
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
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
  const width = drag.row.offsetWidth;
  drag.dx = Math.max(-width * 0.75, Math.min(width * 0.75, dx));
  drag.surface.style.transform = `translateX(${drag.dx}px)`;
  drag.row.dataset.swipe = drag.dx > 0 ? 'right' : 'left';
  const armed = Math.abs(drag.dx) > width * 0.3;
  if (armed !== drag.armed) { drag.armed = armed; if (armed) haptic(); }
});
function rowPointerEnd(event: PointerEvent): void {
  const drag = gesture.drag;
  if (!drag || event.pointerId !== drag.id) return;
  clearTimeout(gesture.timer);
  drag.surface.classList.remove('pressing');
  const { row, surface, todo, armed, dx, axis } = drag;
  gesture.drag = null;
  if (axis !== 'x') return;
  suppressClick();
  surface.classList.remove('dragging');
  if (armed && event.type === 'pointerup') {
    if (dx > 0) { surface.style.transform = ''; toggleTodo(todo, !todo.completed); }
    else { surface.style.transform = 'translateX(-110%)'; setTimeout(() => deleteTodo(todo), 160); }
  } else {
    surface.style.transform = '';
    surface.addEventListener('transitionend', () => { delete row.dataset.swipe; }, { once: true });
  }
}
document.addEventListener('pointerup', rowPointerEnd);
document.addEventListener('pointercancel', rowPointerEnd);

// Pull the list down to add a task.
{
  const list = $('#workspace');
  const pull = $('#pull');
  const threshold = 72;
  let start: { x: number; y: number; distance: number; active: boolean } | null = null;
  list.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    if (!touch || event.touches.length !== 1 || list.scrollTop > 0 || busy || !storageReady) { start = null; return; }
    start = { y: touch.clientY, x: touch.clientX, distance: 0, active: false };
  }, { passive: true });
  list.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dy = touch.clientY - start.y;
    const dx = touch.clientX - start.x;
    if (!start.active) {
      if (dy > 6 && dy > Math.abs(dx) * 1.2 && list.scrollTop <= 0) start.active = true;
      else if (Math.abs(dx) > 6 || dy < -6) { start = null; return; }
      else return;
    }
    event.preventDefault();
    start.distance = Math.max(0, dy * 0.55);
    list.style.setProperty('--pull', `${Math.min(start.distance, 120)}px`);
    list.style.setProperty('--pull-opacity', String(Math.min(1, start.distance / 40)));
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
    list.classList.add('releasing');
    list.style.setProperty('--pull', '0px');
    list.style.setProperty('--pull-opacity', '0');
    pull.classList.remove('armed');
    $('#pull-label').textContent = 'Pull to add a task';
    setTimeout(() => list.classList.remove('releasing'), 240);
    if (armed) startComposing();
  };
  list.addEventListener('touchend', finish);
  list.addEventListener('touchcancel', finish);
}

// Swipe left or right outside the task cards and controls to move between views.
{
  const shell = $('#shell');
  let start: { x: number; y: number } | null = null;
  shell.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    const outside = !(event.target as Element).closest('.todo, #views, .composer, .search-field, button, input, textarea');
    start = touch && event.touches.length === 1 && outside && !shell.classList.contains('searching') ? { x: touch.clientX, y: touch.clientY } : null;
  }, { passive: true });
  shell.addEventListener('touchend', event => {
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    start = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const next = VIEWS[VIEWS.indexOf(view) + (dx < 0 ? 1 : -1)];
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
    if (startY !== null && touch && touch.clientY - startY > 30 && $('#shell').classList.contains('searching')) { startY = null; searchInput.blur(); closeSearch(); }
  }, { passive: true });
}

// Swipe down on the composer to put the keyboard away; the draft stays.
{
  const form = addForm;
  let startY: number | null = null;
  form.addEventListener('touchstart', event => { startY = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null; }, { passive: true });
  form.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    const focused = document.activeElement;
    if (startY !== null && touch && touch.clientY - startY > 30 && focused instanceof HTMLElement && form.contains(focused)) { focused.blur(); startY = null; }
  }, { passive: true });
}

// Settings
$('#open-settings').addEventListener('click', () => settingsDialog.showModal());
$('#close-settings').addEventListener('click', () => settingsDialog.close());
$('#clear-completed').addEventListener('click', () => {
  if (confirm('Permanently delete all completed tasks?')) void mutate(storage.clearCompleted, () => notify('Completed tasks cleared.'));
});
$('#export').addEventListener('click', () => void (async () => {
  try {
    const saved = await storage.listTodos();
    const name = `tuck-${localDate()}.json`;
    const file = new File([JSON.stringify({ version: 1, todos: saved }, null, 2)], name, { type: 'application/json' });
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
    await mutate(() => storage.importTodos(imported), () => notify('Backup merged. Newer changes on this device were kept.'));
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
setInterval(() => { if (storageReady && localDate() !== today) { if (draftDue === today) draftDue = localDate(); render(); } }, 60000);

// Keyboard shortcuts for desktop
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey || document.querySelector('dialog[open]')) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select')) return;
  if (event.key === 'n' || event.key === 'N') { event.preventDefault(); startComposing(); }
  else if (event.key === '/') { event.preventDefault(); openSearch(); }
  else if (/^[1-4]$/.test(event.key)) { const next = VIEWS[Number(event.key) - 1]; if (next) setView(next); }
});

function connectionChanged(): void { $('#rail-status').textContent = navigator.onLine ? 'Saved on this device' : 'Offline, still saving'; }
window.addEventListener('online', connectionChanged);
window.addEventListener('offline', connectionChanged);
connectionChanged();
$('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

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
new ResizeObserver(() => document.documentElement.style.setProperty('--composer-height', `${addForm.offsetHeight}px`)).observe(addForm);

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
function hasDraft(): boolean { return Boolean(newTodo.value.trim()) || Boolean(document.querySelector('dialog[open]')); }
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
  todos = await storage.listTodos();
  storageReady = true;
  const counts = countViews(todos, today);
  if (!counts.today && !counts.doneToday && counts.anytime) view = 'anytime';
  else if (!counts.today && !counts.doneToday && counts.upcoming) view = 'upcoming';
  draftDue = defaultDue();
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
