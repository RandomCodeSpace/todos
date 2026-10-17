import { normalizeText, parseBackup, selectTodos } from './model.js';
import * as storage from './storage.js';

const $ = selector => document.querySelector(selector);
let todos = [];
let filter = 'all';
let editingId;
let deletedTodo;
let busy = false;
let storageReady = false;
let deferredInstall;
let registration;
let refreshing = false;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('randomcodespace-todos') : null;

function reportError(message) {
  $('#notice').hidden = true;
  $('#error').textContent = message;
  $('#error').hidden = false;
}

function notify(message, undo = false) {
  $('#error').hidden = true;
  $('#notice-text').textContent = message;
  $('#undo').hidden = !undo;
  $('#notice').hidden = false;
}

function setBusy(value) {
  busy = value;
  for (const control of document.querySelectorAll('#add-button, #new-todo, #export, #import, #import-file, #clear-completed, #undo, #edit-form button, #todo-list button, #todo-list input')) {
    control.disabled = value || !storageReady;
  }
  $('#add-form').setAttribute('aria-busy', String(value));
}

function iconButton(label, path, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.append(svg);
  button.addEventListener('click', action);
  return button;
}

function render() {
  const focused = document.activeElement;
  const focusId = focused?.closest('.todo')?.dataset.id;
  const focusLabel = focused?.getAttribute('data-control');
  const selected = selectTodos(todos, filter, $('#search').value);
  const fragment = document.createDocumentFragment();
  for (const todo of selected) {
    const row = document.createElement('li');
    row.className = `todo${todo.completed ? ' completed' : ''}`;
    row.dataset.id = todo.id;
    const label = document.createElement('label');
    label.className = 'check-label';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = todo.completed;
    checkbox.dataset.control = 'check';
    checkbox.setAttribute('aria-label', `${todo.completed ? 'Reopen' : 'Complete'} ${todo.text}`);
    checkbox.addEventListener('change', () => mutate(() => storage.changeTodo(todo.id, { completed: checkbox.checked })));
    label.append(checkbox);
    const text = document.createElement('p');
    text.className = 'todo-text';
    text.textContent = todo.text;
    const actions = document.createElement('div');
    actions.className = 'todo-actions';
    const edit = iconButton(`Edit ${todo.text}`, 'm14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14z', () => {
      editingId = todo.id;
      $('#edit-text').value = todo.text;
      $('#edit-dialog').showModal();
      $('#edit-text').focus();
    });
    edit.dataset.control = 'edit';
    const remove = iconButton(`Delete ${todo.text}`, 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5', () => mutate(
      () => storage.deleteTodo(todo.id),
      () => { deletedTodo = todo; notify('Todo deleted.', true); }
    ));
    remove.dataset.control = 'delete';
    actions.append(edit, remove);
    row.append(label, text, actions);
    fragment.append(row);
  }
  $('#todo-list').replaceChildren(fragment);
  const completed = todos.filter(todo => todo.completed).length;
  const active = todos.length - completed;
  $('#all-count').textContent = todos.length;
  $('#active-count').textContent = active;
  $('#done-count').textContent = completed;
  $('#remaining').textContent = todos.length ? `${active} ${active === 1 ? 'thing' : 'things'} left. One at a time.` : 'No rush. Start wherever you like.';
  $('#clear-completed').hidden = completed === 0;
  $('#empty').hidden = selected.length > 0;
  const searching = Boolean($('#search').value.trim());
  $('#empty-title').textContent = searching ? 'No matching todos' : filter === 'completed' ? 'Good things take a little time' : todos.length ? 'A little breathing room' : 'Start with one small thing';
  $('#empty-description').textContent = searching ? 'Try another word or clear your search.' : filter === 'completed' ? 'Your completed todos will be here.' : todos.length ? 'Everything here is taken care of.' : 'A plan, an idea, something for later. Your list is ready when you are.';
  for (const button of document.querySelectorAll('[data-filter]')) button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  setBusy(busy);
  if (focusId && focusLabel) {
    const row = [...$('#todo-list').children].find(item => item.dataset.id === focusId);
    (row?.querySelector(`[data-control="${focusLabel}"]`) || $('[data-filter][aria-pressed="true"]')).focus({ preventScroll: true });
  }
}

async function refresh() { todos = await storage.listTodos(); render(); }

async function mutate(operation, onSuccess) {
  if (busy || !storageReady) return;
  setBusy(true);
  $('#error').hidden = true;
  try {
    await operation();
    await refresh();
    channel?.postMessage('changed');
    onSuccess?.();
  } catch {
    render();
    reportError('Your change could not be saved. Check available storage and try again. Your draft is still here.');
  } finally { setBusy(false); }
}

$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  let text;
  try { text = normalizeText($('#new-todo').value); }
  catch (error) { reportError(error.message); return; }
  const now = Date.now();
  mutate(() => storage.addTodo({ id: crypto.randomUUID(), text, completed: false, createdAt: now, updatedAt: now }), () => {
    $('#new-todo').value = '';
    filter = 'all';
    $('#search').value = '';
    render();
    notify('Todo saved on this device.');
  });
});
$('#new-todo').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); $('#add-form').requestSubmit(); }
});
$('#edit-form').addEventListener('submit', event => {
  event.preventDefault();
  let text;
  try { text = normalizeText($('#edit-text').value); }
  catch (error) { reportError(error.message); return; }
  mutate(() => storage.changeTodo(editingId, { text }), () => { $('#edit-dialog').close(); notify('Changes saved.'); });
});
$('#cancel-edit').addEventListener('click', () => $('#edit-dialog').close());
$('#search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => { filter = button.dataset.filter; render(); });
$('#undo').addEventListener('click', () => {
  if (!deletedTodo) return;
  mutate(() => storage.addTodo(deletedTodo), () => { deletedTodo = undefined; notify('Todo restored.'); });
});
$('#dismiss-notice').addEventListener('click', () => { $('#notice').hidden = true; });
$('#clear-completed').addEventListener('click', () => {
  if (confirm('Permanently delete all completed todos?')) mutate(storage.clearCompleted, () => notify('Completed todos cleared.'));
});
$('#export').addEventListener('click', async () => {
  try {
    const saved = await storage.listTodos();
    const blob = new Blob([JSON.stringify({ version: 1, todos: saved }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `todos-${new Date().toISOString().slice(0, 10)}.json`;
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
    await mutate(() => storage.importTodos(imported), () => notify('Backup merged. Newer local changes were kept.'));
  } catch (error) { reportError(`Import failed. ${error.message}`); }
  finally { event.target.value = ''; }
});

channel?.addEventListener('message', () => { refresh().catch(() => reportError('Could not refresh your list. Reload to try again.')); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && storageReady) refresh().catch(() => reportError('Could not refresh your list. Reload to try again.'));
});

function connectionChanged() {
  $('#connection-label').textContent = navigator.onLine ? 'On your device' : 'Offline';
  $('#connection').classList.toggle('offline', !navigator.onLine);
}
window.addEventListener('online', connectionChanged);
window.addEventListener('offline', connectionChanged);
connectionChanged();

$('#today').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
function fitViewport() {
  if (!window.visualViewport || window.visualViewport.scale !== 1) return;
  document.documentElement.style.setProperty('--app-height', `${window.visualViewport.height}px`);
}
window.visualViewport?.addEventListener('resize', fitViewport);
fitViewport();

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

window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferredInstall = event; });
window.addEventListener('appinstalled', () => { deferredInstall = undefined; $('#install').hidden = true; });
$('#install').hidden = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
$('#install').addEventListener('click', async () => {
  if (deferredInstall) { await deferredInstall.prompt(); deferredInstall = undefined; }
  else $('#install-dialog').showModal();
});
$('#close-install').addEventListener('click', () => $('#install-dialog').close());

$('#persist').addEventListener('click', async () => {
  try {
    const granted = await navigator.storage.persist();
    $('#persistence-status').textContent = granted ? 'Persistent storage enabled. Keep backups too.' : 'Your browser manages storage automatically. Keep a backup.';
    $('#persist').hidden = granted;
  } catch { $('#persistence-status').textContent = 'Storage protection is unavailable. Keep a backup.'; }
});

async function startOffline() {
  if (!('serviceWorker' in navigator)) { $('#offline-status').textContent = 'Offline mode unavailable'; return; }
  try {
    registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    const updateReady = () => { $('#update-app').hidden = !registration.waiting; };
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', updateReady);
    });
    updateReady();
    await navigator.serviceWorker.ready;
    $('#offline-status').textContent = 'Ready for offline';
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (refreshing) location.reload(); });
  } catch { $('#offline-status').textContent = 'Connect once to enable offline'; }
}
$('#update-app').addEventListener('click', () => {
  if (($('#new-todo').value.trim() || $('#edit-dialog').open) && !confirm('Updating reloads the app. Discard your unsaved draft?')) return;
  if (registration?.waiting) { refreshing = true; registration.waiting.postMessage('ACTIVATE_UPDATE'); }
});

try {
  todos = await storage.listTodos();
  storageReady = true;
  render();
  if (navigator.storage?.persist) {
    const persistent = await navigator.storage.persisted();
    $('#persist').hidden = persistent;
    if (persistent) $('#persistence-status').textContent = 'Persistent storage enabled.';
  }
} catch { reportError('Storage is unavailable. Allow site storage in your browser, then reload.'); }
startOffline();
