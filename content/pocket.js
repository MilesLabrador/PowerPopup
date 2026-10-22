// Edge pocket: a slim handle pinned to the right edge of every page. Clicking
// it drops a floating column of navigation chips — your pinned (starred)
// items plus a launcher shortcut — with no backdrop panel behind them.
// On by default on every page; Alt+Shift+O opens/closes the chip menu.
// Can be turned off entirely via the options page.

(() => {
  const api = globalThis.browser ?? chrome;
  if (window.top !== window) return; // no pockets inside iframes

  let host = null;
  let open = false;

  // Mirrors the kind colors in popup/popup.css so a pinned item's dot matches
  // the badge color it had in the launcher (flow/solution/table/app/etc).
  const KIND_COLORS = {
    "kind-flow": "#4f8cff",
    "kind-solution": "#d64ac9",
    "kind-table": "#2ea043",
    "kind-app": "#e0a030",
    "kind-webresource": "#d6c945",
    "kind-plugin": "#d64545",
  };

  function build() {
    host = document.createElement("div");
    host.id = "powerpopup-pocket";
    const shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      .handle {
        position: fixed;
        right: 0;
        top: var(--pe-top, 40vh);
        z-index: 2147483646;
        writing-mode: vertical-rl;
        background: #8a2be2;
        color: #fff;
        font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
        padding: 10px 4px;
        border-radius: 8px 0 0 8px;
        cursor: pointer;
        opacity: 0.35;
        transition: opacity 0.15s;
        user-select: none;
        letter-spacing: 0.08em;
      }
      .handle:hover { opacity: 1; }
      .menu {
        position: fixed;
        right: 30px;
        z-index: 2147483647;
        display: none;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        max-height: 70vh;
        overflow-y: auto;
        padding: 4px;
        scrollbar-width: none;
      }
      .menu::-webkit-scrollbar { display: none; }
      .menu.open { display: flex; }
      .item {
        background: rgba(30, 30, 46, 0.94);
        color: #e6e6f0;
        font: 500 12.5px/1 "Segoe UI", system-ui, sans-serif;
        padding: 8px 14px;
        border-radius: 999px;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        max-width: 320px;
        overflow: hidden;
        text-overflow: ellipsis;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
        transform: translateX(6px);
        opacity: 0;
        animation: pe-in 0.14s ease-out forwards;
      }
      .item:hover { background: #8a2be2; color: #fff; }
      .item.launcher { color: #b06cf0; font-weight: 600; }
      .item.launcher:hover { color: #fff; }
      .item.hint { font-style: italic; color: #9a9ab0; cursor: default; }
      .item.hint:hover { background: rgba(30, 30, 46, 0.94); }
      @keyframes pe-in {
        to { transform: translateX(0); opacity: 1; }
      }
    `;

    const handle = document.createElement("div");
    handle.className = "handle";
    handle.textContent = "⚡ POWER";
    handle.title = "PowerPopup (drag to move, click for pinned items)";

    const menu = document.createElement("div");
    menu.className = "menu";

    // Drag the handle vertically; a click (no movement) opens the menu.
    let dragStartY = null, startTop = null, moved = false;
    handle.addEventListener("pointerdown", (e) => {
      dragStartY = e.clientY;
      startTop = handle.getBoundingClientRect().top;
      moved = false;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener("pointermove", (e) => {
      if (dragStartY === null) return;
      const dy = e.clientY - dragStartY;
      if (Math.abs(dy) > 4) moved = true;
      if (moved) {
        const top = Math.min(window.innerHeight - 80, Math.max(0, startTop + dy));
        handle.style.setProperty("--pe-top", `${top}px`);
        handle.style.top = `${top}px`;
      }
    });
    handle.addEventListener("pointerup", () => {
      dragStartY = null;
      if (!moved) toggle();
    });

    document.addEventListener("pointerdown", (e) => {
      if (open && !e.composedPath().includes(host)) toggle(false);
    }, true);
    document.addEventListener("keydown", (e) => {
      if (open && e.key === "Escape") toggle(false);
    }, true);

    shadow.append(style, handle, menu);
    document.documentElement.appendChild(host);

    host._menu = menu;
    host._handle = handle;
  }

  function chip(label, cls, onClick, delay, kindColor) {
    const item = document.createElement("div");
    item.className = `item${cls ? ` ${cls}` : ""}`;
    if (kindColor) {
      const dot = document.createElement("span");
      dot.textContent = "● ";
      dot.style.color = kindColor;
      item.appendChild(dot);
    }
    item.appendChild(document.createTextNode(label));
    item.style.animationDelay = `${delay * 25}ms`;
    if (onClick) item.addEventListener("click", onClick);
    return item;
  }

  async function fillMenu() {
    const menu = host._menu;
    menu.replaceChildren();
    const { pins = [] } = await api.storage.local.get("pins");

    let i = 0;
    menu.appendChild(chip("⚡ Launcher", "launcher", () => {
      api.runtime.sendMessage({ type: "open", url: api.runtime.getURL("popup/popup.html") + "?pocket=1" });
      toggle(false);
    }, i++));

    for (const pin of pins) {
      menu.appendChild(chip(pin.label, "", () => {
        api.runtime.sendMessage({ type: "open", url: pin.url });
        toggle(false);
      }, i++, KIND_COLORS[pin.kind]));
    }
    if (!pins.length) {
      menu.appendChild(chip("Star items in the launcher to see them here", "hint", null, i++));
    }
  }

  function positionMenu() {
    const menu = host._menu;
    const rect = host._handle.getBoundingClientRect();
    // Drop below the handle top, clamped to the viewport.
    menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight * 0.3))}px`;
  }

  async function toggle(force) {
    if (!host) build();
    const menu = host._menu;
    const next = force !== undefined ? force : !open;
    if (next) {
      await fillMenu();
      positionMenu();
    }
    menu.classList.toggle("open", next);
    open = next;
  }

  function removePocket() {
    host?.remove();
    host = null;
    open = false;
  }

  api.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "togglePocket") {
      if (!host) build();
      toggle();
    }
  });

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.config) {
      const enabled = changes.config.newValue?.pocketEnabled !== false;
      if (enabled && !host) build();
      if (!enabled) removePocket();
    }
    // Live-update the open menu when pins change elsewhere.
    if (changes.pins && open) fillMenu();
  });

  api.storage.local.get("config").then(({ config = {} }) => {
    if (config.pocketEnabled !== false) build();
  });
})();
