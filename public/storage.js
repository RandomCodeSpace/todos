let database;

function openDatabase() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('randomcodespace-todos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('todos', { keyPath: 'id' });
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other Todos tabs and try again.')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  return database;
}

async function transact(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('todos', mode);
    let result;
    let failure;
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('Storage transaction was cancelled.'));
    transaction.onerror = () => reject(transaction.error || new Error('Storage transaction failed.'));
    try { operation(transaction.objectStore('todos'), value => { result = value; }, error => { failure = error; transaction.abort(); }); }
    catch (error) { transaction.abort(); reject(error); }
  });
}

export function listTodos() {
  return transact('readonly', (store, done) => {
    const request = store.getAll();
    request.onsuccess = () => done(request.result);
  });
}

export function addTodo(todo) { return transact('readwrite', store => store.add(todo)); }

export function changeTodo(id, changes) {
  return transact('readwrite', (store, done, abort) => {
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { abort(new DOMException('This todo was deleted in another tab. Copy your draft into a new todo to keep it.', 'NotFoundError')); return; }
      store.put({ ...request.result, ...changes, updatedAt: Date.now() });
    };
  });
}

export function deleteTodo(id) { return transact('readwrite', store => store.delete(id)); }

export function clearCompleted() {
  return transact('readwrite', store => {
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.completed) cursor.delete();
      cursor.continue();
    };
  });
}

export function importTodos(todos) {
  return transact('readwrite', store => {
    for (const todo of todos) {
      const request = store.get(todo.id);
      request.onsuccess = () => {
        if (!request.result || request.result.updatedAt < todo.updatedAt) store.put(todo);
      };
    }
  });
}
