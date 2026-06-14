/**
 * Cross-platform SSE (Server-Sent Events) parser.
 * Works in browsers, React Native (with text streaming polyfill), and Node 18+.
 *
 * SiskelBot streams OpenAI-compatible SSE: lines of "data: {json}\n\n",
 * with a terminal "data: [DONE]" marker.
 */
export class StreamingHandler {
  constructor(options = {}) {
    this.decoder = options.decoder || new TextDecoder('utf-8');
    this.buffer = '';
  }

  /**
   * Consume a fetch Response body and emit parsed SSE events.
   * @param {Response} response - fetch Response with a readable body
   * @param {(token: string, event: object) => void} onToken
   * @param {(result: { text: string, events: object[] }) => void} onDone
   * @param {(err: Error) => void} [onError]
   */
  async consume(response, onToken, onDone, onError) {
    if (!response || !response.ok) {
      const err = new Error(
        `Stream request failed: ${response ? response.status : 'no response'}`
      );
      if (onError) onError(err);
      else throw err;
      return;
    }

    const body = response.body;
    if (!body) {
      const err = new Error('Response has no body (streaming not supported)');
      if (onError) onError(err);
      else throw err;
      return;
    }

    const events = [];
    let aggregated = '';

    try {
      if (typeof body.getReader === 'function') {
        const reader = body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk =
            typeof value === 'string' ? value : this.decoder.decode(value, { stream: true });
          const parsed = this._feed(chunk);
          for (const evt of parsed) {
            if (evt === '[DONE]') continue;
            events.push(evt);
            const token = this._extractToken(evt);
            if (token) {
              aggregated += token;
              if (onToken) onToken(token, evt);
            }
          }
        }
      } else if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const value of body) {
          const chunk =
            typeof value === 'string' ? value : this.decoder.decode(value, { stream: true });
          const parsed = this._feed(chunk);
          for (const evt of parsed) {
            if (evt === '[DONE]') continue;
            events.push(evt);
            const token = this._extractToken(evt);
            if (token) {
              aggregated += token;
              if (onToken) onToken(token, evt);
            }
          }
        }
      } else {
        throw new Error('Response body is not iterable or readable');
      }

      // Flush any residual buffered line
      const tail = this._flush();
      for (const evt of tail) {
        if (evt === '[DONE]') continue;
        events.push(evt);
        const token = this._extractToken(evt);
        if (token) {
          aggregated += token;
          if (onToken) onToken(token, evt);
        }
      }

      const result = { text: aggregated, events };
      if (onDone) onDone(result);
      return result;
    } catch (err) {
      if (onError) onError(err);
      else throw err;
    }
  }

  /**
   * Feed a text chunk and return an array of parsed event payloads.
   * Non-data lines are ignored.
   */
  _feed(chunk) {
    this.buffer += chunk;
    const events = [];
    let idx;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === '[DONE]') {
        events.push('[DONE]');
        continue;
      }
      try {
        events.push(JSON.parse(data));
      } catch {
        events.push({ raw: data });
      }
    }
    return events;
  }

  _flush() {
    const remaining = this.buffer;
    this.buffer = '';
    if (!remaining) return [];
    const line = remaining.replace(/\r$/, '');
    if (!line.startsWith('data:')) return [];
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return [];
    try {
      return [JSON.parse(data)];
    } catch {
      return [{ raw: data }];
    }
  }

  /**
   * Extract the token string from an OpenAI-compatible streaming chunk.
   */
  _extractToken(event) {
    if (!event || typeof event !== 'object') return '';
    if (event.choices && Array.isArray(event.choices) && event.choices[0]) {
      const choice = event.choices[0];
      if (choice.delta && typeof choice.delta.content === 'string') {
        return choice.delta.content;
      }
      if (choice.message && typeof choice.message.content === 'string') {
        return choice.message.content;
      }
      if (typeof choice.text === 'string') {
        return choice.text;
      }
    }
    if (typeof event.content === 'string') return event.content;
    if (typeof event.token === 'string') return event.token;
    return '';
  }

  reset() {
    this.buffer = '';
  }
}
