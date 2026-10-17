import { normalizeText, normalizeNotes, parseBackup, selectTodos, countViews, viewOf, localDate, addDays, nextWeekend } from './model.js';
import * as storage from './storage.js';

const $ = selector => document.querySelector(selector);
const NAMES = { today: 'Today', upcoming: 'Upcoming', anytime: 'Anytime', done: 'Done' };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarse = matchMedia('(pointer: coarse)');
let todos = [];
let view = 'today';
let today = localDate();
let editingId;
let editingSnapshot = '';
let actionTodo;
let deletedTodo;
let busy = false;
let storageReady = false;
let deferredInstall;
let registration;
let refreshing = false;
let draftDue = null;
let draftFlag = false;
// Tasks completed in this session stay visible until the view changes, so a mis-tap is easy to reverse.
const lingering = new Set();
// Keep the original channel so existing installations see changes from Tuck.
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('randomcodespace-todos') : null;
const supportsSwitch = 'switch' in HTMLInputElement.prototype;
if (!supportsSwitch) document.documentElement.classList.add('no-switch');

// iOS 18 Safari plays a system haptic when a switch control toggles; there is no other web haptics API on iPhone.
function haptic() {
  if (supportsSwitch && coarse.matches) $('.haptic').click();
}

function reportError(message) {
  $('#notice').hidden = true;
  const target = $('#edit-dialog').open ? $('#edit-error') : $('#error');
  target.textContent = message;
  target.hidden = false;
  if (target === $('#error')) { clearTimeout(reportError.timer); reportError.timer = setTimeout(() => { target.hidden = true; }, 8000); }
}

function notify(message, undo = false) {
  $('#error').hidden = true;
  $('#edit-error').hidden = true;
  $('#notice-text').textContent = message;
  $('#undo').hidden = !undo;
  $('#notice').hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { if (!$('#notice').contains(document.activeElement)) $('#notice').hidden = true; }, undo ? 6000 : 3000);
}

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('#add-button, #export, #import, #import-file, #clear-completed, #undo, #edit-form button, #todo-list button, #todo-list input')) {
    control.disabled = value || !storageReady;
  }
  $('#new-todo').disabled = !storageReady;
  $('#add-form').setAttribute('aria-busy', String(value));
}

function animate(update) {
  if (!document.startViewTransition || reducedMotion.matches || document.hidden) { update(); return Promise.resolve(); }
  return document.startViewTransition(update).updateCallbackDone.catch(() => {});
}

function dayDiff(day) {
  const [a, b] = [day, today].map(value => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d); });
  return Math.round((a - b) / 864e5);
}
function dateOf(day) { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d); }
function shortDate(day) {
  const options = { month: 'short', day: 'numeric' };
  if (day.slice(0, 4) !== today.slice(0, 4)) options.year = 'numeric';
  return new Intl.DateTimeFormat(undefined, options).format(dateOf(day));
}
function dueLabel(day) {
  const diff = dayDiff(day);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(dateOf(day));
  return shortDate(day);
}
function sectionLabel(day) {
  const diff = dayDiff(day);
  if (diff === 1) return 'Tomorrow';
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(dateOf(day));
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: day.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' }).format(dateOf(day));
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function captureFocus() {
  const focused = document.activeElement;
  const row = focused?.closest('.todo');
  return { id: row?.dataset.id, control: focused?.getAttribute('data-control'), index: row ? [...$('#todo-list').querySelectorAll('.todo')].indexOf(row) : -1 };
}
function restoreFocus(focus) {
  if (!focus?.id || !focus.control || document.querySelector('dialog[open]')) return;
  const rows = [...$('#todo-list').querySelectorAll('.todo')];
  const row = rows.find(item => item.dataset.id === focus.id) || rows[Math.min(focus.index, rows.length - 1)];
  (row?.querySelector(`[data-control="${focus.control}"]`) || $('[data-view][aria-pressed="true"]')).focus({ preventScroll: !row });
}

// Editor sheet: closing by swipe, backdrop or Done saves; Cancel discards.
function editorState() { return JSON.stringify([$('#edit-text').value, $('#edit-due').value, $('#edit-flag').checked, $('#edit-notes').value]); }
function openEditor(todo) {
  editingId = todo.id;
  $('#edit-error').hidden = true;
  $('#error').hidden = true;
  $('#edit-text').value = todo.text;
  $('#edit-due').value = todo.due || '';
  $('#edit-flag').checked = Boolean(todo.flagged);
  $('#edit-notes').value = todo.notes || '';
  syncEditDates();
  editingSnapshot = editorState();
  $('#edit-dialog').showModal();
  if (!coarse.matches) $('#edit-text').focus();
}
function dismissEditor() {
  if (editorState() !== editingSnapshot) $('#edit-form').requestSubmit();
  else $('#edit-dialog').close();
}

function deleteTodo(todo) {
  mutate(() => storage.deleteTodo(todo.id), () => { deletedTodo = todo; notify(`Deleted "${todo.text.length > 28 ? `${todo.text.slice(0, 27)}…` : todo.text}"`, true); });
}
function toggleTodo(todo, completed) {
  if (completed) { lingering.add(todo.id); haptic(); }
  mutate(() => storage.changeTodo(todo.id, { completed, completedAt: completed ? Date.now() : undefined }));
}
function statusOf(todo) {
  if (todo.completed) return 'done';
  if (todo.due && todo.due < today) return 'late';
  return viewOf(todo, today);
}

function buildRow(todo) {
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
  const searching = Boolean($('#search').value.trim());
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

function render() {
  today = localDate();
  const focus = captureFocus();
  const query = $('#search').value;
  const searching = Boolean(query.trim());
  const counts = countViews(todos, today);
  let selected = selectTodos(todos, searching ? 'all' : view, query, today);
  if (!searching && view === 'today') {
    const rank = todo => todo.due < today ? 0 : 1;
    selected = selected.map((todo, index) => [todo, index]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([todo]) => todo);
    const finished = todos.filter(todo => todo.completed && (lingering.has(todo.id) || localDate(new Date(todo.completedAt ?? todo.updatedAt)) === today))
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt));
    selected = selected.concat(finished);
  } else if (!searching && view !== 'done') {
    const visible = new Set(selected.map(todo => todo.id));
    selected = selected.concat(todos.filter(todo => lingering.has(todo.id) && todo.completed && !visible.has(todo.id)));
  }
  const fragment = document.createDocumentFragment();
  let group;
  for (const todo of selected) {
    let next;
    let label;
    if (searching) { next = NAMES[viewOf(todo, today)]; label = next; }
    else if (todo.completed && view !== 'done') { next = 'completed'; label = 'Completed'; }
    else if (view === 'upcoming') { next = todo.due; label = sectionLabel(todo.due); }
    else if (view === 'today' && counts.overdue) { next = todo.due < today ? 'late' : 'today'; label = next === 'late' ? 'Overdue' : 'Today'; }
    if (next && next !== group) {
      const heading = element('li', `section ${next === 'late' ? 'late' : ''}`, label);
      heading.setAttribute('role', 'presentation');
      fragment.append(heading);
      group = next;
    }
    fragment.append(buildRow(todo));
  }
  $('#todo-list').replaceChildren(fragment);

  for (const name of Object.keys(NAMES)) $(`#count-${name}`).textContent = name === 'done' ? '' : counts[name] || '';
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(!searching && button.dataset.view === view));
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
    const copy = searching ? ['No matches', `Nothing contains "${query.trim()}".`]
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

async function refresh() { todos = await storage.listTodos(); render(); }

async function mutate(operation, onSuccess) {
  if (busy || !storageReady) return;
  const focus = $('#edit-dialog').open ? { id: editingId, control: 'edit' } : captureFocus();
  setBusy(true);
  $('#error').hidden = true;
  $('#edit-error').hidden = true;
  try {
    await operation();
  } catch (error) {
    render();
    reportError(error.name === 'NotFoundError' ? error.message : 'Your change could not be saved. Check available storage and try again. Your draft is still here.');
    setBusy(false);
    restoreFocus(focus);
    if ($('#edit-dialog').open) $('#edit-text').focus();
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

function setView(next) {
  if (next === view && !$('#search').value) return;
  lingering.clear();
  view = next;
  draftDue = defaultDue();
  $('#search').value = '';
  $('#shell').classList.remove('searching');
  $('#workspace').scrollTop = 0;
  animate(render);
}

// Composer
function defaultDue() { return view === 'today' ? today : view === 'upcoming' ? addDays(today, 1) : null; }
function chipDate(kind) { return kind === 'today' ? today : kind === 'tomorrow' ? addDays(today, 1) : nextWeekend(today); }
function syncChips() {
  let preset = false;
  for (const chip of document.querySelectorAll('[data-due]')) {
    const on = draftDue === chipDate(chip.dataset.due);
    chip.setAttribute('aria-pressed', String(on));
    preset ||= on;
  }
  const custom = Boolean(draftDue) && !preset;
  $('#pick-chip').classList.toggle('selected', custom);
  $('#pick-label').textContent = custom ? dueLabel(draftDue) : 'Date';
  $('#new-due').value = draftDue || '';
  $('#new-flag').setAttribute('aria-pressed', String(draftFlag));
  updateComposing();
}
function updateComposing() {
  const form = $('#add-form');
  const composing = form.contains(document.activeElement) || Boolean($('#new-todo').value) || draftFlag || draftDue !== defaultDue();
  form.classList.toggle('composing', composing);
  $('#shell').classList.toggle('composing', composing);
}
function startComposing() {
  $('#new-todo').focus();
  updateComposing();
}

$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  let text;
  try { text = normalizeText($('#new-todo').value); }
  catch (error) { reportError(error.message); return; }
  const now = Date.now();
  const todo = { id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now };
  if (draftDue) todo.due = draftDue;
  if (draftFlag) todo.flagged = true;
  mutate(() => storage.addTodo(todo), () => {
    $('#new-todo').value = '';
    draftFlag = false;
    haptic();
    const landed = viewOf(todo, today);
    if ($('#search').value) { $('#search').value = ''; $('#shell').classList.remove('searching'); }
    if (landed !== view) notify(`Added to ${NAMES[landed]}${todo.due && landed === 'upcoming' ? `, ${dueLabel(todo.due)}` : ''}.`);
    render();
    if (todos.length === 1) navigator.storage?.persist?.().catch(() => {});
    setTimeout(autoUpdate);
  });
});
for (const chip of document.querySelectorAll('[data-due]')) {
  chip.addEventListener('pointerdown', event => event.preventDefault());
  chip.addEventListener('click', () => { const value = chipDate(chip.dataset.due); draftDue = draftDue === value ? null : value; syncChips(); });
}
$('#new-flag').addEventListener('pointerdown', event => event.preventDefault());
$('#new-flag').addEventListener('click', () => { draftFlag = !draftFlag; syncChips(); });
$('#new-due').addEventListener('change', () => { draftDue = $('#new-due').value || null; syncChips(); });
$('#new-due').addEventListener('click', () => { try { $('#new-due').showPicker(); } catch { /* the native control opens itself */ } });
$('#add-form').addEventListener('focusin', updateComposing);
$('#add-form').addEventListener('focusout', () => setTimeout(updateComposing, 120));
$('#new-todo').addEventListener('input', updateComposing);
$('#new-todo').addEventListener('keydown', event => { if (event.key === 'Escape') $('#new-todo').blur(); });

// Editor sheet
function syncEditDates() {
  for (const chip of document.querySelectorAll('[data-edit-due]')) chip.classList.toggle('selected', $('#edit-due').value === chipDate(chip.dataset.editDue));
  $('#clear-due').hidden = !$('#edit-due').value;
}
for (const chip of document.querySelectorAll('[data-edit-due]')) chip.addEventListener('click', () => { $('#edit-due').value = chipDate(chip.dataset.editDue); syncEditDates(); });
$('#edit-due').addEventListener('change', syncEditDates);
$('#clear-due').addEventListener('click', () => { $('#edit-due').value = ''; syncEditDates(); });
$('#edit-flag').addEventListener('change', haptic);
$('#edit-form').addEventListener('submit', event => {
  event.preventDefault();
  let changes;
  try { changes = { text: normalizeText($('#edit-text').value), notes: normalizeNotes($('#edit-notes').value) || undefined, due: $('#edit-due').value || undefined, flagged: $('#edit-flag').checked || undefined }; }
  catch (error) { reportError(error.message); return; }
  mutate(() => storage.changeTodo(editingId, changes), () => { $('#edit-dialog').close(); });
});
$('#edit-text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#edit-form').requestSubmit(); }
});
$('#cancel-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#delete-task').addEventListener('click', () => {
  const todo = todos.find(item => item.id === editingId);
  $('#edit-dialog').close();
  if (todo) deleteTodo(todo);
});
$('#share-task').addEventListener('click', async () => {
  const text = [$('#edit-text').value.trim(), $('#edit-notes').value.trim()].filter(Boolean).join('\n\n');
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); notify('Copied to clipboard.'); }
  } catch (error) { if (error.name !== 'AbortError') reportError('Sharing is unavailable here.'); }
});
$('#edit-dialog').addEventListener('cancel', event => { event.preventDefault(); $('#edit-dialog').close(); });

// Long-press quick actions
function openActions(todo) {
  if (busy) return;
  actionTodo = todo;
  haptic();
  $('#actions-title').textContent = todo.text;
  $('#action-flag-label').textContent = todo.flagged ? 'Not important' : 'Important';
  $('[data-action="flag"]').classList.toggle('on', Boolean(todo.flagged));
  $('#actions-dialog').showModal();
}
for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    const todo = actionTodo;
    const action = button.dataset.action;
    $('#actions-dialog').close();
    if (!todo) return;
    if (action === 'delete') deleteTodo(todo);
    else if (action === 'flag') mutate(() => storage.changeTodo(todo.id, { flagged: todo.flagged ? undefined : true }));
    else {
      const due = chipDate(action);
      mutate(() => storage.changeTodo(todo.id, { due, completed: false, completedAt: undefined }), () => {
        if (viewOf({ ...todo, due, completed: false }, today) !== view) notify(`Moved to ${dueLabel(due)}.`);
      });
    }
  });
}

// Every sheet: tap the backdrop or swipe down to close.
function closeSheet(dialog) {
  if (dialog.id === 'edit-dialog') dismissEditor();
  else dialog.close();
}
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => { if (event.target === dialog) closeSheet(dialog); });
  dialog.addEventListener('close', () => { dialog.style.removeProperty('--drag'); dialog.classList.remove('dragging', 'settling'); });
  let start = null;
  dialog.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || !coarse.matches || matchMedia('(min-width: 900px)').matches) return;
    const body = event.target.closest('.sheet-body');
    if (event.target.closest('textarea:focus, input:focus')) return;
    if (body && body.scrollTop > 0) return;
    start = { y: event.touches[0].clientY, x: event.touches[0].clientX, time: Date.now(), dy: 0, active: false };
  }, { passive: true });
  dialog.addEventListener('touchmove', event => {
    if (!start) return;
    const dy = event.touches[0].clientY - start.y;
    const dx = event.touches[0].clientX - start.x;
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
$('#search').addEventListener('input', () => render());
$('#search').addEventListener('keydown', event => { if (event.key === 'Escape') $('#cancel-search').click(); });
$('#open-search').addEventListener('click', () => { $('#shell').classList.add('searching'); $('#search').focus(); });
$('#cancel-search').addEventListener('click', () => { $('#search').value = ''; $('#shell').classList.remove('searching'); render(); });

for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('#undo').addEventListener('click', () => {
  if (!deletedTodo) return;
  mutate(() => storage.addTodo(deletedTodo), () => { deletedTodo = undefined; notify('Restored.'); });
});
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });

// Row gestures: swipe right completes, swipe left deletes, a long press opens quick actions.
const gesture = { suppressClick: false };
function rowPointerDown(event, todo, row, surface) {
  if (event.pointerType === 'mouse' || busy || event.target.closest('.row-delete, .check')) return;
  if (event.clientX < 20) return;
  clearTimeout(gesture.timer);
  Object.assign(gesture, { todo, row, surface, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, axis: null, armed: false });
  surface.classList.add('pressing');
  gesture.timer = setTimeout(() => {
    if (!gesture.row || gesture.axis) return;
    surface.classList.remove('pressing');
    gesture.row = null;
    suppressClick();
    openActions(todo);
  }, 480);
}
function suppressClick() {
  gesture.suppressClick = true;
  setTimeout(() => { gesture.suppressClick = false; }, 400);
}
document.addEventListener('pointermove', event => {
  if (!gesture.row || event.pointerId !== gesture.id) return;
  const dx = event.clientX - gesture.x;
  const dy = event.clientY - gesture.y;
  if (!gesture.axis) {
    if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      gesture.axis = 'x';
      clearTimeout(gesture.timer);
      gesture.surface.classList.remove('pressing');
      gesture.surface.classList.add('dragging');
      try { gesture.surface.setPointerCapture(event.pointerId); } catch { /* capture is best effort */ }
    } else if (Math.abs(dy) > 10 || Math.abs(dx) > 10) {
      clearTimeout(gesture.timer);
      gesture.surface.classList.remove('pressing');
      gesture.row = null;
      return;
    } else return;
  }
  const width = gesture.row.offsetWidth;
  gesture.dx = Math.max(-width * 0.75, Math.min(width * 0.75, dx));
  gesture.surface.style.transform = `translateX(${gesture.dx}px)`;
  gesture.row.dataset.swipe = gesture.dx > 0 ? 'right' : 'left';
  const armed = Math.abs(gesture.dx) > width * 0.3;
  if (armed !== gesture.armed) { gesture.armed = armed; if (armed) haptic(); }
});
function rowPointerEnd(event) {
  if (event.pointerId !== gesture.id) return;
  clearTimeout(gesture.timer);
  gesture.surface?.classList.remove('pressing');
  if (!gesture.row) return;
  const { row, surface, todo, armed, dx, axis } = gesture;
  gesture.row = null;
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
  let start = null;
  list.addEventListener('touchstart', event => {
    if (event.touches.length !== 1 || list.scrollTop > 0 || busy || !storageReady) { start = null; return; }
    start = { y: event.touches[0].clientY, x: event.touches[0].clientX, distance: 0, active: false };
  }, { passive: true });
  list.addEventListener('touchmove', event => {
    if (!start) return;
    const dy = event.touches[0].clientY - start.y;
    const dx = event.touches[0].clientX - start.x;
    if (!start.active) {
      if (dy > 6 && dy > Math.abs(dx) * 1.2 && list.scrollTop <= 0) start.active = true;
      else if (Math.abs(dx) > 6 || dy < -6) { start = null; return; }
      else return;
    }
    event.preventDefault();
    start.distance = Math.max(0, dy * 0.55);
    list.style.setProperty('--pull', `${Math.min(start.distance, 120)}px`);
    list.style.setProperty('--pull-opacity', Math.min(1, start.distance / 40));
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
    list.style.setProperty('--pull-opacity', 0);
    pull.classList.remove('armed');
    $('#pull-label').textContent = 'Pull to add a task';
    setTimeout(() => list.classList.remove('releasing'), 240);
    if (armed) startComposing();
  };
  list.addEventListener('touchend', finish);
  list.addEventListener('touchcancel', finish);
}

// Swipe down on the composer to put the keyboard away; the draft stays.
{
  const form = $('#add-form');
  let startY = null;
  form.addEventListener('touchstart', event => { startY = event.touches.length === 1 ? event.touches[0].clientY : null; }, { passive: true });
  form.addEventListener('touchmove', event => {
    if (startY !== null && event.touches[0].clientY - startY > 30 && form.contains(document.activeElement)) { document.activeElement.blur(); startY = null; }
  }, { passive: true });
}

// Settings
$('#open-settings').addEventListener('click', () => $('#settings-dialog').showModal());
$('#close-settings').addEventListener('click', () => $('#settings-dialog').close());
$('#clear-completed').addEventListener('click', () => {
  if (confirm('Permanently delete all completed tasks?')) mutate(storage.clearCompleted, () => notify('Completed tasks cleared.'));
});
$('#export').addEventListener('click', async () => {
  try {
    const saved = await storage.listTodos();
    const name = `tuck-${localDate()}.json`;
    const file = new File([JSON.stringify({ version: 1, todos: saved }, null, 2)], name, { type: 'application/json' });
    if (coarse.matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Tuck backup' }); return; }
      catch (error) { if (error.name === 'AbortError') return; }
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
});
$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Choose a backup smaller than 10 MB.');
    const imported = parseBackup(await file.text());
    $('#settings-dialog').close();
    await mutate(() => storage.importTodos(imported), () => notify('Backup merged. Newer changes on this device were kept.'));
  } catch (error) { $('#settings-dialog').close(); reportError(`Import failed. ${error.message}`); }
  finally { event.target.value = ''; }
});

// App icon badge (home-screen apps on iOS 16.4+ after notification permission)
const badgeKey = 'tuck:badge';
function badgeEnabled() { try { return localStorage.getItem(badgeKey) === '1'; } catch { return false; } }
function updateBadge(count) {
  if (!('setAppBadge' in navigator) || !badgeEnabled()) return;
  (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
}
if ('setAppBadge' in navigator) {
  $('#badge-row').hidden = false;
  $('#badge-toggle').checked = badgeEnabled();
  $('#badge-toggle').addEventListener('change', async () => {
    const toggle = $('#badge-toggle');
    if (toggle.checked && 'Notification' in window && Notification.permission === 'default') {
      if (await Notification.requestPermission() !== 'granted') toggle.checked = false;
    }
    try { localStorage.setItem(badgeKey, toggle.checked ? '1' : '0'); } catch { /* private mode */ }
    if (toggle.checked) updateBadge(countViews(todos, today).today);
    else navigator.clearAppBadge().catch(() => {});
  });
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
  if (event.target.closest?.('input, textarea, select')) return;
  if (event.key === 'n' || event.key === 'N') { event.preventDefault(); startComposing(); }
  else if (event.key === '/') { event.preventDefault(); $('#open-search').click(); $('#search').focus(); }
  else if (/^[1-4]$/.test(event.key)) setView(Object.keys(NAMES)[Number(event.key) - 1]);
});

function connectionChanged() { $('#rail-status').textContent = navigator.onLine ? 'Saved on this device' : 'Offline, still saving'; }
window.addEventListener('online', connectionChanged);
window.addEventListener('offline', connectionChanged);
connectionChanged();
$('#today-label').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

// Track the visual viewport so the composer rides above the iOS keyboard.
function fitViewport() {
  if (!window.visualViewport || window.visualViewport.scale > 1.01) return;
  const root = document.documentElement.style;
  root.setProperty('--app-height', `${window.visualViewport.height}px`);
  root.setProperty('--app-top', `${window.visualViewport.offsetTop}px`);
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
fitViewport();
new ResizeObserver(() => document.documentElement.style.setProperty('--composer-height', `${$('#add-form').offsetHeight}px`)).observe($('#add-form'));

// Older WebKit ports need an edge-only fallback. Modern Safari scrolls natively.
if (!CSS.supports('overscroll-behavior', 'none')) {
  let touchY = 0;
  document.addEventListener('touchstart', event => {
    if (event.touches.length === 1) touchY = event.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    if (event.touches.length !== 1) return;
    const delta = event.touches[0].clientY - touchY;
    touchY = event.touches[0].clientY;
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

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; });
window.addEventListener('appinstalled', () => { deferredInstall = undefined; $('#install').hidden = true; });
$('#install').hidden = standalone;
$('#install').addEventListener('click', async () => {
  if (deferredInstall) { await deferredInstall.prompt(); deferredInstall = undefined; }
  else $('#install-help').hidden = !$('#install-help').hidden;
});

$('#persist').addEventListener('click', async () => {
  try {
    const granted = await navigator.storage.persist();
    $('#persistence-status').textContent = granted ? 'Storage is protected. Keep a backup too.' : 'Your browser manages storage automatically. Keep a backup.';
    $('#persist').hidden = granted;
  } catch { $('#persistence-status').textContent = 'Storage protection is unavailable. Keep a backup.'; }
});

// Updates apply themselves as soon as nothing unsaved would be lost by the reload.
// A real update is a different, fully installed worker waiting behind the active one. During a first install
// WebKit can briefly report the activating worker as waiting, which must not trigger a reload.
function hasDraft() { return Boolean($('#new-todo').value.trim()) || Boolean(document.querySelector('dialog[open]')); }
function updateWaiting() {
  const waiting = registration?.waiting;
  return Boolean(waiting && waiting.state === 'installed' && registration.active && registration.active !== waiting && navigator.serviceWorker.controller);
}
function applyUpdate() {
  if (!updateWaiting() || refreshing) return;
  refreshing = true;
  try { sessionStorage.setItem('tuck:updated', '1'); } catch { /* the toast is optional */ }
  registration.waiting.postMessage('ACTIVATE_UPDATE');
}
function autoUpdate() { if (updateWaiting() && !busy && !hasDraft()) applyUpdate(); }
function checkForUpdate() { registration?.update().catch(() => {}); }

async function startOffline() {
  if (!('serviceWorker' in navigator)) { $('#offline-status').textContent = 'Unavailable'; return; }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) location.reload(); });
    const updateReady = () => { $('#update-app').hidden = !updateWaiting(); autoUpdate(); };
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
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
$('#new-todo').addEventListener('input', autoUpdate);
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
  if (navigator.storage?.persist) {
    const persistent = await navigator.storage.persisted();
    $('#persist').hidden = persistent;
    if (persistent) $('#persistence-status').textContent = 'Storage is protected. Keep a backup too.';
  }
} catch { reportError('Storage is unavailable. Allow site storage in your browser, then reload.'); }
startOffline();
