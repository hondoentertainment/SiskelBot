(function () {
  "use strict";
  function mount(selector, opts) {
    const el = typeof selector === "string" ? document.querySelector(selector) : selector;
    if (!el) throw new Error("SiskelBot embed: mount target not found");
    const workspace = (opts && opts.workspace) || "default";
    const base = (opts && opts.baseUrl) || "";
    const iframe = document.createElement("iframe");
    iframe.src = base + "/embed/frame.html?workspace=" + encodeURIComponent(workspace);
    iframe.title = "SiskelBot";
    iframe.style.cssText = "width:100%;min-height:420px;border:0;border-radius:8px;";
    iframe.allow = "clipboard-write";
    el.appendChild(iframe);
    function onMessage(ev) {
      const data = ev.data;
      if (!data || data.source !== "siskelbot-embed") return;
      if (typeof (opts && opts.onEvent) === "function") opts.onEvent(data.type, data.payload);
      if (data.type === "siskelbot:resize" && data.payload && data.payload.height) {
        iframe.style.height = data.payload.height + "px";
      }
    }
    window.addEventListener("message", onMessage);
    return {
      iframe,
      destroy() {
        window.removeEventListener("message", onMessage);
        iframe.remove();
      },
      post(type, payload) {
        iframe.contentWindow &&
          iframe.contentWindow.postMessage({ source: "siskelbot-host", type, payload }, "*");
      },
    };
  }
  window.SiskelBotEmbed = { mount };
})();
