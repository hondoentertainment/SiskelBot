# React Native integration

Use `@siskelbot/mobile-sdk` in a React Native app with streaming chat and offline queueing.

## Install

```bash
npm install @siskelbot/mobile-sdk @react-native-async-storage/async-storage
# Required for SSE streaming in React Native:
npm install react-native-polyfill-globals react-native-url-polyfill text-encoding
```

## Polyfills (required for SSE streaming)

In your app entry point (`index.js`):

```js
import 'react-native-polyfill-globals/auto';
import 'react-native-url-polyfill/auto';
import 'text-encoding';
```

These provide `fetch` with streaming body support, `TextEncoder`/`TextDecoder`, and `URLSearchParams`.

## Initialize the SDK

Create a singleton module (`lib/sdk.js`):

```js
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SiskelBotSDK } from '@siskelbot/mobile-sdk';

const storage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

export const sdk = new SiskelBotSDK({
  baseUrl: 'https://your-siskelbot.com',
  apiKey: 'your-api-key',
  storage,
  userAgent: 'MyApp/1.0 (ReactNative)',
  onError: (err) => console.warn('SiskelBot SDK error', err),
});

sdk.events.on('ready', () => console.log('SDK ready'));
sdk.events.on('queue:flushed', (r) => console.log('Flushed', r));
```

Call `sdk.initialize()` once when the app boots (e.g. inside a top-level `useEffect`).

## Streaming chat screen

```jsx
import React, { useState } from 'react';
import { View, Text, TextInput, Button, ScrollView } from 'react-native';
import { sdk } from './lib/sdk';

export default function ChatScreen() {
  const [input, setInput] = useState('');
  const [response, setResponse] = useState('');
  const [streaming, setStreaming] = useState(false);

  async function onSend() {
    setResponse('');
    setStreaming(true);
    try {
      await sdk.chat.sendStream(
        input,
        (token) => setResponse((prev) => prev + token),
        (result) => console.log('done', result.text),
      );
    } catch (err) {
      // Queue for later if the network is down
      await sdk.offline.enqueue({ kind: 'chat.send', message: input });
      setResponse('(offline; queued for retry)');
    } finally {
      setStreaming(false);
    }
  }

  return (
    <View style={{ flex: 1, padding: 16 }}>
      <TextInput
        value={input}
        onChangeText={setInput}
        placeholder="Ask anything..."
        style={{ borderWidth: 1, padding: 8, marginBottom: 8 }}
      />
      <Button title={streaming ? 'Sending...' : 'Send'} onPress={onSend} disabled={streaming} />
      <ScrollView style={{ marginTop: 16 }}>
        <Text>{response}</Text>
      </ScrollView>
    </View>
  );
}
```

## Reacting to connectivity

Use `@react-native-community/netinfo` to detect online/offline transitions and flush the queue:

```js
import NetInfo from '@react-native-community/netinfo';
import { sdk } from './lib/sdk';

NetInfo.addEventListener((state) => {
  if (state.isConnected) {
    sdk.offline.flush().catch(() => {});
  }
});
```

## Knowledge base

```js
await sdk.knowledge.add('Meeting notes', 'We agreed to ...');
const hits = await sdk.knowledge.search('meeting');
const docs = await sdk.knowledge.list();
```
