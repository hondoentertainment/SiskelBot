import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SiskelBotSDK } from '../src/SiskelBotSDK.js';
import { ChatClient } from '../src/ChatClient.js';
import { KnowledgeClient } from '../src/KnowledgeClient.js';
import { OfflineQueue } from '../src/OfflineQueue.js';
import { AuthManager } from '../src/AuthManager.js';
import { EventEmitter } from '../src/EventEmitter.js';
import { StreamingHandler } from '../src/StreamingHandler.js';

// ----- Mock fetch helpers -----

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: {
      get(name) {
        const n = name.toLowerCase();
        if (n === 'content-type') return headers['content-type'] || 'application/json';
        return headers[n] || null;
      },
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  const encoded = chunks.map((c) => encoder.encode(c));
  let idx = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return 'text/event-stream';
        return null;
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (idx >= encoded.length) return { done: true, value: undefined };
            const value = encoded[idx++];
            return { done: false, value };
          },
        };
      },
    },
    async text() {
      return '';
    },
  };
}

function makeMockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

// ----- EventEmitter -----

test('EventEmitter: emits and removes listeners', () => {
  const ee = new EventEmitter();
  let count = 0;
  const listener = (n) => {
    count += n;
  };
  ee.on('tick', listener);
  ee.emit('tick', 3);
  ee.emit('tick', 4);
  assert.equal(count, 7);
  ee.off('tick', listener);
  ee.emit('tick', 100);
  assert.equal(count, 7);
});

test('EventEmitter: once fires only one time', () => {
  const ee = new EventEmitter();
  let n = 0;
  ee.once('hit', () => {
    n += 1;
  });
  ee.emit('hit');
  ee.emit('hit');
  assert.equal(n, 1);
});

// ----- AuthManager -----

test('AuthManager: login/logout and getHeaders', () => {
  const auth = new AuthManager({ userAgent: 'Test/1.0' });
  assert.equal(auth.isAuthenticated(), false);
  auth.login('secret-key');
  assert.equal(auth.isAuthenticated(), true);
  const headers = auth.getHeaders({ 'X-Extra': 'yes' });
  assert.equal(headers['Authorization'], 'Bearer secret-key');
  assert.equal(headers['x-api-key'], 'secret-key');
  assert.equal(headers['User-Agent'], 'Test/1.0');
  assert.equal(headers['X-Extra'], 'yes');
  auth.logout();
  assert.equal(auth.isAuthenticated(), false);
  assert.equal(auth.getHeaders()['Authorization'], undefined);
});

// ----- OfflineQueue -----

test('OfflineQueue: enqueue, size, flush', async () => {
  const queue = new OfflineQueue();
  const processed = [];
  queue.setHandler(async (req) => {
    processed.push(req);
    return { ok: true };
  });
  await queue.enqueue({ kind: 'chat.send', message: 'first' });
  await queue.enqueue({ kind: 'chat.send', message: 'second' });
  assert.equal(await queue.size(), 2);
  const result = await queue.flush();
  assert.equal(result.processed, 2);
  assert.equal(result.remaining, 0);
  assert.equal(processed.length, 2);
  assert.equal(await queue.size(), 0);
});

test('OfflineQueue: failed items stay queued', async () => {
  const queue = new OfflineQueue();
  let attempt = 0;
  queue.setHandler(async () => {
    attempt += 1;
    throw new Error('down');
  });
  await queue.enqueue({ kind: 'chat.send', message: 'boom' });
  const result = await queue.flush();
  assert.equal(result.processed, 0);
  assert.equal(result.remaining, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(attempt, 1);
});

// ----- StreamingHandler -----

test('StreamingHandler: parses SSE chunks and assembles text', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const res = sseResponse(chunks);
  const handler = new StreamingHandler();
  const tokens = [];
  const result = await handler.consume(
    res,
    (t) => tokens.push(t),
    () => {},
  );
  assert.equal(tokens.join(''), 'Hello!');
  assert.equal(result.text, 'Hello!');
  assert.equal(result.events.length, 3);
});

test('StreamingHandler: handles multi-event chunks', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const res = sseResponse(chunks);
  const handler = new StreamingHandler();
  let text = '';
  await handler.consume(res, (t) => {
    text += t;
  });
  assert.equal(text, 'AB');
});

// ----- ChatClient -----

test('ChatClient: send posts messages and returns JSON', async () => {
  const mockResponse = {
    id: 'cmpl_1',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi there' } }],
  };
  const fetchImpl = makeMockFetch(() => jsonResponse(mockResponse));
  const auth = new AuthManager({ apiKey: 'k' });
  const chat = new ChatClient({
    baseUrl: 'https://example.com',
    auth,
    fetch: fetchImpl,
  });
  const res = await chat.send('hello');
  assert.equal(res.choices[0].message.content, 'hi there');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://example.com/v1/chat/completions');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'user');
  assert.equal(body.messages[0].content, 'hello');
});

test('ChatClient: sendStream emits tokens', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"str"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"eam"}}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const fetchImpl = makeMockFetch(() => sseResponse(chunks));
  const chat = new ChatClient({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  const tokens = [];
  let doneResult = null;
  await chat.sendStream(
    'go',
    (t) => tokens.push(t),
    (r) => {
      doneResult = r;
    },
  );
  assert.deepEqual(tokens, ['str', 'eam']);
  assert.equal(doneResult.text, 'stream');
});

test('ChatClient: listConversations hits /api/v1/conversations', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse([{ id: 'c1' }]));
  const chat = new ChatClient({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  const list = await chat.listConversations();
  assert.equal(list.length, 1);
  assert.equal(
    fetchImpl.calls[0].url,
    'https://example.com/api/v1/conversations',
  );
});

test('ChatClient: HTTP error surfaces with status', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ error: 'nope' }, { status: 401 }),
  );
  const chat = new ChatClient({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  await assert.rejects(() => chat.send('hello'), /401/);
});

// ----- KnowledgeClient -----

test('KnowledgeClient: search builds query string', async () => {
  const fetchImpl = makeMockFetch(() => jsonResponse({ results: [] }));
  const client = new KnowledgeClient({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  await client.search('foo bar', { limit: 5 });
  const url = fetchImpl.calls[0].url;
  assert.ok(url.includes('/api/v1/context/search'));
  assert.ok(url.includes('q=foo+bar') || url.includes('q=foo%20bar'));
  assert.ok(url.includes('limit=5'));
});

test('KnowledgeClient: add posts title and content', async () => {
  const fetchImpl = makeMockFetch(() =>
    jsonResponse({ id: 'd1', title: 't' }),
  );
  const client = new KnowledgeClient({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  const doc = await client.add('t', 'content-body', { source: 'sdk' });
  assert.equal(doc.id, 'd1');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.title, 't');
  assert.equal(body.content, 'content-body');
  assert.equal(body.source, 'sdk');
});

// ----- SiskelBotSDK integration -----

test('SiskelBotSDK: initialize emits ready and exposes clients', async () => {
  const fetchImpl = makeMockFetch((url) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
    return jsonResponse({});
  });
  const sdk = new SiskelBotSDK({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
  });
  let readyFired = false;
  sdk.events.on('ready', () => {
    readyFired = true;
  });
  const ok = await sdk.initialize();
  assert.equal(ok, true);
  assert.equal(readyFired, true);
  assert.equal(sdk.isReady(), true);
  assert.ok(sdk.chat instanceof ChatClient);
  assert.ok(sdk.knowledge instanceof KnowledgeClient);
  assert.ok(sdk.offline instanceof OfflineQueue);
  assert.ok(sdk.auth instanceof AuthManager);
  await sdk.destroy();
  assert.equal(sdk.isReady(), false);
});

test('SiskelBotSDK: offline queue flushes chat.send on initialize', async () => {
  const storage = (() => {
    const m = new Map();
    return {
      async getItem(k) {
        return m.has(k) ? m.get(k) : null;
      },
      async setItem(k, v) {
        m.set(k, v);
      },
      async removeItem(k) {
        m.delete(k);
      },
    };
  })();

  // Pre-seed queue with one chat.send request
  const q = new OfflineQueue(storage);
  q.setHandler(async () => {});
  await q.enqueue({
    kind: 'chat.send',
    message: 'queued hello',
    options: {},
  });

  const fetchImpl = makeMockFetch((url) => {
    if (url.endsWith('/health')) return jsonResponse({ status: 'ok' });
    if (url.endsWith('/v1/chat/completions')) {
      return jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'ack' } }],
      });
    }
    return jsonResponse({});
  });

  const sdk = new SiskelBotSDK({
    baseUrl: 'https://example.com',
    apiKey: 'k',
    fetch: fetchImpl,
    storage,
  });

  let flushed = null;
  sdk.events.on('queue:flushed', (r) => {
    flushed = r;
  });
  await sdk.initialize();
  assert.ok(flushed);
  assert.equal(flushed.processed, 1);
  assert.equal(await sdk.offline.size(), 0);
  await sdk.destroy();
});

test('SiskelBotSDK: throws without baseUrl', () => {
  assert.throws(() => new SiskelBotSDK({}), /baseUrl/);
});
