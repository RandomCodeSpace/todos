import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

type Storage = typeof import('../../src/storage.ts');

async function add(page: Page, text: string) {
  await page.getByLabel('New task').fill(text);
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.locator('.todo-text', { hasText: text })).toBeVisible();
}
// Touch layouts delete from the task sheet; pointer layouts also show a row button.
async function remove(page: Page, text: string) {
  await page.getByRole('button', { name: `Edit ${text}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete task', exact: true }).click();
}
function view(page: Page, name: string) { return page.getByRole('navigation', { name: 'Views' }).getByRole('button', { name: new RegExp(`^${name}`) }); }
async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function ready(page: Page) {
  await page.goto('./');
  await expect(page.getByLabel('New task')).toBeEnabled();
}

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
  await view(page, 'Done').click();
  await expect(page.getByText('Buy coffee', { exact: true })).toBeVisible();
  await view(page, 'Today').click();
  await expect(page.locator('.section', { hasText: 'Completed' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Reopen Buy coffee' })).toBeChecked();
  await view(page, 'Done').click();
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
  await page.getByRole('button', { name: 'Edit Written offline' }).click();
  await page.getByLabel('Edit task').fill('Edited offline');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('checkbox', { name: 'Complete Edited offline' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Edited offline' })).toBeChecked();
  await remove(page, 'Saved online');
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  await page.reload();
  await view(page, 'Done').click();
  await expect(page.getByText('Edited offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  const stored = await page.evaluate(async () => { const url = './storage.js'; return ((await import(url)) as Storage).listTodos(); });
  expect(stored).toHaveLength(1);
  expect(stored[0]?.completed).toBe(true);
});

test('untrusted text is literal and search works', async ({ page }) => {
  await ready(page);
  await add(page, '<img src=x onerror=alert(1)>');
  await expect(page.locator('#todo-list img')).toHaveCount(0);
  if (await page.getByRole('button', { name: 'Search', exact: true }).isVisible()) await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByLabel('Search tasks').fill('missing');
  await expect(page.getByText('No matches')).toBeVisible();
  await page.getByLabel('Search tasks').fill('ONERROR');
  await expect(page.locator('.todo-text')).toHaveCount(1);
});

test('invalid import preserves todos and valid import merges', async ({ page }) => {
  await ready(page);
  await add(page, 'Keep this');
  const upload = page.locator('#import-file');
  await upload.setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"todos":[{}]}') });
  await expect(page.getByRole('alert')).toContainText('Import failed');
  await expect(page.getByText('Keep this', { exact: true })).toBeVisible();
  const backup = { version: 1, todos: [{ id: 'imported', text: 'From backup', completed: false, createdAt: 100, updatedAt: 100 }] };
  await upload.setInputFiles({ name: 'todos.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await expect(page.getByText('Keep this', { exact: true })).toBeVisible();
  await view(page, 'Anytime').click();
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
  await expect(page.getByRole('button', { name: 'Add task', exact: true })).toBeDisabled();
});

test('mobile sizing and scroll controls keep inputs usable', async ({ page }) => {
  await ready(page);
  for (let index = 0; index < 12; index++) await add(page, `Task number ${index} with a fairly long description to wrap`);
  for (const [width, height] of [[320, 568], [375, 667], [393, 852], [1280, 720]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(() => document.querySelector('#add-form')!.getBoundingClientRect().bottom <= innerHeight);
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      composerVisible: document.querySelector('#add-form')!.getBoundingClientRect().bottom <= innerHeight,
      font: parseFloat(getComputedStyle(document.querySelector('#new-todo')!).fontSize),
      overscroll: getComputedStyle(document.querySelector('.list-area')!).getPropertyValue('overscroll-behavior-y'),
      supportsOverscroll: CSS.supports('overscroll-behavior', 'none'),
      viewport: document.querySelector<HTMLMetaElement>('meta[name=viewport]')!.content
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.composerVisible).toBe(true);
    expect(layout.font).toBeGreaterThanOrEqual(16);
    if (layout.supportsOverscroll) expect(layout.overscroll).toBe('none');
    expect(layout.viewport).not.toContain('user-scalable=no');
  }
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

test('clear completed leaves active todos intact', async ({ page }) => {
  await ready(page);
  await add(page, 'Keep active');
  await add(page, 'Finished task');
  await page.getByRole('checkbox', { name: 'Complete Finished task' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Finished task' })).toBeChecked();
  await openSettings(page);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear completed' }).click();
  await expect(page.getByText('Finished task', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Keep active', { exact: true })).toBeVisible();
  await expect(page.getByText('Finished task', { exact: true })).toHaveCount(0);
});

test('an edit deleted in another tab keeps the draft and reports the conflict', async ({ page, context }) => {
  await ready(page);
  await add(page, 'Original todo');
  await page.getByRole('button', { name: 'Edit Original todo' }).click();
  await page.getByLabel('Edit task').fill('A draft worth keeping');
  const second = await context.newPage();
  await ready(second);
  await remove(second, 'Original todo');
  await expect(second.locator('.todo-text')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('deleted in another tab');
  await expect(page.getByLabel('Edit task')).toHaveValue('A draft worth keeping');
});

test('edit storage errors are accessible inside the modal', async ({ page }) => {
  await ready(page);
  await add(page, 'Original todo');
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
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be saved');
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
  await expect(view(page, 'Today')).toBeFocused();
});

test('Tuck keeps records saved before the rename', async ({ page }) => {
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

test('due chips route tasks to views and the sheet edits date, flag and notes', async ({ page }) => {
  await ready(page);
  await page.getByLabel('New task').fill('Plan the trip');
  await page.getByRole('group', { name: 'When' }).getByRole('button', { name: 'Tomorrow' }).click();
  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Added to Upcoming');
  await expect(page.locator('.todo-text', { hasText: 'Plan the trip' })).toHaveCount(0);
  // Phones hide the tab bar while the composer has focus.
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await view(page, 'Upcoming').click();
  await expect(page.getByText('Plan the trip', { exact: true })).toBeVisible();
  await expect(page.locator('.section').first()).toHaveText('Tomorrow');
  await page.getByRole('button', { name: 'Edit Plan the trip' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Today', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Important').check();
  await page.getByLabel('Notes').fill('Passports in the drawer');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Plan the trip', { exact: true })).toHaveCount(0);
  await view(page, 'Today').click();
  const row = page.locator('.todo', { hasText: 'Plan the trip' });
  await expect(row).toHaveClass(/flagged/);
  await expect(row.locator('.ring-today')).toHaveCount(1);
  await expect(row.locator('.meta')).toContainText('Important');
  await page.reload();
  const stored = await page.evaluate(async () => { const url = './storage.js'; return ((await import(url)) as Storage).listTodos(); });
  expect(stored[0]).toMatchObject({ text: 'Plan the trip', flagged: true, notes: 'Passports in the drawer' });
  expect(stored[0]?.due).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test('swiping a row completes or deletes it with undo', async ({ page }) => {
  await ready(page);
  await add(page, 'Swipe to finish');
  await add(page, 'Swipe to remove');
  const drag = (text: string, distance: number) => page.evaluate(([label, dx]) => {
    const row = [...document.querySelectorAll('.todo')].find(item => item.textContent?.includes(label))!.querySelector('.row')!;
    const box = row.getBoundingClientRect();
    const fire = (type: string, x: number) => (type === 'pointerdown' ? row : document).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: box.y + 20 }));
    const start = box.x + box.width / 2;
    fire('pointerdown', start);
    for (let step = 1; step <= 10; step++) fire('pointermove', start + dx * step / 10);
    fire('pointerup', start + dx);
  }, [text, distance] as const);
  await drag('Swipe to finish', 260);
  await expect(page.getByRole('checkbox', { name: 'Reopen Swipe to finish' })).toBeChecked();
  await drag('Swipe to remove', -260);
  await expect(page.getByText('Swipe to remove', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Swipe to remove', { exact: true })).toBeVisible();
});

test('pull down adds, long press offers quick actions, and closing the sheet saves', async ({ page }) => {
  await ready(page);
  await add(page, 'Hold me');
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
  }
  await page.locator('.todo', { hasText: 'Hold me' }).locator('.row').dispatchEvent('contextmenu');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText('Hold me');
  await sheet.getByRole('button', { name: 'Tomorrow' }).click();
  await expect(page.getByRole('status')).toContainText('Moved to Tomorrow');
  await view(page, 'Upcoming').click();
  await page.getByRole('button', { name: 'Edit Hold me' }).click();
  await page.getByLabel('Edit task').fill('Held and renamed');
  await page.locator('#edit-dialog').evaluate(dialog => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await expect(page.getByText('Held and renamed', { exact: true })).toBeVisible();
});

test('phone dock gestures switch views and open and close search', async ({ page }) => {
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
  await slide(0, 2);
  await expect(title).toHaveText('Anytime');
  await slide(1, 1, 60);
  await expect(page.locator('#shell')).toHaveClass(/searching/);
  await expect(page.getByLabel('Search tasks')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(title).toHaveText('Anytime');

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
  await expect(title).toHaveText('Done');
  await swipe('#view-title', 120, -8);
  await expect(title).toHaveText('Anytime');
  await page.locator('#open-search').click();
  await page.getByLabel('Search tasks').fill('x');
  await swipe('#search-bar', 0, 60);
  await expect(page.locator('#shell')).not.toHaveClass(/searching/);
  await expect(page.getByLabel('Search tasks')).toHaveValue('');
});
