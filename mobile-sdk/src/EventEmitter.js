/**
 * Minimal cross-platform event emitter.
 * No Node.js dependencies. Works in RN, browsers, and Node.
 */
export class EventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('listener must be a function');
    }
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  once(event, listener) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event, listener) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this._listeners.delete(event);
    }
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return false;
    for (const listener of Array.from(set)) {
      try {
        listener(...args);
      } catch (err) {
        if (event !== 'error') {
          this.emit('error', err);
        }
      }
    }
    return true;
  }

  removeAllListeners(event) {
    if (event === undefined) {
      this._listeners.clear();
    } else {
      this._listeners.delete(event);
    }
  }

  listenerCount(event) {
    const set = this._listeners.get(event);
    return set ? set.size : 0;
  }
}
