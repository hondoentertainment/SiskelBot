# SiskelBot VS Code Extension

VS Code extension that connects to a running SiskelBot server, providing chat, knowledge base browsing, and recipe execution directly from your editor.

## Prerequisites

- A running SiskelBot server (default: `http://localhost:3000`)
- VS Code 1.85.0 or later

## Installation

### From VSIX

1. Package the extension:
   ```bash
   cd vscode-extension
   npm install -g @vscode/vsce
   vsce package
   ```
2. Install the VSIX:
   ```bash
   code --install-extension siskelbot-vscode-0.1.0.vsix
   ```

### For Development

1. Open the `vscode-extension/` folder in VS Code.
2. Press `F5` to launch a new Extension Development Host window.

## Configuration

Open VS Code settings and search for "SiskelBot":

| Setting | Default | Description |
|---------|---------|-------------|
| `siskelbot.serverUrl` | `http://localhost:3000` | URL of the SiskelBot server |
| `siskelbot.apiKey` | (empty) | API key for authentication |
| `siskelbot.workspace` | `default` | Default workspace name |

You can also run the **SiskelBot: Configure** command to open settings directly.

## Features

### Chat

Open the chat panel from the SiskelBot activity bar or run the **SiskelBot: Chat** command. Messages are sent to the SiskelBot server and responses are streamed back in real time.

### Knowledge Base

Browse indexed documents in the Knowledge Base tree view. Use **SiskelBot: Search Knowledge** to search by keyword. Use **SiskelBot: Index Current File** to send the active editor's content to the server.

### Recipes

View available recipes in the Recipes tree view. Run a recipe by selecting it and using **SiskelBot: Run Recipe**.

## Activity Bar

The extension adds a SiskelBot icon to the activity bar with three views:

- **Chat** -- Webview-based chat interface with streaming responses
- **Knowledge Base** -- Tree view of indexed documents
- **Recipes** -- Tree view of available recipes

## Status Bar

A status bar item shows the connection status to the SiskelBot server. Click it to reconnect or reconfigure.
