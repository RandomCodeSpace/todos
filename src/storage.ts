import type { Todo } from './model.js';

// An undefined value removes that field from the stored record.
export type TodoChanges = { [K in keyof Omit<Todo, 'id' | 'createdAt'>]?: Todo[K] | undefined };
type Operation<T> = (store: IDBObjectStore, done: (value: T) => void, abort: (error: Error) => void) => void;

let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    // Preserve the original database name so the rebrand retains existing lists.
    const request = indexedDB.open('randomcodespace-todos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('todos', { keyPath: 'id' });
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

async function transact<T = void>(mode: IDBTransactionMode, operation: Operation<T>): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('todos', mode);
    let result: T;
    let failure: Error | undefined;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('Storage transaction was cancelled.'));
    transaction.onerror = () => reject(transaction.error || new Error('Storage transaction failed.'));
    try { operation(transaction.objectStore('todos'), value => { result = value; }, error => { failure = error; transaction.abort(); }); }
    catch (error) { transaction.abort(); reject(error); }
  });
}

export function listTodos(): Promise<Todo[]> {
  return transact<Todo[]>('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result as Todo[]);
  });
}

export function addTodo(todo: Todo): Promise<void> { return transact('readwrite', store => { store.add(todo); }); }

export function changeTodo(id: string, changes: TodoChanges): Promise<void> {
  return transact('readwrite', (store, _done, abort) => {
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { abort(new DOMException('This todo was deleted in another tab. Copy your draft into a new todo to keep it.', 'NotFoundError')); return; }
      const next: Record<string, unknown> = { ...(request.result as Todo), ...changes, updatedAt: Date.now() };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      store.put(next);
    };
  });
}

export function deleteTodo(id: string): Promise<void> { return transact('readwrite', store => { store.delete(id); }); }

export function clearCompleted(): Promise<void> {
  return transact('readwrite', store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if ((cursor.value as Todo).completed) cursor.delete();
      cursor.continue();
    };
  });
}

export function importTodos(todos: readonly Todo[]): Promise<void> {
  return transact('readwrite', store => {
    for (const todo of todos) {
      const request = store.get(todo.id);
      request.onsuccess = () => {
        const current = request.result as Todo | undefined;
        if (!current || current.updatedAt < todo.updatedAt) store.put(todo);
      };
    }
  });
}
