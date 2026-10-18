import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type Storage = typeof import('../../src/storage.ts');

const isPhone = (page: Page) => page.locator('#fab').isVisible();
async function compose(page: Page) {
  if (await isPhone(page) && !await page.getByLabel('New task').isVisible()) await page.locator('#fab').click();
}
// A running view transition owns hit-testing until it ends.
async function settle(page: Page) {
  await page.waitForFunction(() => !document.getAnimations().some(animation => (animation.effect as KeyframeEffect | null)?.pseudoElement?.startsWith('::view-transition')));
}
// Phones hide the dock while the composer has focus.
async function blur(page: Page) {
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await page.waitForTimeout(150);
  await settle(page);
}
async function add(page: Page, text: string) {
  await compose(page);
  await page.getByLabel('New task').fill(text);
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.locator('.todo-text', { hasText: text })).toBeVisible();
}
// Touch layouts delete from the task sheet; pointer layouts also show a row button.
async function remove(page: Page, text: string) {
  await page.getByRole('button', { name: `Edit ${text}`, exact: true }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.locator('#picker-dialog').getByRole('listitem').filter({ hasText: 'Delete task' }).click();
}
// Today and Upcoming sit in the phone dock; every view sits in the lists sheet and the desktop sidebar.
async function go(page: Page, name: string) {
  await blur(page);
  if (await isPhone(page)) {
    const tab = page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${name}`) });
    if (['Today', 'Upcoming'].includes(name)) { await tab.click(); return; }
    await page.locator('#open-lists').click();
    await page.locator('#sheet-nav').getByRole('button', { name: new RegExp(`^${name},`) }).click();
    await expect(page.locator('#lists-dialog')).toBeHidden();
  } else {
    await page.locator('#side-nav').getByRole('button', { name: new RegExp(`^${name},`) }).click();
  }
  await expect(page.locator('#view-title')).toHaveText(name);
}
async function openSettings(page: Page) {
  await blur(page);
  if (await isPhone(page)) await page.locator('#open-lists').click();
  await page.getByRole('button', { name: 'Settings' }).filter({ visible: true }).click();
  await expect(page.locator('#settings-dialog')).toBeVisible();
}
async function ready(page: Page) {
  await page.goto('./');
  await expect(page.locator('#add-button')).toBeEnabled();
}
const stored = (page: Page) => page.evaluate(async () => { const url = './storage.js'; return ((await import(url)) as Storage).listTodos(); });

test('create, edit, complete, filter and delete survive reload', async ({ page }) => {
  await ready(page);
  await add(page, 'Buy oat milk');
  await page.reload();
  await expect(page.getByText('Buy oat milk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Buy oat milk' }).click();
  await page.getByLabel('Edit task').fill('Buy coffee');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('checkbox', { name: 'Complete Buy coffee' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Buy coffee' })).toBeChecked();
  await go(page, 'Completed');
  await expect(page.getByText('Buy coffee', { exact: true })).toBeVisible();
  await go(page, 'Today');
  await page.getByRole('button', { name: '1 completed' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Buy coffee' })).toBeChecked();
  await go(page, 'Completed');
  await remove(page, 'Buy coffee');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Buy coffee', { exact: true })).toBeVisible();
  await remove(page, 'Buy coffee');
  await expect(page.getByText('Buy coffee', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Buy coffee', { exact: true })).toHaveCount(0);
});

test('offline launch and CRUD use IndexedDB', async ({ page, context }) => {
  await ready(page);
  await expect(page.locator('#offline-status')).toHaveText('Ready for offline');
  await add(page, 'Saved online');
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByText('Saved online', { exact: true })).toBeVisible();
  await add(page, 'Written offline');
  await blur(page);
  await page.getByRole('button', { name: 'Edit Written offline' }).click();
  await page.getByLabel('Edit task').fill('Edited offline');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('checkbox', { name: 'Complete Edited offline' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Edited offline' })).toBeChecked();
  await remove(page, 'Saved online');
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  await page.reload();
  await go(page, 'Completed');
  await expect(page.getByText('Edited offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  const saved = await stored(page);
  expect(saved).toHaveLength(1);
  expect(saved[0]?.completed).toBe(true);
});

test('untrusted text is literal and search covers subtasks', async ({ page }) => {
  await ready(page);
  await add(page, '<img src=x onerror=alert(1)>');
  await expect(page.locator('#todo-list img')).toHaveCount(0);
  await blur(page);
  if (await isPhone(page)) await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search tasks').fill('missing');
  await expect(page.getByText('No matches')).toBeVisible();
  await page.getByLabel('Search tasks').fill('ONERROR');
  await expect(page.locator('.todo-text')).toHaveCount(1);
});

test('invalid import preserves todos and valid import merges lists', async ({ page }) => {
  await ready(page);
  await add(page, 'Keep this');
  const upload = page.locator('#import-file');
  await upload.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"todos":[{}]}') });
  await expect(page.getByRole('alert')).toContainText('Import failed');
  await expect(page.getByText('Keep this', { exact: true })).toBeVisible();
  const backup = {
    version: 2,
    todos: [{ id: 'imported', text: 'From backup', completed: false, createdAt: 100, updatedAt: 100, listId: 'errands' }],
    lists: [{ id: 'errands', name: 'Errands', color: 'teal', order: 0, createdAt: 100, updatedAt: 100 }]
  };
  await upload.setInputFiles({ name: 'todos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByText('Keep this', { exact: true })).toBeVisible();
  await go(page, 'Errands');
  await expect(page.getByText('From backup', { exact: true })).toBeVisible();
  await openSettings(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  expect((await download).suggestedFilename()).toMatch(/^tuck-.*\.json$/);
});

test('failed storage does not pretend the todo was saved', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.add = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await compose(page);
  await page.getByLabel('New task').fill('Do not lose this draft');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('New task')).toHaveValue('Do not lose this draft');
  await expect(page.locator('.todo-text')).toHaveCount(0);
});

test('unavailable IndexedDB has an honest error state', async ({ page }) => {
  await page.addInitScript(() => { IDBFactory.prototype.open = () => { throw new Error('Unavailable'); }; });
  await page.goto('./');
  await expect(page.getByRole('alert')).toContainText('Storage is unavailable');
  await expect(page.locator('#add-button')).toBeDisabled();
});

test('mobile sizing and scroll controls keep inputs usable', async ({ page }) => {
  await ready(page);
  for (let index = 0; index < 12; index++) await add(page, `Task number ${index} with a fairly long description to wrap`);
  await blur(page);
  for (const [width, height] of [[320, 568], [375, 667], [393, 852], [1280, 720]] as const) {
    await page.setViewportSize({ width, height });
    const control = width < 900 ? '#dock' : '#add-form';
    await page.waitForFunction(selector => document.querySelector(selector)!.getBoundingClientRect().bottom <= innerHeight, control);
    const layout = await page.evaluate(selector => ({
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      controlVisible: document.querySelector(selector)!.getBoundingClientRect().bottom <= innerHeight,
      font: parseFloat(getComputedStyle(document.querySelector('#new-todo')!).fontSize),
      overscroll: getComputedStyle(document.querySelector('.list-area')!).getPropertyValue('overscroll-behavior-y'),
      supportsOverscroll: CSS.supports('overscroll-behavior', 'none'),
      viewport: document.querySelector<HTMLMetaElement>('meta[name=viewport]')!.content
    }), control);
    expect(layout.overflow).toBe(false);
    expect(layout.controlVisible).toBe(true);
    expect(layout.font).toBeGreaterThanOrEqual(16);
    if (layout.supportsOverscroll) expect(layout.overscroll).toBe('none');
    expect(layout.viewport).not.toContain('user-scalable=no');
  }
  await page.setViewportSize({ width: 375, height: 667 });
  await compose(page);
  await expect.poll(async () => { const box = await page.locator('#add-form').boundingBox(); return box!.y + box!.height; }).toBeLessThanOrEqual(667);
  const prevented = await page.evaluate(() => {
    const target = document.querySelector('.list-area')!;
    target.scrollTop = 0;
    const start = new Event('touchstart', { bubbles: true });
    Object.defineProperty(start, 'touches', { value: [{ clientX: 50, clientY: 100 }] });
    target.dispatchEvent(start);
    const movement = new Event('touchmove', { bubbles: true, cancelable: true });
    Object.defineProperty(movement, 'touches', { value: [{ clientX: 50, clientY: 150 }] });
    target.dispatchEvent(movement);
    return { supported: CSS.supports('overscroll-behavior', 'none'), prevented: movement.defaultPrevented };
  });
  if (!prevented.supported) expect(prevented.prevented).toBe(true);
});

test('separate tabs converge without overwriting unrelated todos', async ({ page, context }) => {
  await ready(page);
  const second = await context.newPage();
  await ready(second);
  await add(page, 'From first tab');
  await expect(second.getByText('From first tab', { exact: true })).toBeVisible();
  await add(second, 'From second tab');
  await expect(page.getByText('From second tab', { exact: true })).toBeVisible();
});

test('clear completed leaves active todos and their checked subtasks intact', async ({ page }) => {
  await ready(page);
  await page.evaluate(async () => {
    const url = './storage.js';
    const storage = (await import(url)) as Storage;
    const day = new Date();
    const due = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    await storage.addTodos([
      { id: 'keep', text: 'Keep active', completed: false, createdAt: 1, updatedAt: 1, due },
      { id: 'step', text: 'Checked step', completed: true, completedAt: 2, createdAt: 1, updatedAt: 2, parentId: 'keep' },
      { id: 'finished', text: 'Finished task', completed: true, completedAt: 2, createdAt: 1, updatedAt: 2 },
      { id: 'finished-step', text: 'Finished step', completed: false, createdAt: 1, updatedAt: 1, parentId: 'finished' }
    ]);
  });
  await page.reload();
  await openSettings(page);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear completed' }).click();
  await page.reload();
  await expect(page.getByText('Keep active', { exact: true })).toBeVisible();
  expect((await stored(page)).map(todo => todo.id).sort()).toEqual(['keep', 'step']);
});

test('an edit deleted in another tab keeps the draft and reports the conflict', async ({ page, context }) => {
  await ready(page);
  await add(page, 'Original todo');
  await blur(page);
  await page.getByRole('button', { name: 'Edit Original todo' }).click();
  await page.getByLabel('Edit task').fill('A draft worth keeping');
  const second = await context.newPage();
  await ready(second);
  await remove(second, 'Original todo');
  await expect(second.locator('.todo-text')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#edit-dialog')).toBeVisible();
  await expect(page.locator('#edit-dialog').getByRole('alert')).toContainText('deleted in another tab');
  await expect(page.getByLabel('Edit task')).toHaveValue('A draft worth keeping');
});

test('edit storage errors are accessible inside the modal', async ({ page }) => {
  await ready(page);
  await add(page, 'Original todo');
  await blur(page);
  await page.getByRole('button', { name: 'Edit Original todo' }).click();
  await page.getByLabel('Edit task').fill('My changed draft');
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/unbound-method -- re-invoked below with the original receiver.
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (name, mode, ...args) {
      if (mode === 'readwrite') throw new DOMException('Storage full', 'QuotaExceededError');
      return original.call(this, name, mode, ...args);
    };
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#edit-dialog').getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('Edit task')).toHaveValue('My changed draft');
});

test('a failed refresh after a committed add does not invite a duplicate', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/unbound-method -- re-invoked below with the original receiver.
    const original = IDBObjectStore.prototype.getAll;
    let failOnce = true;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (failOnce) { failOnce = false; throw new Error('Read unavailable'); }
      return original.apply(this, args);
    };
  });
  await compose(page);
  await page.getByLabel('New task').fill('Already committed');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByLabel('New task')).toHaveValue('');
  await expect(page.getByRole('alert')).toContainText('was saved');
  await page.reload();
  await expect(page.locator('.todo-text')).toHaveCount(1);
  await expect(page.getByText('Already committed', { exact: true })).toBeVisible();
});

test('keyboard focus survives toggle, edit and delete', async ({ page }) => {
  await ready(page);
  await add(page, 'Keyboard task');
  await blur(page);
  const checkbox = page.getByRole('checkbox', { name: 'Complete Keyboard task' });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('checkbox', { name: 'Reopen Keyboard task' })).toBeFocused();
  await page.getByRole('button', { name: 'Edit Keyboard task' }).click();
  await page.getByLabel('Edit task').fill('Edited with keyboard');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Edited with keyboard' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete Edited with keyboard' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveAttribute('aria-pressed', 'true');
});

test('Tuck keeps records saved before the rename and the lists upgrade', async ({ page }) => {
  await page.goto('./icon.svg');
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('randomcodespace-todos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('todos', { keyPath: 'id' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('todos', 'readwrite');
      transaction.objectStore('todos').add({ id: 'before-rename', text: 'Keep my existing list', completed: false, createdAt: 100, updatedAt: 100 });
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => reject(transaction.error);
    };
  }));
  await ready(page);
  await expect(page).toHaveTitle('Tuck - A little more headspace');
  await expect(page.locator('a.brand')).toHaveAttribute('aria-label', 'Tuck home');
  await expect(page.getByText('Keep my existing list', { exact: true })).toBeVisible();
  const manifest = await page.evaluate(async () => { const data: unknown = await (await fetch('./manifest.webmanifest')).json(); return data; });
  expect(manifest).toMatchObject({ short_name: 'Tuck' });
});

test('quick add reads the date and the sheet edits date, star and notes', async ({ page }) => {
  await ready(page);
  await compose(page);
  await page.getByLabel('New task').fill('Plan the trip tomorrow');
  await expect(page.locator('#mirror mark.tok-date')).toHaveText('tomorrow');
  await expect(page.locator('#new-date-label')).toHaveText('Tmrw');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Added to Upcoming');
  await expect(page.locator('.todo-text', { hasText: 'Plan the trip' })).toHaveCount(0);
  await go(page, 'Upcoming');
  await expect(page.getByText('Plan the trip', { exact: true })).toBeVisible();
  await expect(page.locator('.section').first()).toContainText('Tomorrow');
  await page.getByRole('button', { name: 'Edit Plan the trip' }).click();
  await page.locator('#edit-date').click();
  await page.locator('#date-dialog').getByRole('button', { name: 'Today', exact: true }).click();
  await page.locator('#date-time').fill('09:30');
  await page.locator('#date-time').dispatchEvent('change');
  await page.locator('#date-done').click();
  await page.getByRole('button', { name: 'Starred', exact: true }).click();
  await page.getByLabel('Notes').fill('Passports in the drawer');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Plan the trip', { exact: true })).toHaveCount(0);
  await go(page, 'Today');
  const row = page.locator('.todo', { hasText: 'Plan the trip' });
  await expect(row).toHaveClass(/flagged/);
  await expect(row.locator('.star')).toHaveCount(1);
  await page.reload();
  const saved = await stored(page);
  expect(saved[0]).toMatchObject({ text: 'Plan the trip', flagged: true, notes: 'Passports in the drawer', time: '09:30' });
  expect(saved[0]?.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('lists collect tasks typed with #name and keep them when deleted', async ({ page }) => {
  await ready(page);
  await blur(page);
  if (await isPhone(page)) { await page.locator('#open-lists').click(); await page.locator('#lists-dialog').getByRole('button', { name: 'List', exact: true }).click(); }
  else await page.locator('#side-nav').getByRole('button', { name: 'New list' }).click();
  await page.getByLabel('List name').fill('Groceries');
  await page.getByRole('radio', { name: 'Teal' }).check();
  await page.locator('#list-dialog').getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('#view-title')).toHaveText('Groceries');
  await add(page, 'Oat milk');
  await go(page, 'Today');
  await compose(page);
  await page.getByLabel('New task').fill('Bread #groceries');
  await expect(page.locator('#new-list-label')).toHaveText('Groceries');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.locator('.todo-text', { hasText: 'Bread' })).toBeVisible();
  await go(page, 'Groceries');
  await expect(page.locator('.todo-text')).toHaveText(['Bread', 'Oat milk']);
  await blur(page);
  if (await isPhone(page)) {
    await page.locator('#open-lists').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('#sheet-nav').getByRole('button', { name: /^Groceries,/ }).click();
  } else await page.locator('#side-nav').getByRole('button', { name: /^Groceries,/ }).click({ button: 'right' });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete list' }).click();
  await expect(page.locator('#view-title')).toHaveText('All');
  await expect(page.locator('.todo-text')).toHaveText(['Bread', 'Oat milk']);
  expect((await stored(page)).every(todo => !todo.listId)).toBe(true);
});

test('subtasks come from the composer, expand inline and complete with their task', async ({ page }) => {
  await ready(page);
  await compose(page);
  await page.getByLabel('New task').fill('Pack for Lisbon');
  await page.getByLabel('Subtask 1').fill('Passport');
  await page.getByLabel('Subtask 1').press('Enter');
  await page.getByLabel('Subtask 2').fill('Chargers');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.locator('.todo-text')).toHaveText(['Pack for Lisbon']);
  await expect(page.locator('.todo .meta')).toContainText('0/2');
  await blur(page);
  await page.getByRole('button', { name: 'Subtasks of Pack for Lisbon' }).click();
  await page.getByRole('checkbox', { name: 'Complete Passport' }).click();
  await expect(page.locator('.todo .meta')).toContainText('1/2');
  await page.getByRole('button', { name: 'Edit Pack for Lisbon' }).click();
  await expect(page.locator('#subs-count')).toHaveText('1 of 2');
  await page.getByLabel('Add subtask', { exact: true }).fill('Rain jacket');
  await page.getByLabel('Add subtask', { exact: true }).press('Enter');
  await expect(page.locator('#subs-count')).toHaveText('1 of 3');
  await page.locator('#edit-complete').click();
  await expect(page.locator('#edit-dialog')).toBeHidden();
  const saved = await stored(page);
  expect(saved).toHaveLength(4);
  expect(saved.every(todo => todo.completed)).toBe(true);
});

test('a task waits on another, cannot be completed early and unlocks when it is done', async ({ page }) => {
  await ready(page);
  await add(page, 'Confirm flights');
  await compose(page);
  await page.getByLabel('New task').fill('Book transfer');
  await page.getByRole('button', { name: 'Wait on another task' }).click();
  await page.locator('#picker-dialog').getByRole('listitem').filter({ hasText: 'Confirm flights' }).click();
  await expect(page.locator('#new-dep')).toHaveAccessibleName('Waits on Confirm flights');
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await blur(page);
  const blocked = page.locator('.todo', { hasText: 'Book transfer' });
  await expect(blocked).toHaveClass(/blocked/);
  await expect(blocked.locator('.meta')).toContainText('After Confirm flights');
  // Rows are disabled while the add is still being saved.
  await expect(page.locator('#add-form')).toHaveAttribute('aria-busy', 'false');
  await settle(page);
  await page.getByRole('checkbox', { name: 'Complete Book transfer' }).click({ force: true });
  await expect(page.getByRole('status')).toContainText('Finish "Confirm flights" first.');
  await expect(page.getByRole('checkbox', { name: 'Complete Book transfer' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Edit Confirm flights' }).click();
  await expect(page.locator('#edit-deps')).toContainText('Book transfer');
  // A cycle is not offered: Confirm flights cannot wait on Book transfer.
  await page.locator('#add-dep').click();
  await expect(page.locator('#picker-dialog').getByRole('listitem')).toHaveCount(0);
  await page.locator('#picker-close').click();
  await page.locator('#edit-complete').click();
  await expect(blocked).not.toHaveClass(/blocked/);
  await expect(blocked).toHaveClass(/unlocked/);
  await page.getByRole('checkbox', { name: 'Complete Book transfer' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Book transfer' })).toBeChecked();
});

test('completing a repeating task moves it to its next date', async ({ page }) => {
  await ready(page);
  await add(page, 'Water plants');
  await blur(page);
  await page.getByRole('button', { name: 'Edit Water plants' }).click();
  await page.locator('#edit-repeat').click();
  await page.locator('#date-repeat').selectOption('daily');
  await page.locator('#date-done').click();
  await expect(page.locator('#edit-repeat-label')).toHaveText('Every day');
  await page.locator('#edit-complete').click();
  await expect(page.getByRole('status')).toContainText('Next: Tomorrow');
  const [saved] = await stored(page);
  expect(saved).toMatchObject({ completed: false, repeat: 'daily' });
});

test('swiping a row completes it, reveals Later and Delete, and a long swipe deletes with undo', async ({ page }) => {
  await ready(page);
  await add(page, 'Swipe to finish');
  await add(page, 'Swipe to postpone');
  await add(page, 'Swipe to remove');
  await blur(page);
  const drag = (text: string, fraction: number) => page.evaluate(([label, share]) => {
    const row = [...document.querySelectorAll('.todo')].find(item => item.textContent?.includes(label))!.querySelector('.row')!;
    const box = row.getBoundingClientRect();
    const fire = (type: string, x: number) => (type === 'pointerdown' ? row : document).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: box.y + 20 }));
    const start = box.x + box.width / 2;
    const dx = box.width * share;
    fire('pointerdown', start);
    for (let step = 1; step <= 10; step++) fire('pointermove', start + dx * step / 10);
    fire('pointerup', start + dx);
  }, [text, fraction] as const);
  await drag('Swipe to finish', 0.4);
  await expect(page.getByRole('checkbox', { name: 'Reopen Swipe to finish' })).toBeChecked();
  await drag('Swipe to postpone', -0.25);
  await page.locator('.todo', { hasText: 'Swipe to postpone' }).locator('.swipe-later').click();
  await expect(page.getByRole('status')).toContainText('Moved to Tomorrow');
  await drag('Swipe to remove', -0.8);
  await expect(page.getByText('Swipe to remove', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Swipe to remove', { exact: true })).toBeVisible();
});

test('holding a task lifts it onto the week strip to reschedule it', async ({ page }) => {
  await ready(page);
  await add(page, 'Move me');
  await blur(page);
  await page.evaluate(async () => {
    const row = [...document.querySelectorAll('.todo')].find(item => item.textContent?.includes('Move me'))!.querySelector('.row')!;
    const box = row.getBoundingClientRect();
    const fire = (type: string, x: number, y: number) => (type === 'pointerdown' ? row : document).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 8, pointerType: 'touch', clientX: x, clientY: y }));
    fire('pointerdown', box.x + box.width / 2, box.y + 20);
    await new Promise(resolve => setTimeout(resolve, 600));
    const day = document.querySelectorAll<HTMLElement>('#week [data-day]')[3]!.getBoundingClientRect();
    for (let step = 1; step <= 8; step++) fire('pointermove', box.x + box.width / 2, box.y + 20 + (day.y - box.y) * step / 8);
    fire('pointermove', day.x + day.width / 2, day.y + day.height / 2);
    fire('pointerup', day.x + day.width / 2, day.y + day.height / 2);
  });
  await expect(page.getByRole('status')).toContainText('Moved to');
  const [saved] = await stored(page);
  const expected = new Date();
  expected.setDate(expected.getDate() + 3);
  expect(saved?.due).toBe(`${expected.getFullYear()}-${String(expected.getMonth() + 1).padStart(2, '0')}-${String(expected.getDate()).padStart(2, '0')}`);
});

test('pull down adds, long press offers quick actions, and closing the sheet saves', async ({ page }) => {
  await ready(page);
  await add(page, 'Hold me');
  await blur(page);
  const touch = (type: string, y: number, target = '#workspace') => page.evaluate(([kind, clientY, selector]) => {
    const node = document.querySelector(selector)!;
    const point = new Touch({ identifier: 1, target: node, clientX: 120, clientY });
    node.dispatchEvent(new TouchEvent(kind, { bubbles: true, cancelable: true, touches: kind === 'touchend' ? [] : [point], changedTouches: [point] }));
  }, [type, y, target] as const);
  const supportsTouch = await page.evaluate(() => { try { new Touch({ identifier: 1, target: document.body }); return true; } catch { return false; } });
  if (supportsTouch) {
    await touch('touchstart', 200);
    for (const y of [230, 280, 330, 380]) await touch('touchmove', y);
    await expect(page.locator('#pull')).toHaveClass(/armed/);
    await touch('touchend', 380);
    await expect(page.getByLabel('New task')).toBeFocused();
    await blur(page);
  }
  await page.locator('.todo', { hasText: 'Hold me' }).locator('.row').dispatchEvent('contextmenu');
  const sheet = page.locator('#actions-dialog');
  await expect(sheet).toContainText('Hold me');
  await sheet.getByRole('button', { name: 'Tomorrow' }).click();
  await expect(page.getByRole('status')).toContainText('Moved to Tomorrow');
  await go(page, 'Upcoming');
  await page.getByRole('button', { name: 'Edit Hold me' }).click();
  await page.getByLabel('Edit task').fill('Held and renamed');
  await page.locator('#edit-dialog').evaluate(dialog => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(page.getByText('Held and renamed', { exact: true })).toBeVisible();
});

test('phone dock gestures switch views, open lists and open and close search', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  const title = page.locator('#view-title');
  const slide = (from: number, to: number, dy = 0) => page.evaluate(([first, last, rise]) => {
    const buttons = [...document.querySelectorAll<HTMLElement>('#views button')];
    const point = (index: number) => { const box = buttons[index]!.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; };
    const start = point(first);
    const end = point(last);
    const fire = (type: string, x: number, y: number) => buttons[first]!.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 9, pointerType: 'touch', clientX: x, clientY: y }));
    fire('pointerdown', start.x, start.y);
    for (let step = 1; step <= 6; step++) fire('pointermove', start.x + (end.x - start.x) * step / 6, start.y - rise * step / 6);
    fire('pointerup', end.x, end.y - rise);
  }, [from, to, dy] as const);
  await slide(0, 1);
  await expect(title).toHaveText('Upcoming');
  await slide(0, 0, 60);
  await expect(page.locator('#lists-dialog')).toBeVisible();
  await page.locator('#lists-search').click();
  await expect(page.locator('#shell')).toHaveClass(/searching/);
  await expect(page.getByLabel('Search tasks')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(title).toHaveText('Upcoming');

  const supportsTouch = await page.evaluate(() => { try { new Touch({ identifier: 1, target: document.body }); return true; } catch { return false; } });
  if (!supportsTouch) return;
  const swipe = (selector: string, dx: number, dy: number) => page.evaluate(([target, x, y]) => {
    const node = document.querySelector(target)!;
    const box = node.getBoundingClientRect();
    const at = (offsetX: number, offsetY: number) => new Touch({ identifier: 2, target: node, clientX: box.x + box.width / 2 + offsetX, clientY: box.y + box.height / 2 + offsetY });
    node.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [at(0, 0)], changedTouches: [at(0, 0)] }));
    node.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [at(x, y)], changedTouches: [at(x, y)] }));
    node.dispatchEvent(new TouchEvent('touchend', { bubbles: true, touches: [], changedTouches: [at(x, y)] }));
  }, [selector, dx, dy] as const);
  await swipe('#view-title', -120, 8);
  await expect(title).toHaveText('Starred');
  await swipe('#view-title', 120, -8);
  await expect(title).toHaveText('Upcoming');
  await page.locator('#open-search').click();
  await page.getByLabel('Search tasks').fill('x');
  await swipe('#search-bar', 0, 60);
  await expect(page.locator('#shell')).not.toHaveClass(/searching/);
  await expect(page.getByLabel('Search tasks')).toHaveValue('');
});

test('an opaque strip owns the top edge so the status bar tint recovers after a sheet closes', async ({ page }) => {
  await ready(page);
  // Safari 26 samples the topmost fixed element at the top centre, ignoring pointer-events.
  const topEdge = () => page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.status-tint')!;
    strip.style.pointerEvents = 'auto';
    const hit = document.elementFromPoint(innerWidth / 2, 4);
    strip.style.pointerEvents = '';
    return { owner: hit === strip ? 'strip' : hit?.tagName ?? '', color: getComputedStyle(strip).backgroundColor };
  });
  expect(await topEdge()).toEqual({ owner: 'strip', color: 'rgb(236, 238, 241)' });
  await add(page, 'Tint check');
  await blur(page);
  await page.getByRole('button', { name: 'Edit Tint check' }).click();
  await expect(page.locator('#edit-dialog')).toBeVisible();
  expect((await topEdge()).owner).toBe('DIALOG');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#edit-dialog')).toBeHidden();
  // Saving re-renders through a view transition, whose overlay owns hit-testing until it ends.
  await expect.poll(async () => (await topEdge()).owner).toBe('strip');
});
