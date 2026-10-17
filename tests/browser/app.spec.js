import { test, expect } from '@playwright/test';

async function add(page, text) {
  await page.getByLabel('New todo').fill(text);
  await page.getByRole('button', { name: 'Add todo', exact: true }).click();
  await expect(page.locator('.todo-text', { hasText: text })).toBeVisible();
}
async function ready(page) {
  await page.goto('./');
  await expect(page.getByLabel('New todo')).toBeEnabled();
}

test('create, edit, complete, filter and delete survive reload', async ({ page }) => {
  await ready(page);
  await add(page, 'Buy oat milk');
  await page.reload();
  await expect(page.getByText('Buy oat milk', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Buy oat milk' }).click();
  await page.getByLabel('Edit todo').fill('Buy coffee');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('checkbox', { name: 'Complete Buy coffee' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Buy coffee' })).toBeChecked();
  await page.getByRole('button', { name: /^Active/ }).click();
  await expect(page.getByText('Buy coffee', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /^Done/ }).click();
  await expect(page.getByText('Buy coffee', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Buy coffee' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByText('Buy coffee', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Buy coffee' }).click();
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
  await page.getByLabel('Edit todo').fill('Edited offline');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('checkbox', { name: 'Complete Edited offline' }).click();
  await expect(page.getByRole('checkbox', { name: 'Reopen Edited offline' })).toBeChecked();
  await page.getByRole('button', { name: 'Delete Saved online' }).click();
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Edited offline', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved online', { exact: true })).toHaveCount(0);
  const stored = await page.evaluate(async () => (await import('./storage.js')).listTodos());
  expect(stored).toHaveLength(1);
  expect(stored[0].completed).toBe(true);
});

test('untrusted text is literal and search works', async ({ page }) => {
  await ready(page);
  await add(page, '<img src=x onerror=alert(1)>');
  await expect(page.locator('#todo-list img')).toHaveCount(0);
  await page.getByLabel('Search todos').fill('missing');
  await expect(page.getByText('No matching todos')).toBeVisible();
  await page.getByLabel('Search todos').fill('ONERROR');
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
  await expect(page.getByText('From backup', { exact: true })).toBeVisible();
  await expect(page.getByText('Keep this', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup' }).click();
  expect((await download).suggestedFilename()).toMatch(/^todos-.*\.json$/);
});

test('failed storage does not pretend the todo was saved', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.add = () => { throw new DOMException('Storage full', 'QuotaExceededError'); };
  });
  await page.getByLabel('New todo').fill('Do not lose this draft');
  await page.getByRole('button', { name: 'Add todo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('New todo')).toHaveValue('Do not lose this draft');
  await expect(page.locator('.todo-text')).toHaveCount(0);
});

test('unavailable IndexedDB has an honest error state', async ({ page }) => {
  await page.addInitScript(() => { IDBFactory.prototype.open = () => { throw new Error('Unavailable'); }; });
  await page.goto('./');
  await expect(page.getByRole('alert')).toContainText('Storage is unavailable');
  await expect(page.getByRole('button', { name: 'Add todo', exact: true })).toBeDisabled();
});

test('mobile sizing and scroll controls keep inputs usable', async ({ page }) => {
  await ready(page);
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      font: parseFloat(getComputedStyle(document.querySelector('textarea')).fontSize),
      overscroll: getComputedStyle(document.querySelector('.workspace')).getPropertyValue('overscroll-behavior-y'),
      supportsOverscroll: CSS.supports('overscroll-behavior', 'none'),
      viewport: document.querySelector('meta[name=viewport]').content
    }));
    expect(layout.overflow).toBe(false);
    expect(layout.font).toBeGreaterThanOrEqual(16);
    if (layout.supportsOverscroll) expect(layout.overscroll).toBe('none');
    expect(layout.viewport).not.toContain('user-scalable=no');
  }
  const prevented = await page.evaluate(() => {
    const target = document.querySelector('.workspace');
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
  await page.getByLabel('Edit todo').fill('A draft worth keeping');
  const second = await context.newPage();
  await ready(second);
  await second.getByRole('button', { name: 'Delete Original todo' }).click();
  await expect(second.locator('.todo-text')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('deleted in another tab');
  await expect(page.getByLabel('Edit todo')).toHaveValue('A draft worth keeping');
});

test('edit storage errors are accessible inside the modal', async ({ page }) => {
  await ready(page);
  await add(page, 'Original todo');
  await page.getByRole('button', { name: 'Edit Original todo' }).click();
  await page.getByLabel('Edit todo').fill('My changed draft');
  await page.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (name, mode, ...args) {
      if (mode === 'readwrite') throw new DOMException('Storage full', 'QuotaExceededError');
      return original.call(this, name, mode, ...args);
    };
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByLabel('Edit todo')).toHaveValue('My changed draft');
});

test('a failed refresh after a committed add does not invite a duplicate', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.getAll;
    let failOnce = true;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (failOnce) { failOnce = false; throw new Error('Read unavailable'); }
      return original.apply(this, args);
    };
  });
  await page.getByLabel('New todo').fill('Already committed');
  await page.getByRole('button', { name: 'Add todo', exact: true }).click();
  await expect(page.getByLabel('New todo')).toHaveValue('');
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
  await page.getByLabel('Edit todo').fill('Edited with keyboard');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Edited with keyboard' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete Edited with keyboard' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: /^All/ })).toBeFocused();
});
