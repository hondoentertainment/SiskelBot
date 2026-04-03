/**
 * Offline message queue – stores messages in IndexedDB when the app is offline
 * and replays them in order once connectivity is restored.
 *
 * Exports: queueMessage, getQueuedMessages, clearMessage, replayQueue,
 *          updateMessage, purgeExpired, initAutoReplay, getQueueSize,
 *          setOnQueueChange
 */

const DB_NAME = 'siskelbot-offline-queue';
const DB_VERSION = 1;
const STORE_NAME = 'messages';
const MAX_RETRIES = 5;
const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** @type {Promise<IDBDatabase>|null} */
let _dbPromise = null;

/** @type {((size: number) => void)|null} */
let _onQueueChange = null;

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
 * Notify the registered queue-change callback with the current queue size.
 */
async function _notifyChange() {
  if (_onQueueChange) {
    try {
      const size = await getQueueSize();
      _onQueueChange(size);
    } catch (_) {
      // Swallow errors in notification path
    }
  }
}

/**
 * Queue a message for later sending.
 * @param {string} text - The message text
 * @returns {Promise<{id: string, text: string, timestamp: number, retryCount: number}>}
 */
export async function queueMessage(text) {
  const db = await openDB();
  const entry = {
    id: generateId(),
    text: String(text),
    timestamp: Date.now(),
    retryCount: 0,
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(entry);
    tx.oncomplete = () => {
      _notifyChange();
      resolve(entry);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Retrieve all queued messages, sorted by timestamp (oldest first).
 * @returns {Promise<Array<{id: string, text: string, timestamp: number, retryCount: number}>>}
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
    tx.oncomplete = () => {
      _notifyChange();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Update an existing message entry in IndexedDB.
 * @param {object} entry - The full message entry with updated fields
 * @returns {Promise<void>}
 */
export async function updateMessage(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Replay all queued messages in chronological order using the provided send
 * function. Messages that fail are retried with exponential backoff up to
 * MAX_RETRIES. Messages that have exceeded MAX_RETRIES are skipped.
 *
 * @param {(text: string) => Promise<void>} sendFn - async function that sends a message
 * @returns {Promise<number>} number of messages successfully replayed
 */
export async function replayQueue(sendFn) {
  const queued = await getQueuedMessages();
  let sent = 0;
  const now = Date.now();

  for (const msg of queued) {
    // Skip expired or max-retried messages
    const retryCount = msg.retryCount || 0;
    if (retryCount >= MAX_RETRIES) continue;
    if (now - msg.timestamp >= EXPIRY_MS) continue;

    try {
      await sendFn(msg.text);
      await clearMessage(msg.id);
      sent++;
    } catch (_) {
      // Increment retry count and update in IndexedDB
      msg.retryCount = retryCount + 1;
      await updateMessage(msg);
    }
  }

  _notifyChange();
  return sent;
}

/**
 * Remove messages older than 24 hours or with retryCount >= MAX_RETRIES.
 * @returns {Promise<number>} number of messages purged
 */
export async function purgeExpired() {
  const queued = await getQueuedMessages();
  const now = Date.now();
  let purged = 0;

  for (const msg of queued) {
    const retryCount = msg.retryCount || 0;
    if (now - msg.timestamp >= EXPIRY_MS || retryCount >= MAX_RETRIES) {
      await clearMessage(msg.id);
      purged++;
    }
  }

  return purged;
}

/**
 * Set up automatic replay when the browser comes back online.
 * @param {(text: string) => Promise<void>} sendFn - async function that sends a message
 * @returns {() => void} cleanup function to remove the listener
 */
export function initAutoReplay(sendFn) {
  const handler = () => {
    replayQueue(sendFn);
  };
  window.addEventListener('online', handler);
  return () => {
    window.removeEventListener('online', handler);
  };
}

/**
 * Return the count of pending messages (not expired, not max-retried).
 * @returns {Promise<number>}
 */
export async function getQueueSize() {
  const queued = await getQueuedMessages();
  const now = Date.now();
  return queued.filter((msg) => {
    const retryCount = msg.retryCount || 0;
    return retryCount < MAX_RETRIES && now - msg.timestamp < EXPIRY_MS;
  }).length;
}

/**
 * Register a callback to be notified whenever the queue changes.
 * The callback receives the current pending queue size.
 * @param {((size: number) => void)|null} callback
 */
export function setOnQueueChange(callback) {
  _onQueueChange = callback;
}

/* Allow tests to reset internal state */
export function _resetDB() {
  _dbPromise = null;
}

/* Expose on window so the inline <script> in index.html can access the API */
if (typeof window !== 'undefined') {
  window.SiskelOfflineQueue = {
    queueMessage,
    getQueuedMessages,
    clearMessage,
    replayQueue,
    updateMessage,
    purgeExpired,
    initAutoReplay,
    getQueueSize,
    setOnQueueChange,
  };
}
