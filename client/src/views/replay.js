/**
 * Read-only replay viewer: three panes (Plan / Timeline / Artifacts) and a top
 * scrubber with play/pause, step forward/back, speed (0.5x/1x/2x/4x), and a
 * draggable seek. Self-contained: no imports from other views.
 *
 * Public export: mount(el, { token })
 */

const SPEEDS = [0.5, 1, 2, 4];
const DEFAULT_STEP_MS = 600;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2), v);
    } else if (v !== null && v !== undefined) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fmtTime(at, offsetMs) {
  if (typeof at === "string") {
    try {
      const d = new Date(at);
      if (!Number.isNaN(d.getTime())) return d.toLocaleTimeString();
    } catch (_) {
      /* ignore */
    }
  }
  const secs = Math.floor(offsetMs / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function renderPlan(container, plan) {
  container.innerHTML = "";
  container.appendChild(el("h3", { class: "replay-pane-title", text: "Plan" }));
  if (!plan) {
    container.appendChild(el("p", { class: "replay-empty", text: "No plan recorded." }));
    return;
  }
  if (plan.title) container.appendChild(el("h4", { class: "replay-plan-title", text: plan.title }));
  if (plan.status) {
    container.appendChild(
      el("div", { class: `replay-status replay-status-${plan.status}`, text: plan.status }),
    );
  }
  if (plan.planSummary) {
    container.appendChild(el("pre", { class: "replay-plan-summary", text: plan.planSummary }));
  }
  if (plan.planDag && typeof plan.planDag === "object") {
    container.appendChild(el("h4", { text: "DAG" }));
    container.appendChild(
      el("pre", { class: "replay-plan-dag", text: JSON.stringify(plan.planDag, null, 2) }),
    );
  }
}

function renderTimeline(container, events, currentIndex, onSelect) {
  container.innerHTML = "";
  container.appendChild(el("h3", { class: "replay-pane-title", text: "Timeline" }));
  if (!events.length) {
    container.appendChild(el("p", { class: "replay-empty", text: "No events." }));
    return;
  }
  const list = el("ol", { class: "replay-timeline-list" });
  events.forEach((ev, i) => {
    const item = el("li", {
      class: `replay-timeline-item${i === currentIndex ? " replay-timeline-active" : ""}${i > currentIndex ? " replay-timeline-future" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => onSelect(i),
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(i);
        }
      },
    });
    item.appendChild(el("span", { class: "replay-ev-idx", text: `#${i + 1}` }));
    item.appendChild(
      el("span", { class: "replay-ev-type", text: ev.type || "event" }),
    );
    if (ev.name) {
      item.appendChild(el("span", { class: "replay-ev-name", text: ev.name }));
    }
    if (ev.at) {
      item.appendChild(
        el("span", { class: "replay-ev-at", text: fmtTime(ev.at, i * DEFAULT_STEP_MS) }),
      );
    }
    list.appendChild(item);
  });
  container.appendChild(list);
}

function renderArtifact(container, event, index) {
  container.innerHTML = "";
  container.appendChild(el("h3", { class: "replay-pane-title", text: "Artifact" }));
  if (!event) {
    container.appendChild(el("p", { class: "replay-empty", text: "Select an event." }));
    return;
  }
  container.appendChild(
    el("div", { class: "replay-artifact-header" }, [
      el("span", { class: "replay-ev-idx", text: `#${index + 1}` }),
      el("span", { class: "replay-ev-type", text: event.type || "event" }),
      event.name ? el("span", { class: "replay-ev-name", text: event.name }) : null,
    ]),
  );
  if (event.summary) {
    container.appendChild(el("p", { class: "replay-artifact-summary", text: event.summary }));
  }
  if (event.preview) {
    container.appendChild(el("h4", { text: "Input" }));
    container.appendChild(el("pre", { class: "replay-artifact-pre", text: event.preview }));
  }
  if (event.result) {
    container.appendChild(el("h4", { text: "Result" }));
    container.appendChild(el("pre", { class: "replay-artifact-pre", text: event.result }));
  }
  if (event.at) {
    container.appendChild(el("div", { class: "replay-artifact-meta", text: `at: ${event.at}` }));
  }
}

function renderBanner(container, meta) {
  container.innerHTML = "";
  container.appendChild(el("span", { class: "replay-banner-dot" }));
  container.appendChild(
    el("span", { class: "replay-banner-label", text: "Read-only replay" }),
  );
  if (meta?.runId) {
    container.appendChild(
      el("span", { class: "replay-banner-run", text: `run ${meta.runId.slice(0, 8)}` }),
    );
  }
  if (meta?.expiresAt) {
    container.appendChild(
      el("span", { class: "replay-banner-exp", text: `expires ${meta.expiresAt}` }),
    );
  }
}

/**
 * Mount the replay viewer into `el`.
 * @param {HTMLElement} root
 * @param {{ token: string }} opts
 */
export async function mount(root, opts) {
  if (!root) throw new Error("mount: root element required");
  const token = String(opts?.token || "").trim();
  root.innerHTML = "";
  root.classList.add("replay-root");

  const banner = el("div", { class: "replay-banner", role: "status" });
  const scrubber = el("div", { class: "replay-scrubber" });
  const paneGrid = el("div", { class: "replay-grid" });
  const planPane = el("div", { class: "replay-pane replay-pane-plan" });
  const timelinePane = el("div", { class: "replay-pane replay-pane-timeline" });
  const artifactPane = el("div", { class: "replay-pane replay-pane-artifact" });
  paneGrid.append(planPane, timelinePane, artifactPane);

  const errorBox = el("div", { class: "replay-error", role: "alert" });
  errorBox.style.display = "none";

  root.append(banner, scrubber, paneGrid, errorBox);
  renderBanner(banner, null);

  if (!token) {
    errorBox.style.display = "";
    errorBox.textContent = "Missing replay token.";
    return () => {
      try { globalThis.SiskelbotShell?.inspector?.clear(); } catch (_) { /* noop */ }
    };
  }

  const abort = new AbortController();

  let data;
  try {
    const resp = await fetch(`/api/v1/replay/${encodeURIComponent(token)}/events`, {
      method: "GET",
      credentials: "omit",
      headers: { accept: "application/json" },
      signal: abort.signal,
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body?.error || body?.code || `HTTP ${resp.status}`);
    }
    data = await resp.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      return () => { /* already aborted */ };
    }
    errorBox.style.display = "";
    errorBox.textContent = `Could not load replay: ${err?.message || err}`;
    return () => {
      try { globalThis.SiskelbotShell?.inspector?.clear(); } catch (_) { /* noop */ }
    };
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  renderBanner(banner, { runId: data.runId, expiresAt: data.expiresAt });

  const state = {
    index: events.length ? 0 : -1,
    playing: false,
    speed: 1,
    timer: null,
  };

  function refreshPanes() {
    renderPlan(planPane, data.plan);
    renderTimeline(timelinePane, events, state.index, (i) => {
      state.index = i;
      refreshPanes();
      updateScrubber();
    });
    renderArtifact(
      artifactPane,
      state.index >= 0 ? events[state.index] : null,
      state.index,
    );
  }

  function stopTimer() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function tick() {
    if (!state.playing) return;
    if (state.index >= events.length - 1) {
      state.playing = false;
      refreshScrubberButtons();
      return;
    }
    state.index += 1;
    refreshPanes();
    updateScrubber();
    const delay = Math.max(50, Math.round(DEFAULT_STEP_MS / state.speed));
    state.timer = setTimeout(tick, delay);
  }

  function play() {
    if (!events.length) return;
    if (state.index >= events.length - 1) state.index = 0;
    state.playing = true;
    refreshScrubberButtons();
    stopTimer();
    const delay = Math.max(50, Math.round(DEFAULT_STEP_MS / state.speed));
    state.timer = setTimeout(tick, delay);
  }

  function pause() {
    state.playing = false;
    stopTimer();
    refreshScrubberButtons();
  }

  function stepBy(delta) {
    pause();
    if (!events.length) return;
    state.index = Math.max(0, Math.min(events.length - 1, state.index + delta));
    refreshPanes();
    updateScrubber();
  }

  // Build scrubber UI
  const btnBack = el("button", {
    type: "button",
    class: "replay-btn",
    "aria-label": "Step back",
    text: "◀◀",
    onclick: () => stepBy(-1),
  });
  const btnPlay = el("button", {
    type: "button",
    class: "replay-btn replay-btn-play",
    "aria-label": "Play",
    text: "▶",
    onclick: () => (state.playing ? pause() : play()),
  });
  const btnFwd = el("button", {
    type: "button",
    class: "replay-btn",
    "aria-label": "Step forward",
    text: "▶▶",
    onclick: () => stepBy(1),
  });
  const speedSelect = el("select", {
    class: "replay-speed",
    "aria-label": "Playback speed",
    onchange: (e) => {
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0) {
        state.speed = v;
        if (state.playing) {
          stopTimer();
          state.timer = setTimeout(
            tick,
            Math.max(50, Math.round(DEFAULT_STEP_MS / state.speed)),
          );
        }
      }
    },
  });
  for (const s of SPEEDS) {
    const opt = el("option", { value: String(s), text: `${s}x` });
    if (s === 1) opt.selected = true;
    speedSelect.appendChild(opt);
  }
  const seek = el("input", {
    type: "range",
    class: "replay-seek",
    min: "0",
    max: String(Math.max(0, events.length - 1)),
    step: "1",
    value: String(Math.max(0, state.index)),
    "aria-label": "Seek",
    oninput: (e) => {
      pause();
      state.index = Number(e.target.value);
      refreshPanes();
      updateScrubber();
    },
  });
  const position = el("span", { class: "replay-position", text: "0 / 0" });

  scrubber.append(btnBack, btnPlay, btnFwd, seek, position, speedSelect);

  function refreshScrubberButtons() {
    btnPlay.textContent = state.playing ? "❚❚" : "▶";
    btnPlay.setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }

  function updateScrubber() {
    seek.max = String(Math.max(0, events.length - 1));
    seek.value = String(Math.max(0, state.index));
    position.textContent = `${Math.max(0, state.index) + (events.length ? 1 : 0)} / ${events.length}`;
    refreshScrubberButtons();
  }

  refreshPanes();
  updateScrubber();

  return () => {
    try { abort.abort(); } catch (_) { /* noop */ }
    stopTimer();
    try { globalThis.SiskelbotShell?.inspector?.clear(); } catch (_) { /* noop */ }
    try { root.replaceChildren(); } catch (_) { /* noop */ }
  };
}

export default { mount };
