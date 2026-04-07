/**
 * Client-side renderer for real-time tool execution events streamed via SSE.
 * Dark theme, inline with agent messages, collapsible details.
 */
(function (global) {
  /* ---- CSS (injected once) ---- */
  var styleInjected = false;
  function injectStyles() {
    if (styleInjected) return;
    styleInjected = true;
    var style = document.createElement("style");
    style.textContent = [
      ".tool-stream-container { font-family: monospace; font-size: 13px; margin: 8px 0; }",
      ".tool-event { padding: 6px 10px; margin: 3px 0; border-radius: 6px; background: #1e1e2e; color: #cdd6f4; border-left: 3px solid #585b70; display: flex; align-items: flex-start; gap: 8px; }",
      ".tool-event .tool-icon { flex-shrink: 0; width: 18px; text-align: center; line-height: 20px; }",
      ".tool-event .tool-body { flex: 1; min-width: 0; }",
      ".tool-event .tool-name { font-weight: 600; color: #89b4fa; }",
      ".tool-event .tool-duration { color: #a6adc8; font-size: 11px; margin-left: 6px; }",
      ".tool-event .tool-error-msg { color: #f38ba8; margin-top: 2px; font-size: 12px; }",
      ".tool-event.tool-running { border-left-color: #89b4fa; }",
      ".tool-event.tool-done { border-left-color: #a6e3a1; }",
      ".tool-event.tool-error { border-left-color: #f38ba8; }",
      ".tool-event.tool-thinking { border-left-color: #f9e2af; background: #1e1e2e; color: #f9e2af; font-style: italic; }",
      "@keyframes tool-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }",
      ".tool-spinner { animation: tool-pulse 1.2s ease-in-out infinite; color: #89b4fa; }",
      ".tool-details-toggle { cursor: pointer; color: #585b70; font-size: 11px; margin-top: 3px; user-select: none; }",
      ".tool-details-toggle:hover { color: #cdd6f4; }",
      ".tool-details-content { display: none; margin-top: 4px; padding: 4px 6px; background: #181825; border-radius: 4px; font-size: 11px; color: #a6adc8; white-space: pre-wrap; word-break: break-all; max-height: 200px; overflow-y: auto; }",
      ".tool-details-content.open { display: block; }",
      ".tool-progress-bar { height: 3px; background: #313244; border-radius: 2px; margin-top: 4px; overflow: hidden; }",
      ".tool-progress-fill { height: 100%; background: #89b4fa; transition: width 0.3s ease; }",
    ].join("\n");
    document.head.appendChild(style);
  }

  /**
   * Create a tool stream renderer bound to a container element.
   * @param {HTMLElement} container
   * @returns {SiskelBot.ToolStreamRenderer}
   */
  function createToolStreamRenderer(container) {
    injectStyles();
    if (!container) {
      return { onToolStart: noop, onToolProgress: noop, onToolResult: noop, onToolError: noop, onAgentThinking: noop };
    }
    /** @type {Map<string, HTMLElement>} */
    var activeTools = new Map();

    function noop() {}

    function makeId(name) {
      return "tool-" + name + "-" + Date.now();
    }

    function createEventEl(cls, iconHtml, bodyHtml) {
      var el = document.createElement("div");
      el.className = "tool-event " + cls;
      el.innerHTML =
        '<span class="tool-icon">' + iconHtml + "</span>" +
        '<div class="tool-body">' + bodyHtml + "</div>";
      container.appendChild(el);
      return el;
    }

    function escapeHtml(s) {
      var div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function truncate(s, max) {
      if (!s) return "";
      if (s.length <= max) return s;
      return s.slice(0, max) + "...";
    }

    return {
      /**
       * @param {string} name
       * @param {object} args
       */
      onToolStart: function (name, args) {
        var argsStr = "";
        try { argsStr = JSON.stringify(args); } catch (_) { argsStr = "{}"; }
        var body =
          '<span class="tool-name">' + escapeHtml(name) + "</span>" +
          '<div class="tool-details-toggle" data-open="0">[show args]</div>' +
          '<div class="tool-details-content">' + escapeHtml(argsStr) + "</div>";
        var el = createEventEl("tool-running", '<span class="tool-spinner">&#9679;</span>', body);
        var toggle = el.querySelector(".tool-details-toggle");
        var details = el.querySelector(".tool-details-content");
        if (toggle && details) {
          toggle.addEventListener("click", function () {
            var isOpen = toggle.getAttribute("data-open") === "1";
            toggle.setAttribute("data-open", isOpen ? "0" : "1");
            toggle.textContent = isOpen ? "[show args]" : "[hide args]";
            details.classList.toggle("open", !isOpen);
          });
        }
        activeTools.set(name, el);
      },

      /**
       * @param {string} name
       * @param {{ message?: string; percent?: number }} progress
       */
      onToolProgress: function (name, progress) {
        var el = activeTools.get(name);
        if (!el) return;
        var existing = el.querySelector(".tool-progress-bar");
        if (!existing && typeof progress.percent === "number") {
          var bar = document.createElement("div");
          bar.className = "tool-progress-bar";
          bar.innerHTML = '<div class="tool-progress-fill" style="width:0%"></div>';
          el.querySelector(".tool-body").appendChild(bar);
          existing = bar;
        }
        if (existing && typeof progress.percent === "number") {
          var fill = existing.querySelector(".tool-progress-fill");
          if (fill) fill.style.width = Math.min(100, Math.max(0, progress.percent)) + "%";
        }
        if (progress.message) {
          var msgEl = el.querySelector(".tool-progress-msg");
          if (!msgEl) {
            msgEl = document.createElement("div");
            msgEl.className = "tool-progress-msg";
            msgEl.style.cssText = "font-size:11px;color:#a6adc8;margin-top:2px;";
            el.querySelector(".tool-body").appendChild(msgEl);
          }
          msgEl.textContent = progress.message;
        }
      },

      /**
       * @param {string} name
       * @param {object} result
       * @param {number} durationMs
       */
      onToolResult: function (name, result, durationMs) {
        var el = activeTools.get(name);
        if (!el) return;
        el.className = "tool-event tool-done";
        var icon = el.querySelector(".tool-icon");
        if (icon) icon.innerHTML = "&#10003;";
        var nameEl = el.querySelector(".tool-name");
        if (nameEl) {
          var dur = typeof durationMs === "number" ? durationMs : 0;
          nameEl.innerHTML = escapeHtml(name) + '<span class="tool-duration">' + dur + "ms</span>";
        }
        // Replace details content with result preview
        var details = el.querySelector(".tool-details-content");
        var toggle = el.querySelector(".tool-details-toggle");
        if (details && toggle) {
          var resultStr = "";
          try { resultStr = JSON.stringify(result, null, 2); } catch (_) { resultStr = String(result); }
          details.textContent = truncate(resultStr, 1000);
          toggle.textContent = "[show result]";
          toggle.setAttribute("data-open", "0");
          details.classList.remove("open");
        }
        // Remove progress bar
        var bar = el.querySelector(".tool-progress-bar");
        if (bar) bar.remove();
        activeTools.delete(name);
      },

      /**
       * @param {string} name
       * @param {string} error
       */
      onToolError: function (name, error) {
        var el = activeTools.get(name);
        if (el) {
          el.className = "tool-event tool-error";
          var icon = el.querySelector(".tool-icon");
          if (icon) icon.innerHTML = "&#10007;";
          var body = el.querySelector(".tool-body");
          if (body) {
            var errEl = document.createElement("div");
            errEl.className = "tool-error-msg";
            errEl.textContent = error;
            body.appendChild(errEl);
          }
          activeTools.delete(name);
        } else {
          createEventEl("tool-error", "&#10007;",
            '<span class="tool-name">' + escapeHtml(name) + "</span>" +
            '<div class="tool-error-msg">' + escapeHtml(error) + "</div>"
          );
        }
      },

      /**
       * @param {string} message
       */
      onAgentThinking: function (message) {
        var existing = container.querySelector(".tool-event.tool-thinking");
        if (existing) existing.remove();
        createEventEl("tool-thinking", '<span class="tool-spinner">&#9679;</span>', escapeHtml(message || "Thinking..."));
      },
    };
  }

  /**
   * Parse an SSE data line and dispatch to the renderer.
   * @param {object} evt - Parsed JSON from SSE data line
   * @param {ReturnType<typeof createToolStreamRenderer>} renderer
   */
  function dispatchToolStreamEvent(evt, renderer) {
    if (!evt || !evt.type) return;
    switch (evt.type) {
      case "tool_start":
        renderer.onToolStart(evt.name, evt.args);
        break;
      case "tool_progress":
        renderer.onToolProgress(evt.name, { message: evt.message, percent: evt.percent });
        break;
      case "tool_result":
        renderer.onToolResult(evt.name, evt.result, evt.durationMs);
        break;
      case "tool_error":
        renderer.onToolError(evt.name, evt.error);
        break;
      case "agent_thinking":
        renderer.onAgentThinking(evt.message);
        break;
    }
  }

  global.SiskelToolStreamUI = {
    createToolStreamRenderer: createToolStreamRenderer,
    dispatchToolStreamEvent: dispatchToolStreamEvent,
  };
})(typeof window !== "undefined" ? window : globalThis);
