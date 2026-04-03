const bootstrap = window.__BOOTSTRAP__;

const state = {
  selectedTarget: "",
  snapshot: null,
  tree: null,
  stream: null,
  layoutKey: "",
};

const paneTerminals = new Map();

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
  min: 0.2,
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

      if (windowInfo.panes.length > 1) {
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
      }

      sessionCard.appendChild(windowBlock);
    }

    treeEl.appendChild(sessionCard);
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.panes) || snapshot.panes.length === 0) {
    disposePaneTerminals();
    state.layoutKey = "";
    panesEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No tmux panes available.";
    panesEl.appendChild(empty);
    return;
  }

  const layoutKey = snapshotLayoutKey(snapshot);
  const existingLayout = panesEl.querySelector(".tmux-layout");
  if (!existingLayout || state.layoutKey !== layoutKey) {
    buildSnapshotLayout(snapshot, layoutKey);
    return;
  }

  updatePaneTerminals(snapshot);
  alignSnapshotView(existingLayout, snapshot);
}

function buildSnapshotLayout(snapshot, layoutKey) {
  disposePaneTerminals();
  panesEl.innerHTML = "";

  const scene = document.createElement("section");
  scene.className = "tmux-scene";

  const viewport = document.createElement("div");
  viewport.className = "tmux-viewport";

  const totalCols = snapshot.panes.reduce((max, pane) => Math.max(max, pane.left + pane.width), 1);
  const totalRows = snapshot.panes.reduce((max, pane) => Math.max(max, pane.top + pane.height), 1);

  const shell = document.createElement("div");
  shell.className = "tmux-layout-shell";

  const layout = document.createElement("div");
  layout.className = "tmux-layout";
  layout.style.setProperty("--layout-cols", String(totalCols));
  layout.style.setProperty("--layout-rows", String(totalRows));

  for (const pane of snapshot.panes) {
    const paneEl = document.createElement("article");
    paneEl.className = `tmux-pane ${pane.active ? "active" : ""}`;
    paneEl.style.setProperty("--pane-left", String(pane.left));
    paneEl.style.setProperty("--pane-top", String(pane.top));
    paneEl.style.setProperty("--pane-width", String(pane.width));
    paneEl.style.setProperty("--pane-height", String(pane.height));

    const title = document.createElement("div");
    title.className = "tmux-pane-title";
    title.textContent = pane.title || pane.target || "Pane";
    paneEl.appendChild(title);

    const body = document.createElement("div");
    body.className = "tmux-pane-body";

    const host = document.createElement("div");
    host.className = "xterm-host";
    body.appendChild(host);
    paneEl.appendChild(body);
    layout.appendChild(paneEl);

    const terminalState = createPaneTerminal(host, pane);
    paneTerminals.set(pane.target, terminalState);
  }

  shell.appendChild(layout);
  viewport.appendChild(shell);
  scene.appendChild(viewport);
  panesEl.appendChild(scene);
  state.layoutKey = layoutKey;

  alignSnapshotView(layout, snapshot);
}

function updatePaneTerminals(snapshot) {
  for (const pane of snapshot.panes) {
    const terminalState = paneTerminals.get(pane.target);
    if (!terminalState) {
      continue;
    }
    terminalState.term.reset();
    terminalState.term.resize(Math.max(pane.width, 2), Math.max(pane.height, 1));
    terminalState.term.write(buildTerminalFrame(pane));
    updateCursorOverlay(terminalState, pane);
  }
}

function disposePaneTerminals() {
  for (const terminalState of paneTerminals.values()) {
    terminalState.term.dispose();
  }
  paneTerminals.clear();
}

function alignSnapshotView(layout, snapshot) {
  const viewport = layout.closest(".tmux-viewport");
  const shell = layout.closest(".tmux-layout-shell");
  if (!viewport || !shell) {
    return;
  }
  requestAnimationFrame(() => {
    fitLayoutToViewport(viewport, shell, layout);
    for (const [index, pane] of snapshot.panes.entries()) {
      const paneEl = layout.children[index];
      const body = paneEl?.querySelector(".tmux-pane-body");
      if (body) {
        alignPaneToCursor(body, pane.cursorY || 0);
      }
      const terminalState = paneTerminals.get(pane.target);
      if (terminalState) {
        updateCursorOverlay(terminalState, pane);
      }
    }
  });
}

function snapshotLayoutKey(snapshot) {
  return snapshot.panes
    .map((pane) => `${pane.target}:${pane.left},${pane.top},${pane.width},${pane.height}`)
    .join("|");
}

function createPaneTerminal(host, pane) {
  const term = new Terminal({
    cols: Math.max(pane.width, 2),
    rows: Math.max(pane.height, 1),
    allowTransparency: true,
    convertEol: false,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "block",
    disableStdin: true,
    drawBoldTextInBrightColors: true,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
    fontSize: scaledFontSize(),
    lineHeight: 1,
    scrollback: 0,
    theme: {
      background: "#0f1418",
      foreground: "#eef6ff",
      black: "#101418",
      red: "#ff3b30",
      green: "#00e676",
      yellow: "#ffd400",
      blue: "#248bff",
      magenta: "#ff2bd6",
      cyan: "#00e5ff",
      white: "#eef6ff",
      brightBlack: "#56616c",
      brightRed: "#ff6b60",
      brightGreen: "#4dff9f",
      brightYellow: "#ffe24d",
      brightBlue: "#5fa8ff",
      brightMagenta: "#ff6ee6",
      brightCyan: "#52f1ff",
      brightWhite: "#ffffff",
      cursor: "#8bd3ff",
      cursorAccent: "#0f1418",
      selectionBackground: "rgba(139, 211, 255, 0.18)",
    },
  });
  term.open(host);
  term.resize(Math.max(pane.width, 2), Math.max(pane.height, 1));
  term.write(buildTerminalFrame(pane));
  const cursor = document.createElement("div");
  cursor.className = "tmux-cursor-overlay";
  host.appendChild(cursor);
  const terminalState = { term, host, cursor };
  updateCursorOverlay(terminalState, pane);
  return terminalState;
}

function buildTerminalFrame(pane) {
  const content = (pane.lines || []).join("\r\n");
  const row = clamp((pane.cursorY || 0) + 1, 1, Math.max(pane.height, 1));
  const col = clamp((pane.cursorX || 0) + 1, 1, Math.max(pane.width, 1));
  const cursor = pane.active ? `\u001b[?25h\u001b[${row};${col}H` : "\u001b[?25l";
  return `\u001b[0m\u001b[2J\u001b[H${content}${cursor}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function scaledFontSize() {
  return Math.max(8, 14 * zoom.value);
}

function updateCursorOverlay(terminalState, pane) {
  const { term, cursor, host } = terminalState;
  if (!pane.active) {
    cursor.hidden = true;
    return;
  }
  const cell = term?._core?._renderService?.dimensions?.css?.cell;
  if (!cell || !cell.width || !cell.height) {
    cursor.hidden = true;
    return;
  }
  const hostStyle = window.getComputedStyle(host);
  const paddingLeft = parseFloat(hostStyle.paddingLeft) || 0;
  const paddingTop = parseFloat(hostStyle.paddingTop) || 0;
  cursor.hidden = false;
  cursor.style.left = `${paddingLeft + Math.max(0, pane.cursorX || 0) * cell.width}px`;
  cursor.style.top = `${paddingTop + Math.max(0, pane.cursorY || 0) * cell.height}px`;
  cursor.style.width = `${cell.width}px`;
  cursor.style.height = `${cell.height}px`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function applyStatePayload(payload) {
  if (payload.tree) {
    state.tree = payload.tree;
    renderTree();
  }
  if (!payload.snapshot) {
    return;
  }
  state.snapshot = payload.snapshot;
  state.selectedTarget = payload.selectedTarget || payload.snapshot.target || "";
  targetLabelEl.textContent = state.selectedTarget || "No target selected";
  sidebarSelectedEl.textContent = state.selectedTarget || "No target selected";
  setStatus(payload.retargeted ? `Retargeted to ${state.selectedTarget}` : `Updated ${new Date().toLocaleTimeString()}`);
  renderSnapshot(payload.snapshot);
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
  if (state.snapshot) {
    renderSnapshot(state.snapshot);
  }
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

function alignPaneToCursor(body, cursorY) {
  const screen = body.querySelector(".xterm-screen");
  if (!screen) {
    return;
  }
  const lineHeight = parseFloat(window.getComputedStyle(screen).lineHeight) || screen.getBoundingClientRect().height || 16;
  const nextScrollTop = Math.max(0, cursorY * lineHeight - body.clientHeight + lineHeight * 2);
  body.scrollTop = nextScrollTop;
}

function fitLayoutToViewport(viewport, shell, layout) {
  layout.style.removeProperty("--fit-scale");
  shell.style.removeProperty("width");
  shell.style.removeProperty("height");

  const viewportWidth = Math.max(viewport.clientWidth - 2, 1);
  const viewportHeight = Math.max(viewport.clientHeight - 2, 1);
  const layoutWidth = Math.max(layout.scrollWidth, 1);
  const layoutHeight = Math.max(layout.scrollHeight, 1);
  const fitScale = Math.max(0.1, Math.min(viewportWidth / layoutWidth, viewportHeight / layoutHeight));

  layout.style.setProperty("--fit-scale", String(fitScale));
  shell.style.width = `${Math.ceil(layoutWidth * fitScale)}px`;
  shell.style.height = `${Math.ceil(layoutHeight * fitScale)}px`;
}

window.addEventListener("resize", () => {
  applySidebarCollapsed(loadSidebarCollapsed());
  applySidebarWidth(loadSidebarWidth());
  if (state.snapshot) {
    renderSnapshot(state.snapshot);
  }
});

init();
