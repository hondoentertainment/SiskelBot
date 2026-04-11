import EventSource from 'react-native-sse';

export function createStreamingChat({ url, headers, body }) {
  const queue = [];
  let resolveNext = null;
  let rejectNext = null;
  let done = false;
  let error = null;

  const push = (value) => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r({ value, done: false });
    } else {
      queue.push(value);
    }
  };

  const finish = () => {
    done = true;
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      rejectNext = null;
      r({ value: undefined, done: true });
    }
  };

  const fail = (err) => {
    error = err;
    if (rejectNext) {
      const r = rejectNext;
      resolveNext = null;
      rejectNext = null;
      r(err);
    }
  };

  const es = new EventSource(url, {
    method: 'POST',
    headers: headers || {},
    body: JSON.stringify(body),
    pollingInterval: 0,
  });

  es.addEventListener('message', (event) => {
    const data = event.data;
    if (!data) return;
    if (data === '[DONE]') {
      es.close();
      finish();
      return;
    }
    try {
      const parsed = JSON.parse(data);
      const delta =
        parsed?.choices?.[0]?.delta?.content ||
        parsed?.choices?.[0]?.message?.content ||
        '';
      if (delta) {
        push({ type: 'delta', content: delta, raw: parsed });
      }
      const finishReason = parsed?.choices?.[0]?.finish_reason;
      if (finishReason) {
        push({ type: 'finish', reason: finishReason, raw: parsed });
      }
    } catch (e) {
      push({ type: 'delta', content: String(data) });
    }
  });

  es.addEventListener('error', (event) => {
    es.close();
    fail(new Error(event?.message || 'SSE connection error'));
  });

  es.addEventListener('close', () => {
    finish();
  });

  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (error) {
        return Promise.reject(error);
      }
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift(), done: false });
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((resolve, reject) => {
        resolveNext = resolve;
        rejectNext = reject;
      });
    },
    return() {
      es.close();
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

export default createStreamingChat;
