/**
 * Offline message queue unit tests.
 *
 * The offline-queue module targets the browser (IndexedDB + window), so we
 * provide a minimal fake-indexeddb shim that lives entirely in memory.  This
 * lets us exercise queueMessage, getQueuedMessages, clearMessage, and
 * replayQueue under Node's built-in test runner without any extra deps.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Minimal IndexedDB shim – just enough for the offline-queue module
// ---------------------------------------------------------------------------

class FakeObjectStore {
  constructor(opts) {
    this.keyPath = opts.keyPath;
    /** @type {Map<string, any>} */
    this._data = new Map();
  }
  add(value) {
    const key = value[this.keyPath];
    this._data.set(key, structuredClone(value));
    return { onsuccess: null, onerror: null };
  }
  getAll() {
    const result = [...this._data.values()];
    const req = { result, onsuccess: null, onerror: null };
    queueMicrotask(() => req.onsuccess?.());
    return req;
  }
  put(value) {
    const key = value[this.keyPath];
    this._data.set(key, structuredClone(value));
    return { onsuccess: null, onerror: null };
  }
  delete(key) {
    this._data.delete(key);
    return { onsuccess: null, onerror: null };
  }
}

class FakeTransaction {
  constructor(store) {
    this._store = store;
    this.oncomplete = null;
    this.onerror = null;
    this.error = null;
    queueMicrotask(() => this.oncomplete?.());
  }
  objectStore() {
    return this._store;
  }
}

class FakeDB {
  constructor() {
    /** @type {Map<string, FakeObjectStore>} */
    this._stores = new Map();
    this.objectStoreNames = { contains: (n) => this._stores.has(n) };
  }
  createObjectStore(name, opts) {
    const store = new FakeObjectStore(opts);
    this._stores.set(name, store);
    return store;
  }
  transaction(storeName, _mode) {
    return new FakeTransaction(this._stores.get(storeName));
  }
}

/** Track open databases so each name returns the same instance */
const _dbs = new Map();

globalThis.indexedDB = {
  open(name, _version) {
    let db = _dbs.get(name);
    if (!db) {
      db = new FakeDB();
      _dbs.set(name, db);
    }
    const req = { result: db, error: null, onupgradeneeded: null, onsuccess: null, onerror: null };
    queueMicrotask(() => {
      // Always fire upgradeneeded on first open so the store is created
      if (!db.objectStoreNames.contains("messages")) {
        req.onupgradeneeded?.();
      }
      req.onsuccess?.();
    });
    return req;
  },
};

// Provide a minimal window global so the module attaches SiskelOfflineQueue
globalThis.window = globalThis;

// ---------------------------------------------------------------------------
// Import the module under test (after shims are in place)
// ---------------------------------------------------------------------------

const { queueMessage, getQueuedMessages, clearMessage, replayQueue, _resetDB } =
  await import("../client/js/offline-queue.js");

// Reset DB state between tests
test.beforeEach(() => {
  _resetDB();
  _dbs.clear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("queueMessage stores a message and returns entry with id and timestamp", async () => {
  const entry = await queueMessage("hello world");
  assert.ok(entry.id, "entry should have an id");
  assert.equal(entry.text, "hello world");
  assert.ok(typeof entry.timestamp === "number");
  assert.ok(entry.timestamp <= Date.now());
});

test("getQueuedMessages returns empty array when nothing is queued", async () => {
  const msgs = await getQueuedMessages();
  assert.deepEqual(msgs, []);
});

test("getQueuedMessages returns queued messages sorted by timestamp", async () => {
  const a = await queueMessage("first");
  const b = await queueMessage("second");
  const c = await queueMessage("third");

  const msgs = await getQueuedMessages();
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].text, "first");
  assert.equal(msgs[1].text, "second");
  assert.equal(msgs[2].text, "third");
  // Timestamps should be non-decreasing
  assert.ok(msgs[0].timestamp <= msgs[1].timestamp);
  assert.ok(msgs[1].timestamp <= msgs[2].timestamp);
});

test("clearMessage removes a specific message", async () => {
  const a = await queueMessage("keep");
  const b = await queueMessage("remove");

  await clearMessage(b.id);
  const msgs = await getQueuedMessages();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, a.id);
  assert.equal(msgs[0].text, "keep");
});

test("clearMessage is a no-op for unknown id", async () => {
  await queueMessage("msg");
  await clearMessage("nonexistent-id");
  const msgs = await getQueuedMessages();
  assert.equal(msgs.length, 1);
});

test("replayQueue sends messages in chronological order and clears them", async () => {
  await queueMessage("alpha");
  await queueMessage("beta");
  await queueMessage("gamma");

  const sent = [];
  const count = await replayQueue(async (text) => {
    sent.push(text);
  });

  assert.equal(count, 3);
  assert.deepEqual(sent, ["alpha", "beta", "gamma"]);

  // Queue should be empty after replay
  const remaining = await getQueuedMessages();
  assert.equal(remaining.length, 0);
});

test("replayQueue returns 0 when queue is empty", async () => {
  const count = await replayQueue(async () => {});
  assert.equal(count, 0);
});

test("replayQueue retries on sendFn error and preserves failed messages", async () => {
  await queueMessage("one");
  await queueMessage("two");
  await queueMessage("three");

  const sent = [];
  const result = await replayQueue(async (text) => {
    if (text === "two") throw new Error("send failed");
    sent.push(text);
  });

  // "one" and "three" should have been sent and cleared
  assert.deepEqual(sent, ["one", "three"]);
  assert.equal(result, 2);

  // "two" remains in the queue with incremented retryCount
  const remaining = await getQueuedMessages();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, "two");
  assert.equal(remaining[0].retryCount, 1);
});

test("queueMessage coerces non-string input to string", async () => {
  const entry = await queueMessage(42);
  assert.equal(entry.text, "42");
});

test("window.SiskelOfflineQueue is set", () => {
  assert.ok(globalThis.SiskelOfflineQueue);
  assert.equal(typeof globalThis.SiskelOfflineQueue.queueMessage, "function");
  assert.equal(typeof globalThis.SiskelOfflineQueue.getQueuedMessages, "function");
  assert.equal(typeof globalThis.SiskelOfflineQueue.clearMessage, "function");
  assert.equal(typeof globalThis.SiskelOfflineQueue.replayQueue, "function");
});
