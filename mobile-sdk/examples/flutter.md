# Flutter integration (WebView wrapper)

`@siskelbot/mobile-sdk` is a JavaScript package, so in Flutter you load it inside
a `webview_flutter` WebView and bridge calls from Dart to JavaScript.

This approach is the simplest way to use the SDK in Flutter without writing a
second native implementation.

## Install Flutter packages

```yaml
dependencies:
  flutter:
    sdk: flutter
  webview_flutter: ^4.0.0
```

## Host HTML

Create `assets/siskelbot.html` (bundled with your app as a Flutter asset):

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SiskelBot bridge</title>
  </head>
  <body>
    <div id="out"></div>
    <script type="module">
      import { SiskelBotSDK } from 'https://unpkg.com/@siskelbot/mobile-sdk/index.js';

      const sdk = new SiskelBotSDK({
        baseUrl: 'https://your-siskelbot.com',
        apiKey: 'your-api-key',
      });

      await sdk.initialize();
      window._sdk = sdk;

      // Bridge: Flutter calls window.sbSend(message) and gets a callback
      window.sbSend = async function (message) {
        try {
          const res = await sdk.chat.send(message);
          const text = res.choices?.[0]?.message?.content || '';
          FlutterChannel.postMessage(JSON.stringify({ ok: true, text }));
        } catch (e) {
          FlutterChannel.postMessage(JSON.stringify({ ok: false, error: String(e) }));
        }
      };

      window.sbStream = async function (message) {
        try {
          await sdk.chat.sendStream(
            message,
            (token) =>
              FlutterChannel.postMessage(JSON.stringify({ type: 'token', token })),
            (result) =>
              FlutterChannel.postMessage(JSON.stringify({ type: 'done', text: result.text })),
          );
        } catch (e) {
          FlutterChannel.postMessage(JSON.stringify({ type: 'error', error: String(e) }));
        }
      };
    </script>
  </body>
</html>
```

Declare the asset in `pubspec.yaml`:

```yaml
flutter:
  assets:
    - assets/siskelbot.html
```

## Flutter widget

```dart
import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';

class SiskelBotView extends StatefulWidget {
  const SiskelBotView({super.key});
  @override
  State<SiskelBotView> createState() => _SiskelBotViewState();
}

class _SiskelBotViewState extends State<SiskelBotView> {
  late final WebViewController _controller;
  String _output = '';

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'FlutterChannel',
        onMessageReceived: (msg) {
          final data = json.decode(msg.message);
          if (data['type'] == 'token') {
            setState(() => _output += data['token']);
          } else if (data['type'] == 'done') {
            debugPrint('done: ${data['text']}');
          } else if (data['ok'] == true) {
            setState(() => _output = data['text']);
          }
        },
      )
      ..loadFlutterAsset('assets/siskelbot.html');
  }

  Future<void> _send(String message) async {
    final escaped = json.encode(message);
    await _controller.runJavaScript('window.sbStream($escaped)');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('SiskelBot')),
      body: Column(
        children: [
          Expanded(
            child: Stack(
              children: [
                WebViewWidget(controller: _controller),
                Positioned.fill(child: Text(_output)),
              ],
            ),
          ),
          ElevatedButton(
            onPressed: () => _send('Hello from Flutter!'),
            child: const Text('Send'),
          ),
        ],
      ),
    );
  }
}
```

## Native alternative

If you need a native Dart implementation with no WebView, mirror the SDK's
public API (`ChatClient`, `KnowledgeClient`, `OfflineQueue`, etc.) against the
same REST endpoints documented in `README.md`. The SDK's source files are a
useful reference for endpoint paths and payload shapes.
