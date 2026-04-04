function getChatHtml(nonce, _cspSource) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SiskelBot Chat</title>
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
    }
    .message {
      margin-bottom: 12px;
      padding: 8px 12px;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.5;
    }
    .message.user {
      background: var(--vscode-inputValidation-infoBackground, #063b49);
      align-self: flex-end;
    }
    .message.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground, #3a3d41);
    }
    .message .role {
      font-weight: 600;
      font-size: 0.85em;
      margin-bottom: 4px;
      opacity: 0.8;
    }
    #input-area {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border, #444);
      background: var(--vscode-sideBar-background);
    }
    #input {
      flex: 1;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      border-radius: 4px;
      font-family: inherit;
      font-size: inherit;
      resize: none;
      min-height: 36px;
      max-height: 120px;
    }
    #input:focus { outline: 1px solid var(--vscode-focusBorder, #007acc); }
    #send {
      padding: 8px 16px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: inherit;
    }
    #send:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    #send:disabled { opacity: 0.5; cursor: default; }
    .status {
      padding: 4px 12px;
      font-size: 0.85em;
      opacity: 0.7;
      text-align: center;
    }
  </style>
</head>
<body>
  <div id="messages"></div>
  <div id="input-area">
    <textarea id="input" rows="1" placeholder="Type a message..."></textarea>
    <button id="send">Send</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    let conversation = [];
    let streaming = false;

    function addMessageEl(role, text) {
      const div = document.createElement("div");
      div.className = "message " + role;
      const roleLabel = document.createElement("div");
      roleLabel.className = "role";
      roleLabel.textContent = role === "user" ? "You" : "SiskelBot";
      const body = document.createElement("div");
      body.textContent = text;
      div.appendChild(roleLabel);
      div.appendChild(body);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return body;
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text || streaming) return;
      inputEl.value = "";
      addMessageEl("user", text);
      conversation.push({ role: "user", content: text });
      streaming = true;
      sendBtn.disabled = true;
      vscode.postMessage({ type: "chat", messages: conversation });
    }

    sendBtn.addEventListener("click", send);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    let currentAssistantEl = null;
    let currentAssistantText = "";

    window.addEventListener("message", (event) => {
      const msg = event.data;
      switch (msg.type) {
        case "chatChunk":
          if (!currentAssistantEl) {
            currentAssistantText = "";
            currentAssistantEl = addMessageEl("assistant", "");
          }
          currentAssistantText += msg.content;
          currentAssistantEl.textContent = currentAssistantText;
          messagesEl.scrollTop = messagesEl.scrollHeight;
          break;
        case "chatDone":
          if (currentAssistantText) {
            conversation.push({ role: "assistant", content: currentAssistantText });
          }
          currentAssistantEl = null;
          currentAssistantText = "";
          streaming = false;
          sendBtn.disabled = false;
          inputEl.focus();
          break;
        case "chatError":
          addMessageEl("assistant", "Error: " + msg.error);
          currentAssistantEl = null;
          currentAssistantText = "";
          streaming = false;
          sendBtn.disabled = false;
          break;
      }
    });

    inputEl.focus();
  </script>
</body>
</html>`;
}

module.exports = { getChatHtml };
