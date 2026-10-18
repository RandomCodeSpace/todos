import type { Backup, List, Todo } from './model.js';

// An undefined value removes that field from the stored record.
export type TodoChanges = { [K in keyof Omit<Todo, 'id' | 'createdAt'>]?: Todo[K] | undefined };
type StoreName = 'todos' | 'lists';
type Operation<T> = (stores: Record<StoreName, IDBObjectStore>, done: (value: T) => void, abort: (error: Error) => void) => void;

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    // Preserve the original database name so the rebrand retains existing lists.
    const request = indexedDB.open('randomcodespace-todos', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('todos')) db.createObjectStore('todos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'id' });
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other Tuck tabs and try again.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  return database;
}

async function transact<T = void>(names: StoreName[], mode: IDBTransactionMode, operation: Operation<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(names, mode);
    let result: T;
    let failure: Error | undefined;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('Storage transaction was cancelled.'));
    transaction.onerror = () => reject(transaction.error || new Error('Storage transaction failed.'));
    const stores = Object.fromEntries(names.map(name => [name, transaction.objectStore(name)])) as Record<StoreName, IDBObjectStore>;
    try { operation(stores, value => { result = value; }, error => { failure = error; transaction.abort(); }); }
    catch (error) { transaction.abort(); reject(error); }
  });
}

const deleted = () => new DOMException('This todo was deleted in another tab. Copy your draft into a new todo to keep it.', 'NotFoundError');

function apply(store: IDBObjectStore, id: string, changes: TodoChanges, abort: (error: Error) => void): void {
  const request = store.get(id);
  request.onsuccess = () => {
    if (!request.result) { abort(deleted()); return; }
    const next: Record<string, unknown> = { ...(request.result as Todo), ...changes, updatedAt: Date.now() };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    store.put(next);
  };
}

export function listTodos(): Promise<Todo[]> {
  return transact<Todo[]>(['todos'], 'readonly', ({ todos }, done) => {
    const request = todos.getAll();
    request.onsuccess = () => done(request.result as Todo[]);
  });
}

export function listAll(): Promise<Backup> {
  return transact<Backup>(['todos', 'lists'], 'readonly', (stores, done) => {
    const result: Backup = { todos: [], lists: [] };
    const todos = stores.todos.getAll();
    todos.onsuccess = () => { result.todos = todos.result as Todo[]; done(result); };
    const lists = stores.lists.getAll();
    lists.onsuccess = () => { result.lists = lists.result as List[]; done(result); };
  });
}

/** Adds a task together with its subtasks. */
export function addTodos(items: readonly Todo[]): Promise<void> {
  return transact(['todos'], 'readwrite', ({ todos }) => { for (const todo of items) todos.add(todo); });
}

export function changeTodo(id: string, changes: TodoChanges): Promise<void> {
  return changeTodos([[id, changes]]);
}

/** Applies every change or none of them. */
export function changeTodos(entries: ReadonlyArray<readonly [string, TodoChanges]>): Promise<void> {
  return transact(['todos'], 'readwrite', ({ todos }, _done, abort) => {
    for (const [id, changes] of entries) apply(todos, id, changes, abort);
  });
}

export function deleteTodos(ids: readonly string[]): Promise<void> {
  return transact(['todos'], 'readwrite', ({ todos }) => { for (const id of ids) todos.delete(id); });
}

// Completed tasks go with their subtasks; checked subtasks of open tasks stay.
export function clearCompleted(): Promise<void> {
  return transact(['todos'], 'readwrite', ({ todos }) => {
    const request = todos.getAll();
    request.onsuccess = () => {
      const all = request.result as Todo[];
      const index = new Map(all.map(todo => [todo.id, todo]));
      for (const todo of all) {
        const parent = todo.parentId ? index.get(todo.parentId) : undefined;
        if (parent ? parent.completed : todo.completed) todos.delete(todo.id);
      }
    };
  });
}

export function putList(list: List): Promise<void> { return transact(['lists'], 'readwrite', ({ lists }) => { lists.put(list); }); }

export function putLists(items: readonly List[]): Promise<void> {
  return transact(['lists'], 'readwrite', ({ lists }) => { for (const list of items) lists.put(list); });
}

/** Deletes a list; its tasks stay and lose the list. */
export function deleteList(id: string): Promise<void> {
  return transact(['todos', 'lists'], 'readwrite', ({ todos, lists }, _done, abort) => {
    lists.delete(id);
    const request = todos.getAll();
    request.onsuccess = () => {
      for (const todo of request.result as Todo[]) if (todo.listId === id) apply(todos, todo.id, { listId: undefined }, abort);
    };
  });
}

// Newer local changes win.
export function importBackup(backup: Backup): Promise<void> {
  return transact(['todos', 'lists'], 'readwrite', stores => {
    for (const [name, items] of [['todos', backup.todos], ['lists', backup.lists]] as const) {
      for (const item of items) {
        const request = stores[name].get(item.id);
        request.onsuccess = () => {
          const current = request.result as { updatedAt: number } | undefined;
          if (!current || current.updatedAt < item.updatedAt) stores[name].put(item);
        };
      }
    }
  });
}
