# Web integration (browser / React / Vue / vanilla)

`@siskelbot/mobile-sdk` works in any modern browser with no additional polyfills.

## Install

```bash
npm install @siskelbot/mobile-sdk
```

Or load via a CDN:

```html
<script type="module">
  import { SiskelBotSDK } from 'https://unpkg.com/@siskelbot/mobile-sdk/index.js';
</script>
```

## Vanilla JavaScript

```html
<!DOCTYPE html>
<html>
  <body>
    <input id="q" placeholder="Ask anything..." />
    <button id="send">Send</button>
    <pre id="out"></pre>

    <script type="module">
      import { SiskelBotSDK } from 'https://unpkg.com/@siskelbot/mobile-sdk/index.js';

      const sdk = new SiskelBotSDK({
        baseUrl: 'https://your-siskelbot.com',
        apiKey: 'your-api-key',
        // storage defaults to window.localStorage in the browser
      });
      await sdk.initialize();

      document.getElementById('send').onclick = async () => {
        const q = document.getElementById('q').value;
        const out = document.getElementById('out');
        out.textContent = '';
        await sdk.chat.sendStream(
          q,
          (token) => (out.textContent += token),
          (result) => console.log('done', result.text),
        );
      };
    </script>
  </body>
</html>
```

## React

```jsx
import { useEffect, useRef, useState } from 'react';
import { SiskelBotSDK } from '@siskelbot/mobile-sdk';

const sdk = new SiskelBotSDK({
  baseUrl: import.meta.env.VITE_SISKELBOT_URL,
  apiKey: import.meta.env.VITE_SISKELBOT_KEY,
});

export default function Chat() {
  const [ready, setReady] = useState(false);
  const [text, setText] = useState('');
  const [reply, setReply] = useState('');

  useEffect(() => {
    sdk.initialize().then(() => setReady(true));
    return () => {
      sdk.destroy();
    };
  }, []);

  async function send() {
    setReply('');
    await sdk.chat.sendStream(text, (token) => setReply((p) => p + token));
  }

  return (
    <div>
      <input value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={send} disabled={!ready}>
        Send
      </button>
      <pre>{reply}</pre>
    </div>
  );
}
```

## Vue 3

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { SiskelBotSDK } from '@siskelbot/mobile-sdk';

const sdk = new SiskelBotSDK({
  baseUrl: import.meta.env.VITE_SISKELBOT_URL,
  apiKey: import.meta.env.VITE_SISKELBOT_KEY,
});

const input = ref('');
const reply = ref('');

onMounted(() => sdk.initialize());
onUnmounted(() => sdk.destroy());

async function send() {
  reply.value = '';
  await sdk.chat.sendStream(input.value, (t) => (reply.value += t));
}
</script>

<template>
  <input v-model="input" />
  <button @click="send">Send</button>
  <pre>{{ reply }}</pre>
</template>
```

## Knowledge base

```js
await sdk.knowledge.add('Notes', 'Some content');
const { results } = await sdk.knowledge.search('content');
const semantic = await sdk.knowledge.semanticSearch('what did I save about content?');
```

## Offline-first behavior

In the browser the SDK listens for the `online` / `offline` window events and
auto-flushes any queued requests when connectivity returns. Enqueue a message
manually when a `send()` call fails:

```js
try {
  await sdk.chat.send('hello');
} catch (err) {
  await sdk.offline.enqueue({ kind: 'chat.send', message: 'hello' });
}
```
