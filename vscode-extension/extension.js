const vscode = require("vscode");
const crypto = require("crypto");
const { SiskelBotClient } = require("./api-client");
const { getChatHtml } = require("./chat-webview");

let client = null;
let statusBarItem = null;

function getClient() {
  const config = vscode.workspace.getConfiguration("siskelbot");
  const serverUrl = config.get("serverUrl", "http://localhost:3000");
  const apiKey = config.get("apiKey", "");
  const workspace = config.get("workspace", "default");
  client = new SiskelBotClient(serverUrl, apiKey, workspace);
  return client;
}

// --- Knowledge Base Tree Provider ---

class KnowledgeTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this._items = [];
  }

  refresh() {
    this._items = [];
    this._onDidChange.fire();
  }

  async getChildren() {
    if (this._items.length) return this._items;
    try {
      const c = getClient();
      const data = await c.listKnowledge();
      const docs = Array.isArray(data) ? data : data?.items || data?.documents || [];
      this._items = docs.map((d) => ({
        id: d.id || d.title,
        label: d.title || d.id || "Untitled",
        description: d.content ? d.content.slice(0, 80) : "",
      }));
    } catch {
      this._items = [{ label: "Unable to load knowledge base", description: "Check connection" }];
    }
    return this._items;
  }

  getTreeItem(item) {
    const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    ti.description = item.description;
    ti.tooltip = item.description;
    return ti;
  }
}

// --- Recipes Tree Provider ---

class RecipesTreeProvider {
  constructor() {
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChange.event;
    this._items = [];
  }

  refresh() {
    this._items = [];
    this._onDidChange.fire();
  }

  async getChildren() {
    if (this._items.length) return this._items;
    try {
      const c = getClient();
      const data = await c.listRecipes();
      const recipes = Array.isArray(data) ? data : data?.items || data?.recipes || [];
      this._items = recipes.map((r) => ({
        id: r.id || r.name,
        label: r.name || r.id || "Unnamed Recipe",
        description: r.description || "",
      }));
    } catch {
      this._items = [{ label: "Unable to load recipes", description: "Check connection" }];
    }
    return this._items;
  }

  getTreeItem(item) {
    const ti = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
    ti.description = item.description;
    ti.tooltip = item.description;
    ti.contextValue = "recipe";
    return ti;
  }
}

// --- Chat Webview Provider ---

class ChatViewProvider {
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    this._view = null;
  }

  resolveWebviewView(webviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    const nonce = crypto.randomBytes(16).toString("hex");
    webviewView.webview.html = getChatHtml(nonce, webviewView.webview.cspSource);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "chat") {
        await this._handleChat(msg.messages, webviewView.webview);
      }
    });
  }

  async _handleChat(messages, webview) {
    try {
      const c = getClient();
      await c.chat(messages, (chunk) => {
        webview.postMessage({ type: "chatChunk", content: chunk });
      });
      webview.postMessage({ type: "chatDone" });
    } catch (err) {
      webview.postMessage({ type: "chatError", error: err.message });
    }
  }
}

// --- Standalone Chat Panel ---

function openChatPanel(_context) {
  const panel = vscode.window.createWebviewPanel(
    "siskelbot.chatPanel",
    "SiskelBot Chat",
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const nonce = crypto.randomBytes(16).toString("hex");
  panel.webview.html = getChatHtml(nonce, panel.webview.cspSource);

  panel.webview.onDidReceiveMessage(async (msg) => {
    if (msg.type === "chat") {
      try {
        const c = getClient();
        await c.chat(msg.messages, (chunk) => {
          panel.webview.postMessage({ type: "chatChunk", content: chunk });
        });
        panel.webview.postMessage({ type: "chatDone" });
      } catch (err) {
        panel.webview.postMessage({ type: "chatError", error: err.message });
      }
    }
  });
}

// --- Status Bar ---

async function updateStatus() {
  if (!statusBarItem) return;
  try {
    const c = getClient();
    await c.healthCheck();
    statusBarItem.text = "$(check) SiskelBot";
    statusBarItem.tooltip = "SiskelBot: Connected";
    statusBarItem.color = undefined;
  } catch {
    statusBarItem.text = "$(alert) SiskelBot";
    statusBarItem.tooltip = "SiskelBot: Disconnected";
    statusBarItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
  }
}

// --- Activation ---

function activate(context) {
  getClient();

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "siskelbot.configure";
  statusBarItem.text = "$(sync~spin) SiskelBot";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  updateStatus();

  // Refresh status periodically
  const statusInterval = setInterval(() => updateStatus(), 30000);
  context.subscriptions.push({ dispose: () => clearInterval(statusInterval) });

  // Tree providers
  const knowledgeProvider = new KnowledgeTreeProvider();
  const recipesProvider = new RecipesTreeProvider();
  vscode.window.registerTreeDataProvider("siskelbot.knowledge", knowledgeProvider);
  vscode.window.registerTreeDataProvider("siskelbot.recipes", recipesProvider);

  // Chat webview provider
  const chatProvider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("siskelbot.chat", chatProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("siskelbot.chat", () => {
      openChatPanel(context);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("siskelbot.searchKnowledge", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search knowledge base",
        placeHolder: "Enter search query...",
      });
      if (!query) return;
      try {
        const c = getClient();
        const results = await c.searchKnowledge(query);
        const items = Array.isArray(results) ? results : results?.items || results?.documents || [];
        if (!items.length) {
          vscode.window.showInformationMessage("No results found.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          items.map((i) => ({ label: i.title || i.id, detail: (i.content || "").slice(0, 120), item: i })),
          { placeHolder: "Select a document" }
        );
        if (picked) {
          const doc = await vscode.workspace.openTextDocument({ content: picked.item.content || JSON.stringify(picked.item, null, 2), language: "markdown" });
          vscode.window.showTextDocument(doc);
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Knowledge search failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("siskelbot.runRecipe", async () => {
      try {
        const c = getClient();
        const data = await c.listRecipes();
        const recipes = Array.isArray(data) ? data : data?.items || data?.recipes || [];
        if (!recipes.length) {
          vscode.window.showInformationMessage("No recipes available.");
          return;
        }
        const picked = await vscode.window.showQuickPick(
          recipes.map((r) => ({ label: r.name || r.id, description: r.description || "", id: r.id || r.name })),
          { placeHolder: "Select a recipe to run" }
        );
        if (!picked) return;
        vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Running recipe: ${picked.label}` },
          async () => {
            const result = await c.runRecipe(picked.id);
            vscode.window.showInformationMessage(`Recipe "${picked.label}" completed.`);
            const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(result, null, 2), language: "json" });
            vscode.window.showTextDocument(doc);
          }
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Recipe execution failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("siskelbot.indexFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor to index.");
        return;
      }
      const doc = editor.document;
      const title = doc.fileName.split(/[/\\]/).pop();
      const content = doc.getText();
      try {
        const c = getClient();
        await c.indexDocument(title, content, { language: doc.languageId, uri: doc.uri.toString() });
        vscode.window.showInformationMessage(`Indexed: ${title}`);
        knowledgeProvider.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Index failed: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("siskelbot.configure", () => {
      vscode.commands.executeCommand("workbench.action.openSettings", "siskelbot");
    })
  );

  // Refresh trees when config changes
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("siskelbot")) {
      getClient();
      knowledgeProvider.refresh();
      recipesProvider.refresh();
      updateStatus();
    }
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
