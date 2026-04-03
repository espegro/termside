const bootstrap = window.__BOOTSTRAP__;

const state = {
  selectedTarget: "",
  snapshot: null,
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
  panesEl.innerHTML = "";
  if (!snapshot || !Array.isArray(snapshot.panes) || snapshot.panes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No tmux panes available.";
    panesEl.appendChild(empty);
    return;
  }

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

    const content = document.createElement("div");
    content.className = "tmux-pane-content";

    const pre = document.createElement("pre");
    pre.innerHTML = renderAnsiToHTML((pane.lines || []).join("\n"));
    content.appendChild(pre);

    if (pane.active) {
      const cursor = document.createElement("div");
      cursor.className = "tmux-cursor";
      cursor.dataset.cursorX = String(pane.cursorX || 0);
      cursor.dataset.cursorY = String(pane.cursorY || 0);
      content.appendChild(cursor);
    }

    body.appendChild(content);
    paneEl.appendChild(body);
    layout.appendChild(paneEl);
  }

  shell.appendChild(layout);
  viewport.appendChild(shell);
  scene.appendChild(viewport);
  panesEl.appendChild(scene);

  requestAnimationFrame(() => {
    fitLayoutToViewport(viewport, shell, layout);
    for (const [index, pane] of snapshot.panes.entries()) {
      const paneEl = layout.children[index];
      const body = paneEl?.querySelector(".tmux-pane-body");
      if (body) {
        alignPaneToCursor(body, pane.cursorY || 0);
      }
      if (pane.active) {
        positionPaneCursor(paneEl);
      }
    }
  });
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
  const pre = body.querySelector("pre");
  if (!pre) {
    return;
  }
  const lineHeight = parseFloat(window.getComputedStyle(pre).lineHeight) || 16;
  const nextScrollTop = Math.max(0, cursorY * lineHeight - body.clientHeight + lineHeight * 2);
  body.scrollTop = nextScrollTop;
}

function positionPaneCursor(paneEl) {
  const content = paneEl?.querySelector(".tmux-pane-content");
  const pre = paneEl?.querySelector("pre");
  const cursor = paneEl?.querySelector(".tmux-cursor");
  const layout = paneEl?.closest(".tmux-layout");
  if (!content || !pre || !cursor) {
    return;
  }

  const measure = document.createElement("span");
  measure.className = "cursor-measure";
  measure.textContent = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
  content.appendChild(measure);

  const fitScale = Number.parseFloat(window.getComputedStyle(layout || paneEl).getPropertyValue("--fit-scale")) || 1;
  const rect = measure.getBoundingClientRect();
  const glyphCount = measure.textContent.length || 1;
  const cellWidth = Math.max(rect.width / fitScale / glyphCount, 1);
  const cellHeight = Math.max(rect.height / fitScale, 1);
  measure.remove();

  const preStyles = window.getComputedStyle(pre);
  const paddingLeft = parseFloat(preStyles.paddingLeft) || 0;
  const paddingTop = parseFloat(preStyles.paddingTop) || 0;
  const cursorX = Number(cursor.dataset.cursorX || "0");
  const cursorY = Number(cursor.dataset.cursorY || "0");

  cursor.style.left = `${paddingLeft + cursorX * cellWidth}px`;
  cursor.style.top = `${paddingTop + cursorY * cellHeight}px`;
  cursor.style.width = `${cellWidth}px`;
  cursor.style.height = `${cellHeight}px`;
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

function renderAnsiToHTML(input) {
  const sgr = {
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
    if (sgr.fg) styles.push(`color:${sgr.fg}`);
    if (sgr.bg) styles.push(`background-color:${sgr.bg}`);
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
      applySgr(sgr, input.slice(i + 2, end));
      i = end;
      continue;
    }
    text += input[i];
  }
  flush();
  return html;
}

function applySgr(sgr, raw) {
  const codes = raw === "" ? [0] : raw.split(";").map((part) => Number(part || 0));
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i];
    if (code === 0) {
      sgr.fg = "";
      sgr.bg = "";
      sgr.bold = false;
    } else if (code === 1) {
      sgr.bold = true;
    } else if (code === 22) {
      sgr.bold = false;
    } else if (code === 39) {
      sgr.fg = "";
    } else if (code === 49) {
      sgr.bg = "";
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      sgr.fg = ansiColor(code);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      sgr.bg = ansiColor(code);
    } else if ((code === 38 || code === 48) && codes[i + 1] === 5 && Number.isInteger(codes[i + 2])) {
      const color = ansi256Color(codes[i + 2]);
      if (code === 38) sgr.fg = color;
      if (code === 48) sgr.bg = color;
      i += 2;
    } else if ((code === 38 || code === 48) && codes[i + 1] === 2 && Number.isInteger(codes[i + 2]) && Number.isInteger(codes[i + 3]) && Number.isInteger(codes[i + 4])) {
      const color = `rgb(${codes[i + 2]}, ${codes[i + 3]}, ${codes[i + 4]})`;
      if (code === 38) sgr.fg = color;
      if (code === 48) sgr.bg = color;
      i += 4;
    }
  }
}

function ansiColor(code) {
  const palette = {
    30: "#101418",
    31: "#ff3b30",
    32: "#00e676",
    33: "#ffd400",
    34: "#248bff",
    35: "#ff2bd6",
    36: "#00e5ff",
    37: "#eef6ff",
    40: "#101418",
    41: "#ff3b30",
    42: "#00e676",
    43: "#ffd400",
    44: "#248bff",
    45: "#ff2bd6",
    46: "#00e5ff",
    47: "#eef6ff",
    90: "#56616c",
    91: "#ff6b60",
    92: "#4dff9f",
    93: "#ffe24d",
    94: "#5fa8ff",
    95: "#ff6ee6",
    96: "#52f1ff",
    97: "#ffffff",
    100: "#56616c",
    101: "#ff6b60",
    102: "#4dff9f",
    103: "#ffe24d",
    104: "#5fa8ff",
    105: "#ff6ee6",
    106: "#52f1ff",
    107: "#ffffff",
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
  const viewport = document.querySelector(".tmux-viewport");
  const shell = document.querySelector(".tmux-layout-shell");
  const layout = document.querySelector(".tmux-layout");
  if (viewport && shell && layout) {
    fitLayoutToViewport(viewport, shell, layout);
  }
  document.querySelectorAll(".tmux-pane.active").forEach((paneEl) => positionPaneCursor(paneEl));
});

init();
