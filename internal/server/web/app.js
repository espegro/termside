const bootstrap = window.__BOOTSTRAP__;

const state = {
  selectedTarget: "",
  tree: null,
  stream: null,
};

const treeEl = document.getElementById("tree");
const panesEl = document.getElementById("panes");
const targetLabelEl = document.getElementById("target-label");
const statusEl = document.getElementById("status");
const shutdownBannerEl = document.getElementById("shutdown-banner");
const treeSummaryEl = document.getElementById("tree-summary");
const sidebarSelectedEl = document.getElementById("sidebar-selected");
const refreshButton = document.getElementById("refresh-button");
const fullscreenButton = document.getElementById("fullscreen-button");
const zoomOutButton = document.getElementById("zoom-out-button");
const zoomResetButton = document.getElementById("zoom-reset-button");
const zoomInButton = document.getElementById("zoom-in-button");
const sidebarMinButton = document.getElementById("sidebar-min-button");
const sidebarResizer = document.getElementById("sidebar-resizer");
const layoutEl = document.querySelector(".layout");

const zoom = {
  min: 0.35,
  max: 1.75,
  step: 0.05,
  value: 1,
};

refreshButton.addEventListener("click", () => loadView());
fullscreenButton.addEventListener("click", () => toggleFullscreen());
zoomOutButton.addEventListener("click", () => adjustZoom(-zoom.step));
zoomResetButton.addEventListener("click", () => setZoom(1));
zoomInButton.addEventListener("click", () => adjustZoom(zoom.step));
sidebarMinButton.addEventListener("click", () => toggleSidebarCollapsed());
sidebarResizer.addEventListener("pointerdown", startSidebarResize);

async function init() {
  applyZoom();
  applySidebarCollapsed(loadSidebarCollapsed());
  applySidebarWidth(loadSidebarWidth());
  await loadTree();
  await loadView();
  startStream();
}

async function loadTree() {
  const res = await fetch(`${bootstrap.apiBase}/tree`, { credentials: "same-origin" });
  if (res.status === 503) {
    await handleShutdownResponse(res);
    return false;
  }
  if (!res.ok) {
    setStatus("Failed to load tmux tree");
    return false;
  }
  state.tree = await res.json();
  renderTree();
  return true;
}

async function loadView(target = state.selectedTarget) {
  const query = target ? `?target=${encodeURIComponent(target)}` : "";
  const res = await fetch(`${bootstrap.apiBase}/view${query}`, { credentials: "same-origin" });
  if (res.status === 503) {
    await handleShutdownResponse(res);
    return false;
  }
  if (!res.ok) {
    setStatus("Failed to load tmux view");
    return false;
  }
  const payload = await res.json();
  applyStatePayload(payload);
  return true;
}

async function selectTarget(target) {
  const res = await fetch(`${bootstrap.apiBase}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ target }),
  });
  if (res.status === 503) {
    await handleShutdownResponse(res);
    return;
  }
  if (!res.ok) {
    setStatus("Failed to change target");
    return;
  }
  state.selectedTarget = target;
  await loadView(target);
}

function startStream() {
  stopRefresh();
  const stream = new EventSource(`${bootstrap.apiBase}/events`);
  state.stream = stream;
  stream.addEventListener("state", (event) => {
    const payload = JSON.parse(event.data);
    applyStatePayload(payload);
  });
  stream.addEventListener("shutdown", (event) => {
    const payload = JSON.parse(event.data);
    stopRefresh();
    shutdownBannerEl.hidden = false;
    shutdownBannerEl.textContent = payload.message || "Connection to the terminal host was closed.";
    setStatus(shutdownBannerEl.textContent);
  });
  stream.addEventListener("error", () => {
    if (shutdownBannerEl.hidden) {
      setStatus("Waiting for server updates…");
    }
  });
}

function renderTree() {
  if (!state.tree) {
    return;
  }
  updateTreeSummary();
  treeEl.innerHTML = "";
  for (const session of state.tree.sessions) {
    const sessionCard = document.createElement("section");
    sessionCard.className = "session-card";

    const sessionTitle = document.createElement("h3");
    sessionTitle.textContent = session.name;
    sessionCard.appendChild(sessionTitle);

    for (const windowInfo of session.windows) {
      const windowBlock = document.createElement("div");
      windowBlock.className = "window-block";

      const windowTitle = document.createElement("button");
      windowTitle.className = `pane-button window-title ${state.selectedTarget === windowInfo.target ? "active" : ""}`;
      windowTitle.textContent = `${windowInfo.index}: ${windowInfo.name}`;
      windowTitle.title = windowInfo.target;
      windowTitle.addEventListener("click", () => selectTarget(windowInfo.target));
      windowBlock.appendChild(windowTitle);

      const paneList = document.createElement("div");
      paneList.className = "pane-list";
      for (const pane of windowInfo.panes) {
        const button = document.createElement("button");
        button.className = `pane-button ${state.selectedTarget === pane.target ? "active" : ""}`;
        button.textContent = pane.title || `Pane ${pane.index}`;
        button.title = pane.target;
        button.addEventListener("click", () => selectTarget(pane.target));
        paneList.appendChild(button);
      }
      windowBlock.appendChild(paneList);
      sessionCard.appendChild(windowBlock);
    }

    treeEl.appendChild(sessionCard);
  }
}

function renderSnapshot(snapshot) {
  panesEl.innerHTML = "";
  const paneCount = Math.max(snapshot.panes.length, 1);
  panesEl.style.setProperty("--pane-count", String(paneCount));
  for (const pane of snapshot.panes) {
    const paneEl = document.createElement("article");
    paneEl.className = "pane";

    const header = document.createElement("div");
    header.className = "pane-header";

    const title = document.createElement("div");
    title.className = "pane-title";
    title.textContent = pane.title || pane.target;
    header.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "pane-meta";
    meta.textContent = `${pane.width}x${pane.height}${pane.active ? " active" : ""}`;
    header.appendChild(meta);
    paneEl.appendChild(header);

    const viewport = document.createElement("div");
    viewport.className = "pane-viewport";

    const pre = document.createElement("pre");
    pre.innerHTML = renderAnsiToHTML((pane.lines || []).join("\n"));
    viewport.appendChild(pre);
    paneEl.appendChild(viewport);
    panesEl.appendChild(paneEl);
    alignViewportToCursor(viewport, pane.cursorY);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
}

function applyStatePayload(payload) {
  if (payload.tree) {
    state.tree = payload.tree;
    renderTree();
  }
  const snapshot = payload.snapshot || payload;
  if (!snapshot || !snapshot.target) {
    return;
  }
  state.selectedTarget = snapshot.target;
  targetLabelEl.textContent = snapshot.target;
  sidebarSelectedEl.textContent = snapshot.target;
  setStatus(payload.retargeted ? `Retargeted to ${snapshot.target}` : `Updated ${new Date().toLocaleTimeString()}`);
  renderSnapshot(snapshot);
  if (state.tree) {
    renderTree();
  }
}

async function handleShutdownResponse(res) {
  let message = "Connection to the terminal host was closed.";
  try {
    const payload = await res.json();
    if (payload && payload.message) {
      message = payload.message;
    }
  } catch {}
  stopRefresh();
  shutdownBannerEl.hidden = false;
  shutdownBannerEl.textContent = message;
  setStatus(message);
}

function updateTreeSummary() {
  let windowCount = 0;
  let paneCount = 0;
  for (const session of state.tree.sessions) {
    windowCount += session.windows.length;
    for (const windowInfo of session.windows) {
      paneCount += windowInfo.panes.length;
    }
  }
  treeSummaryEl.textContent = `${state.tree.sessions.length} sessions · ${windowCount} windows · ${paneCount} panes`;
}

function adjustZoom(delta) {
  setZoom(zoom.value + delta);
}

function setZoom(nextValue) {
  zoom.value = Math.max(zoom.min, Math.min(zoom.max, Number(nextValue.toFixed(2))));
  applyZoom();
}

function applyZoom() {
  document.documentElement.style.setProperty("--terminal-scale", String(zoom.value));
  setStatus(`Zoom ${Math.round(zoom.value * 100)}%`);
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  } catch {
    setStatus("Fullscreen is not available in this browser.");
  }
}

function stopRefresh() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function loadSidebarWidth() {
  const saved = Number(window.localStorage.getItem("termside.sidebar.width"));
  if (Number.isFinite(saved) && saved >= 180 && saved <= 420) {
    return saved;
  }
  return null;
}

function loadSidebarCollapsed() {
  return window.localStorage.getItem("termside.sidebar.collapsed") === "1";
}

function applySidebarWidth(width) {
  if (!width || window.innerWidth <= 700 || layoutEl.classList.contains("sidebar-collapsed")) {
    layoutEl.style.removeProperty("--sidebar-width");
    return;
  }
  layoutEl.style.setProperty("--sidebar-width", `${width}px`);
}

function setSidebarMinimumMode() {
  const width = 180;
  applySidebarWidth(width);
  window.localStorage.setItem("termside.sidebar.width", String(width));
}

function toggleSidebarCollapsed() {
  const next = !layoutEl.classList.contains("sidebar-collapsed");
  applySidebarCollapsed(next);
  window.localStorage.setItem("termside.sidebar.collapsed", next ? "1" : "0");
}

function applySidebarCollapsed(collapsed) {
  layoutEl.classList.toggle("sidebar-collapsed", collapsed && window.innerWidth > 700);
  sidebarMinButton.textContent = collapsed && window.innerWidth > 700 ? "▣" : "◧";
  sidebarMinButton.setAttribute("aria-label", collapsed ? "Expand navigation" : "Minimize navigation");
}

function startSidebarResize(event) {
  if (window.innerWidth <= 700 || layoutEl.classList.contains("sidebar-collapsed")) {
    return;
  }
  event.preventDefault();
  document.body.classList.add("is-resizing");

  function onMove(moveEvent) {
    const min = 180;
    const max = Math.min(420, Math.max(min, window.innerWidth - 280));
    const width = Math.min(max, Math.max(min, moveEvent.clientX));
    applySidebarWidth(width);
    window.localStorage.setItem("termside.sidebar.width", String(width));
  }

  function onUp() {
    document.body.classList.remove("is-resizing");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
  }

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function alignViewportToCursor(viewport, cursorY) {
  const pre = viewport.querySelector("pre");
  if (!pre) {
    return;
  }
  const lineHeight = parseFloat(window.getComputedStyle(pre).lineHeight) || 16;
  const nextScrollTop = Math.max(0, cursorY * lineHeight - viewport.clientHeight + lineHeight * 2);
  viewport.scrollTop = nextScrollTop;
}

function renderAnsiToHTML(input) {
  const state = {
    fg: "",
    bg: "",
    bold: false,
  };
  let html = "";
  let text = "";

  function flush() {
    if (!text) {
      return;
    }
    const styles = [];
    if (state.fg) styles.push(`color:${state.fg}`);
    if (state.bg) styles.push(`background-color:${state.bg}`);
    if (state.bold) styles.push("font-weight:700");
    const escaped = escapeHTML(text);
    html += styles.length ? `<span style="${styles.join(";")}">${escaped}</span>` : escaped;
    text = "";
  }

  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === "\u001b" && input[i + 1] === "[") {
      flush();
      const end = input.indexOf("m", i + 2);
      if (end === -1) {
        break;
      }
      applySgr(state, input.slice(i + 2, end));
      i = end;
      continue;
    }
    text += input[i];
  }
  flush();
  return html;
}

function applySgr(state, raw) {
  const codes = raw === "" ? [0] : raw.split(";").map((part) => Number(part || 0));
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) {
      state.fg = "";
      state.bg = "";
      state.bold = false;
    } else if (code === 1) {
      state.bold = true;
    } else if (code === 22) {
      state.bold = false;
    } else if (code === 39) {
      state.fg = "";
    } else if (code === 49) {
      state.bg = "";
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      state.fg = ansiColor(code);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state.bg = ansiColor(code);
    } else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) {
      const color = ansi256Color(codes[i + 2]);
      if (code === 38) state.fg = color;
      if (code === 48) state.bg = color;
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && Number.isInteger(codes[i + 2]) && Number.isInteger(codes[i + 3]) && Number.isInteger(codes[i + 4])) {
      const color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
      if (code === 38) state.fg = color;
      if (code === 48) state.bg = color;
      i += 4;
    }
  }
}

function ansiColor(code) {
  const palette = {
    30: "#1b1f23",
    31: "#ff7b72",
    32: "#7ee787",
    33: "#f2cc60",
    34: "#79c0ff",
    35: "#d2a8ff",
    36: "#56d4dd",
    37: "#c9d1d9",
    40: "#1b1f23",
    41: "#ff7b72",
    42: "#7ee787",
    43: "#f2cc60",
    44: "#79c0ff",
    45: "#d2a8ff",
    46: "#56d4dd",
    47: "#c9d1d9",
    90: "#6e7681",
    91: "#ffa198",
    92: "#56d364",
    93: "#e3b341",
    94: "#79c0ff",
    95: "#bc8cff",
    96: "#39c5cf",
    97: "#f0f6fc",
    100: "#6e7681",
    101: "#ffa198",
    102: "#56d364",
    103: "#e3b341",
    104: "#79c0ff",
    105: "#bc8cff",
    106: "#39c5cf",
    107: "#f0f6fc",
  };
  return palette[code] || "";
}

function ansi256Color(code) {
  if (code < 16) {
    const base = [
      "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
      "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
    ];
    return base[code];
  }
  if (code >= 232) {
    const value = 8 + (code - 232) * 10;
    return `rgb(${value}, ${value}, ${value})`;
  }
  const n = code - 16;
  const r = Math.floor(n / 36);
  const g = Math.floor((n % 36) / 6);
  const b = n % 6;
  const channel = [0, 95, 135, 175, 215, 255];
  return `rgb(${channel[r]}, ${channel[g]}, ${channel[b]})`;
}

function escapeHTML(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

window.addEventListener("resize", () => {
  applySidebarCollapsed(loadSidebarCollapsed());
  applySidebarWidth(loadSidebarWidth());
});

init();
