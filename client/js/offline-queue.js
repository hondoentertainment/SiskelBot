/**
 * Offline message queue – stores messages in IndexedDB when the app is offline
 * and replays them in order once connectivity is restored.
 *
 * Exports: queueMessage, getQueuedMessages, clearMessage, replayQueue
 */

const DB_NAME = 'siskelbot-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

/** @type {Promise<IDBDatabase>|null} */
let _dbPromise = null;

/**
 * Open (or create) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      _dbPromise = null;
      reject(req.error);
    };
  });
  return _dbPromise;
}

/**
 * Generate a simple unique ID.
 * @returns {string}
 */
function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
}

/**
 * Queue a message for later sending.
 * @param {string} text - The message text
 * @returns {Promise<{id: string, text: string, timestamp: number}>}
 */
export async function queueMessage(text) {
  const db = await openDB();
  const entry = {
    id: generateId(),
    text: String(text),
    timestamp: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = () => resolve(entry);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve all queued messages, sorted by timestamp (oldest first).
 * @returns {Promise<Array<{id: string, text: string, timestamp: number}>>}
 */
export async function getQueuedMessages() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.sort((a, b) => a.timestamp - b.timestamp);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Remove a single message from the queue by ID.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function clearMessage(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Replay all queued messages in chronological order using the provided send
 * function. Each message is removed from the queue after successful send.
 *
 * @param {(text: string) => Promise<void>} sendFn - async function that sends a message
 * @returns {Promise<number>} number of messages replayed
 */
export async function replayQueue(sendFn) {
  const queued = await getQueuedMessages();
  let sent = 0;
  for (const msg of queued) {
    await sendFn(msg.text);
    await clearMessage(msg.id);
    sent++;
  }
  return sent;
}

/* Allow tests to reset internal state */
export function _resetDB() {
  _dbPromise = null;
}

/* Expose on window so the inline <script> in index.html can access the API */
if (typeof window !== 'undefined') {
  window.SiskelOfflineQueue = { queueMessage, getQueuedMessages, clearMessage, replayQueue };
}
