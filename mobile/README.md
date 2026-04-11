# SiskelBot Mobile

React Native mobile client for SiskelBot. Native iOS and Android app that connects to any SiskelBot server instance, supporting streaming chat, conversation history, knowledge base search, and on-device settings.

## Requirements

- Node.js 18 or higher
- React Native CLI (`npm install -g react-native-cli`)
- Watchman (macOS recommended)
- For iOS builds:
  - macOS with Xcode 15 or higher
  - CocoaPods (`sudo gem install cocoapods`)
  - An iOS Simulator or connected device
- For Android builds:
  - Android Studio with the Android SDK installed
  - JDK 17
  - An Android Emulator or connected device

## Setup

```bash
cd mobile
npm install

# iOS only: install CocoaPods dependencies
cd ios && pod install && cd ..
```

Note: the `android/` and `ios/` directories are not committed to this scaffold; run `npx react-native init` or copy the native templates from a fresh RN 0.75 project before building.

## Running in development

Start the Metro bundler:

```bash
npm start
```

Then in a separate terminal:

```bash
npm run ios       # iOS simulator
npm run android   # Android emulator
```

## Configuring the server

On first launch the app shows a Login screen. Enter:

- **Server URL** -- the base URL of your SiskelBot instance (e.g. `https://siskelbot.example.com` or `http://localhost:3000` for a local dev server)
- **API key** -- the API key configured in `API_KEY` or one of the user keys from `USER_API_KEYS`

Credentials are stored on-device using `@react-native-async-storage/async-storage`. You can change them any time from the Settings screen.

When running against a local dev server from a physical Android device, remember that `localhost` on the device refers to the device itself. Use your machine's LAN IP (e.g. `http://192.168.1.42:3000`) and ensure the SiskelBot server binds to `0.0.0.0`.

## Project structure

```
mobile/
├── README.md               This file
├── package.json            NPM manifest and scripts
├── app.json                React Native app metadata
├── index.js                RN entry point, registers the root component
└── src/
    ├── App.js              Root component, navigation, providers
    ├── api/
    │   ├── client.js       SiskelBotClient REST wrapper
    │   └── streaming.js    SSE streaming helper using react-native-sse
    ├── components/
    │   ├── MessageBubble.js     User and assistant bubble rendering
    │   ├── MessageInput.js      Input bar with send button
    │   ├── StreamingMessage.js  In-progress assistant response bubble
    │   └── ConversationList.js  List of conversations
    ├── screens/
    │   ├── LoginScreen.js
    │   ├── ChatScreen.js
    │   ├── ConversationsScreen.js
    │   ├── KnowledgeScreen.js
    │   └── SettingsScreen.js
    ├── store/
    │   ├── auth.js          Auth context (Context + useReducer, persisted)
    │   ├── conversations.js Conversations context
    │   └── settings.js      Settings context (theme, model, temperature)
    └── theme/
        └── colors.js        Dark and light theme palettes
```

State management uses React Context and `useReducer`. There is no Redux.

## Features

- Streaming chat via `/v1/chat/completions` using Server-Sent Events
- Conversation listing, selection, and deletion
- Knowledge base listing and search
- Dark theme (default) and light theme
- Persisted auth and settings using AsyncStorage
- Configurable model name and temperature

## Building for release

### iOS

```bash
cd ios
xcodebuild -workspace SiskelBot.xcworkspace \
  -scheme SiskelBot \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath build
```

Or use Xcode directly: open `ios/SiskelBot.xcworkspace`, select the "Any iOS Device" target, set the scheme to Release, and choose Product > Archive. Upload to App Store Connect via the Organizer window.

### Android

```bash
cd android
./gradlew assembleRelease    # Builds APK: android/app/build/outputs/apk/release/
./gradlew bundleRelease      # Builds AAB: android/app/build/outputs/bundle/release/
```

The AAB is the recommended upload format for Google Play.

Before building for release on Android, generate an upload keystore and configure signing in `android/app/build.gradle`; follow the instructions in the [React Native publishing guide](https://reactnative.dev/docs/signed-apk-android).

## Publishing

### App Store (iOS)

1. Configure your bundle identifier, version, and team in Xcode.
2. Archive the app (Product > Archive).
3. Upload via Xcode Organizer or Transporter.
4. Complete the listing in App Store Connect, then submit for review.

### Google Play (Android)

1. Create an app in the Google Play Console.
2. Upload the signed AAB to the desired track (internal / closed / production).
3. Fill in the store listing, content rating, and data safety form.
4. Submit for review.

## Testing

Run unit tests with Jest:

```bash
npm test
```

Run the linter:

```bash
npm run lint
```

## Troubleshooting

- **Metro cache issues:** `npm start -- --reset-cache`
- **iOS build errors after a dependency update:** `cd ios && pod install --repo-update`
- **Android build issues:** `cd android && ./gradlew clean`
- **Cannot reach server from Android emulator:** the emulator reaches the host machine at `http://10.0.2.2:<port>` instead of `localhost`.
