/**
 * Conversation export in multiple formats (markdown, JSON, HTML).
 */
import * as storage from "./storage.js";

/**
 * Export a conversation in the specified format.
 * @param {string} conversationId
 * @param {"markdown"|"json"|"html"} format
 * @param {string} [userId="anonymous"]
 * @param {string} [workspaceId="default"]
 * @returns {Promise<{content: string, contentType: string, filename: string}>}
 */
export async function exportConversation(conversationId, format, userId = "anonymous", workspaceId = "default") {
  const conversation = await storage.get("conversations", conversationId, workspaceId, userId);
  if (!conversation) throw new Error("Conversation not found");

  const title = conversation.title || "Untitled";
  const safeName = title.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
  const date = conversation.createdAt || new Date().toISOString();
  const model = conversation.meta?.model || conversation.model || "unknown";
  const exportDate = new Date().toISOString().split("T")[0];

  switch (format) {
    case "markdown":
      return {
        content: renderMarkdown(title, date, model, workspaceId, messages, exportDate),
        contentType: "text/markdown; charset=utf-8",
        filename: `${safeName}.md`,
      };
    case "json":
      return {
        content: JSON.stringify(conversation, null, 2),
        contentType: "application/json; charset=utf-8",
        filename: `${safeName}.json`,
      };
    case "html":
      return {
        content: renderHtml(title, date, model, workspaceId, messages, exportDate),
        contentType: "text/html; charset=utf-8",
        filename: `${safeName}.html`,
      };
    default:
      throw new Error(`Unsupported export format: ${format}`);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(title, date, model, workspace, messages, exportDate) {
  const lines = [
    `# Conversation: ${title}`,
    `Date: ${date} | Model: ${model} | Workspace: ${workspace}`,
    "",
    "---",
    "",
  ];
  for (const msg of messages) {
    const role = String(msg.role || "unknown").charAt(0).toUpperCase() + String(msg.role || "unknown").slice(1);
    lines.push(`## ${role}`);
    lines.push(String(msg.content || ""));
    lines.push("");
  }
  lines.push("---");
  lines.push(`*Exported from SiskelBot on ${exportDate}*`);
  return lines.join("\n");
}

function renderHtml(title, date, model, workspace, messages, exportDate) {
  const messagesHtml = messages
    .map((msg) => {
      const role = String(msg.role || "unknown");
      const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
      const roleClass = role === "assistant" ? "assistant" : role === "user" ? "user" : "system";
      return `<div class="message ${roleClass}"><div class="role">${escapeHtml(roleLabel)}</div><div class="content">${escapeHtml(String(msg.content || ""))}</div></div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} - SiskelBot Export</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
  .header { max-width: 800px; margin: 0 auto 2rem; }
  .header h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  .header .meta { font-size: 0.8125rem; color: #64748b; }
  hr { border: none; border-top: 1px solid #334155; margin: 1.5rem 0; max-width: 800px; margin-left: auto; margin-right: auto; }
  .messages { max-width: 800px; margin: 0 auto; }
  .message { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .message.user { border-left: 3px solid #2563eb; }
  .message.assistant { border-left: 3px solid #34d399; }
  .message.system { border-left: 3px solid #fbbf24; }
  .role { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; color: #94a3b8; margin-bottom: 0.5rem; letter-spacing: 0.05em; }
  .content { font-size: 0.875rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .footer { max-width: 800px; margin: 2rem auto 0; text-align: center; font-size: 0.75rem; color: #475569; }
</style>
</head>
<body>
<div class="header">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Date: ${escapeHtml(date)} | Model: ${escapeHtml(model)} | Workspace: ${escapeHtml(workspace)}</div>
</div>
<hr>
<div class="messages">
${messagesHtml}
</div>
<hr>
<div class="footer">Exported from SiskelBot on ${escapeHtml(exportDate)}</div>
</body>
</html>`;
}
