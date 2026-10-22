// Popup UI: miller columns. Environments -> (Apps + Solutions) -> Components.
// Rows are grouped by kind into collapsible sections (collapsed by default);
// starred (pinned) items surface in an always-expanded "Pinned" group so
// they're ready without digging — that group's pencil switches it into an
// editor for renaming and drag-reordering. Also served inside the edge-pocket
// iframe (?pocket=1).

import { appUrls, componentUrl, solutionUrl, environmentHome } from "../lib/urls.js";

const api = globalThis.browser ?? chrome;
const isPocket = new URL(location.href).searchParams.get("pocket") === "1";
if (isPocket) document.body.classList.add("pocket");

const $ = (sel) => document.querySelector(sel);
const cols = [$("#col-envs"), $("#col-env"), $("#col-solution")];

let state = { envs: [], envRoles: {}, pins: [] };
let selection = { env: null, solution: null }; // env/solution objects
let activeCol = 0;
let lastEnvData = null; // cached payloads so re-renders (e.g. after pinning)
let lastComponents = null; // don't refetch

// Remembers which groups the user opened/closed, per column, across re-renders.
const groupState = [new Map(), new Map(), new Map()];

function send(msg) {
  return api.runtime.sendMessage(msg);
}

function setStatus(text, isError = false) {
  const el = $("#status");
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

function openUrl(url) {
  send({ type: "open", url });
  if (!isPocket) window.close();
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function isPinned(url) {
  return state.pins.some((p) => p.url === url);
}

/** Collapsible group: returns the body element rows get appended to. */
function group(colIdx, title, count, { defaultOpen = false, headExtra = null, kindCls = null } = {}) {
  const open = groupState[colIdx].get(title) ?? defaultOpen;
  const wrap = el("div", `group${open ? "" : " collapsed"}${kindCls ? ` ${kindCls}` : ""}`);
  const head = el("h3", "group-head");
  head.append(el("span", "gchev", "▸"), document.createTextNode(count != null ? `${title} (${count})` : title));
  if (headExtra) head.appendChild(headExtra);
  const body = el("div", "group-body");
  head.addEventListener("click", () => {
    const collapsed = wrap.classList.toggle("collapsed");
    groupState[colIdx].set(title, !collapsed);
  });
  wrap.append(head, body);
  cols[colIdx].appendChild(wrap);
  return body;
}

// ---------- solution sorting ----------

const SOLUTION_SORTS = {
  modified: { label: "Last modified", cmp: (a, b) => (b.modified || "").localeCompare(a.modified || "") },
  created: { label: "Date created", cmp: (a, b) => (b.created || "").localeCompare(a.created || "") },
  name: { label: "Name", cmp: (a, b) => a.name.localeCompare(b.name) },
};
let solutionSort = "modified";

function sortedSolutions(solutions) {
  // The server already returns modified-desc, so sorting is a stable no-op
  // for cached entries that predate the `modified` field.
  return [...solutions].sort(SOLUTION_SORTS[solutionSort]?.cmp || (() => 0));
}

function solutionSortSelect() {
  const sel = document.createElement("select");
  sel.className = "sort-sel";
  sel.title = "Sort solutions";
  for (const [key, { label }] of Object.entries(SOLUTION_SORTS)) {
    const opt = el("option", null, label);
    opt.value = key;
    if (key === solutionSort) opt.selected = true;
    sel.appendChild(opt);
  }
  // Don't let interacting with the select collapse the group.
  sel.addEventListener("click", (e) => e.stopPropagation());
  sel.addEventListener("change", (e) => {
    e.stopPropagation();
    solutionSort = sel.value;
    api.storage.local.set({ solutionSort });
    if (lastEnvData) { renderEnvDataColumn(lastEnvData); applyFilter(); }
  });
  return sel;
}

function row({ label, sub, badge, badgeCls, expandable, pinnable, url, onClick }) {
  const r = el("div", "row");
  r.dataset.filterText = `${label} ${sub || ""}`.toLowerCase();
  if (badge) {
    const b = el("span", `badge ${badgeCls || "other"}`, badge);
    r.appendChild(b);
  }
  const lab = el("span", "label", label);
  if (sub) {
    lab.appendChild(document.createTextNode(" "));
    lab.appendChild(el("span", "dim", sub));
  }
  r.appendChild(lab);

  const actions = el("span", "actions");
  if (pinnable && url) {
    const pinned = isPinned(url);
    const pinBtn = el("button", pinned ? "pin-on" : "", pinned ? "★" : "☆");
    pinBtn.title = pinned ? "Unpin" : "Pin to top";
    pinBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const pin = { label, url };
      if (badgeCls?.startsWith("kind-")) pin.kind = badgeCls;
      const res = await send({ type: "togglePin", pin });
      if (res.ok) { state.pins = res.pins; rerenderAll(); }
    });
    actions.appendChild(pinBtn);
  }
  r.appendChild(actions);

  if (expandable) r.appendChild(el("span", "chevron", "▶"));
  r.addEventListener("click", onClick);
  return r;
}

/**
 * A row inside an app's picker: one destination (editor or player). Clicking
 * the label opens it; the star independently favorites just that URL.
 */
function appChoice(pinLabel, openLabel, url) {
  const c = el("div", "pin-choice");
  const pinned = isPinned(url);
  const star = el("button", pinned ? "pin-on" : "", pinned ? "★" : "☆");
  star.title = pinned ? "Unpin" : "Pin to top";
  star.addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await send({ type: "togglePin", pin: { label: pinLabel, url, kind: "kind-app" } });
    if (res.ok) { state.pins = res.pins; rerenderAll(); }
  });
  const lab = el("span", "label", openLabel);
  c.append(star, lab);
  c.addEventListener("click", () => openUrl(url));
  return c;
}

// Apps have two destinations (the maker-portal editor and the app itself),
// so clicking the row expands a picker below it instead of jumping straight
// to one of them. Each choice can also be favorited independently.
function appRow(env, app, defaultSolutionId) {
  const urls = appUrls(env, app, defaultSolutionId);
  const wrap = el("div", "app-row-wrap");

  const picker = el("div", "pin-picker");
  picker.append(
    appChoice(`${app.name} — Editor`, "Open editor", urls.edit),
    appChoice(`${app.name} — App`, "Open app", urls.play)
  );

  const r = row({
    label: app.name,
    sub: app.kind === "canvas" ? "canvas" : "model-driven",
    badge: "App",
    badgeCls: "kind-app",
    expandable: true,
    onClick: () => picker.classList.toggle("open"),
  });
  const actions = r.querySelector(".actions");

  const play = el("button", "", "▶");
  play.title = "Open app";
  play.addEventListener("click", (e) => { e.stopPropagation(); openUrl(urls.play); });
  const edit = el("button", "", "✏");
  edit.title = "Open editor";
  edit.addEventListener("click", (e) => { e.stopPropagation(); openUrl(urls.edit); });
  actions.append(play, edit);

  wrap.append(r, picker);
  return wrap;
}

// ---------- pinned list: rename + drag-to-reorder ----------

// The pencil in the Pinned group's header turns the list into an editor:
// rows stop navigating and instead grow a drag handle and a rename button.
let pinEditing = false;

function pinEditToggle() {
  // U+270E, not U+270F — Windows gives the latter an emoji face that muddies
  // at this size.
  const btn = el("button", `pin-edit${pinEditing ? " on" : ""}`, "✎");
  btn.title = pinEditing ? "Done — click to stop editing" : "Rename & reorder pins";
  btn.addEventListener("click", (e) => {
    e.stopPropagation(); // don't collapse the group
    pinEditing = !pinEditing;
    if (pinEditing) groupState[0].set("Pinned", true);
    renderEnvColumn();
    applyFilter();
  });
  return btn;
}

function pinnedRow(pin, body) {
  const r = row({
    label: pin.label,
    badge: pin.kind ? KIND_LABEL_BY_CLS[pin.kind] : null,
    badgeCls: pin.kind,
    pinnable: true,
    url: pin.url,
    onClick: () => { if (!pinEditing) openUrl(pin.url); },
  });
  r.classList.add("pin-row");
  r.dataset.url = pin.url;
  if (pin.name) r.querySelector(".label").title = `Pinned as “${pin.name}”`;
  if (!pinEditing) return r;

  const handle = el("span", "drag-handle", "⠿");
  handle.title = "Drag to reorder";
  r.prepend(handle);

  const rename = el("button", null, "✎");
  rename.title = "Rename";
  rename.addEventListener("click", (e) => { e.stopPropagation(); startRename(r, pin); });
  r.querySelector(".actions").prepend(rename);

  // Pointer events rather than HTML5 drag-and-drop, matching how the pocket
  // handle drags (content/pocket.js): capture keeps the moves coming even
  // once the row has slid out from under the cursor.
  r.addEventListener("pointerdown", (e) => {
    // Buttons keep their clicks; the rename input keeps its caret.
    if (e.button !== 0 || e.target.closest("button, input")) return;
    e.preventDefault();
    startPinDrag(r, body, e.pointerId);
  });
  return r;
}

/** The row the dragged one should sit before, or null for the end of the list. */
function pinRowBefore(body, y) {
  for (const r of body.querySelectorAll(".pin-row:not(.dragging)")) {
    const box = r.getBoundingClientRect();
    if (y < box.top + box.height / 2) return r;
  }
  return null;
}

// The row is reordered in the DOM as the pointer moves, so what you see while
// dragging is the order that gets saved on release.
function startPinDrag(rowEl, body, pointerId) {
  rowEl.classList.add("dragging");
  rowEl.setPointerCapture(pointerId);

  const onMove = (e) => {
    const before = pinRowBefore(body, e.clientY);
    if (before !== rowEl && before !== rowEl.nextElementSibling) body.insertBefore(rowEl, before);
  };
  const onEnd = () => {
    rowEl.removeEventListener("pointermove", onMove);
    rowEl.removeEventListener("pointerup", onEnd);
    rowEl.removeEventListener("pointercancel", onEnd);
    rowEl.classList.remove("dragging");
    savePinOrder(body);
  };
  rowEl.addEventListener("pointermove", onMove);
  rowEl.addEventListener("pointerup", onEnd);
  rowEl.addEventListener("pointercancel", onEnd);
}

async function savePinOrder(body) {
  const urls = [...body.querySelectorAll(".pin-row")].map((r) => r.dataset.url);
  if (urls.join("\n") === state.pins.map((p) => p.url).join("\n")) return;
  const res = await send({ type: "reorderPins", urls });
  if (res.ok) { state.pins = res.pins; rerenderAll(); }
}

/** Swaps the row's label for an input. Enter/blur commits, Escape reverts,
 *  and an empty value restores the item's original name. */
function startRename(rowEl, pin) {
  const lab = rowEl.querySelector(".label");
  if (!lab) return;

  const input = el("input", "rename-input");
  input.value = pin.label;
  input.spellcheck = false;
  lab.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    if (commit && input.value.trim() !== pin.label) {
      const res = await send({ type: "renamePin", url: pin.url, label: input.value });
      if (res.ok) state.pins = res.pins;
    }
    rerenderAll();
  };
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

// ---------- column renderers ----------

function renderEnvColumn() {
  const col = cols[0];
  col.replaceChildren();

  if (state.pins.length) {
    const body = group(0, "Pinned", state.pins.length, {
      defaultOpen: true,
      headExtra: pinEditToggle(),
    });
    body.classList.add("pin-list");
    if (pinEditing) body.classList.add("editing");
    for (const pin of state.pins) body.appendChild(pinnedRow(pin, body));
  }

  const groups = { dev: [], prod: [], other: [] };
  for (const env of state.envs) {
    groups[state.envRoles[env.id] || "other"].push(env);
  }
  for (const [role, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const body = group(0, role === "other" ? "Environments" : role.toUpperCase(), list.length);
    for (const env of list) {
      const r = row({
        label: env.name,
        badge: role !== "other" ? role : null,
        badgeCls: role,
        expandable: true,
        pinnable: true,
        url: environmentHome(env),
        onClick: () => selectEnv(env, r),
      });
      if (selection.env?.id === env.id) r.classList.add("selected");
      body.appendChild(r);
    }
  }
  if (!state.envs.length) {
    col.appendChild(el("div", "empty",
      "No environments yet — open your org page (https://yourorg.crm.dynamics.com) and it will be added automatically."));
  }
}

async function selectEnv(env, rowEl) {
  selection = { env, solution: null };
  activeCol = 1;
  lastEnvData = null;
  lastComponents = null;
  groupState[1].clear();
  groupState[2].clear();
  cols[0].querySelectorAll(".row.selected").forEach((n) => n.classList.remove("selected"));
  rowEl?.classList.add("selected");
  cols[2].classList.add("hidden");
  const col = cols[1];
  col.classList.remove("hidden");
  col.replaceChildren(el("div", "loading", "Loading apps & solutions…"));

  const res = await send({ type: "getEnvData", envId: env.id });
  if (!res.ok) return fail(res);
  lastEnvData = res;
  renderEnvDataColumn(res);
  applyFilter();
}

function solutionRow(env, sol) {
  const r = row({
    label: sol.name,
    sub: sol.managed ? "managed" : "",
    badge: "Solution",
    badgeCls: "kind-solution",
    expandable: true,
    pinnable: true,
    url: solutionUrl(env, sol.id),
    onClick: () => selectSolution(sol, r),
  });
  if (selection.solution?.id === sol.id) r.classList.add("selected");
  return r;
}

function renderEnvDataColumn(data) {
  const env = selection.env;
  const col = cols[1];
  col.replaceChildren();

  const canvas = data.apps.filter((a) => a.kind === "canvas");
  const model = data.apps.filter((a) => a.kind !== "canvas");
  const solId = data.defaultSolutionId;

  // Starred items from this environment, ready at the top.
  const pinnedApps = data.apps.filter((a) => {
    const urls = appUrls(env, a, solId);
    return isPinned(urls.edit) || isPinned(urls.play);
  });
  const pinnedSols = data.solutions.filter((s) => isPinned(solutionUrl(env, s.id)));
  if (pinnedApps.length || pinnedSols.length) {
    const body = group(1, "Pinned", pinnedApps.length + pinnedSols.length, { defaultOpen: true });
    for (const app of pinnedApps) body.appendChild(appRow(env, app, solId));
    for (const sol of pinnedSols) body.appendChild(solutionRow(env, sol));
  }

  if (canvas.length) {
    const body = group(1, "Canvas apps", canvas.length);
    for (const app of canvas) body.appendChild(appRow(env, app, solId));
  }
  if (model.length) {
    const body = group(1, "Model-driven apps", model.length);
    for (const app of model) body.appendChild(appRow(env, app, solId));
  }
  if (!data.apps.length) col.appendChild(el("div", "empty", "No apps."));

  const unmanaged = sortedSolutions(data.solutions.filter((s) => !s.managed));
  const managed = sortedSolutions(data.solutions.filter((s) => s.managed));

  if (unmanaged.length) {
    const body = group(1, "Unmanaged solutions", unmanaged.length, { headExtra: solutionSortSelect() });
    for (const sol of unmanaged) body.appendChild(solutionRow(env, sol));
  }
  if (managed.length) {
    const body = group(1, "Managed solutions", managed.length);
    for (const sol of managed) body.appendChild(solutionRow(env, sol));
  }
  if (!data.solutions.length) col.appendChild(el("div", "empty", "No solutions."));

  setStatus(`${env.name} — ${data.apps.length} apps, ${data.solutions.length} solutions`);
}

async function selectSolution(sol, rowEl) {
  selection.solution = sol;
  activeCol = 2;
  lastComponents = null;
  groupState[2].clear();
  cols[1].querySelectorAll(".row.selected").forEach((n) => n.classList.remove("selected"));
  rowEl?.classList.add("selected");
  const col = cols[2];
  col.classList.remove("hidden");
  col.replaceChildren(el("div", "loading", "Loading components…"));

  const res = await send({ type: "getSolutionComponents", envId: selection.env.id, solutionId: sol.id });
  if (!res.ok) return fail(res);
  lastComponents = res.components;
  renderComponentsColumn(res.components);
  applyFilter();
}

// Buckets solution-component type names into a handful of colored kinds so
// they read at a glance, both inside their type group and once mixed
// together (e.g. the Pinned group, which drops the per-type grouping).
const KIND_PATTERNS = [
  { cls: "kind-flow", label: "Flow", re: /workflow|dialog|business rule|action|business process flow|cloud flow|desktop flow/i },
  { cls: "kind-solution", label: "Solution", re: /solution/i },
  { cls: "kind-table", label: "Table", re: /entity|attribute|^form$|^view$|chart|dashboard/i },
  { cls: "kind-app", label: "App", re: /app/i },
  { cls: "kind-webresource", label: "Web Resource", re: /web resource/i },
  { cls: "kind-plugin", label: "Plugin", re: /plugin|sdk message/i },
];

// Pins only remember a `kind` class (see the pinBtn handler in row()), so
// the top-level Pinned group (column 0) needs the label back for its badge.
const KIND_LABEL_BY_CLS = Object.fromEntries(KIND_PATTERNS.map((k) => [k.cls, k.label]));

function classifyKind(typeName) {
  const t = typeName || "";
  for (const k of KIND_PATTERNS) if (k.re.test(t)) return k;
  return { cls: "kind-other", label: null };
}

// Model-driven apps (80) and canvas apps (300) can show up as solution
// components too — give them the same editor/app picker as env-level apps
// instead of a single-URL pin, scoped to the solution they're listed under.
function componentIsAppKind(comp) {
  return comp.type === 80 || comp.type === 300;
}

function componentAppUrls(env, solId, comp) {
  return appUrls(env, { id: comp.id, kind: comp.type === 300 ? "canvas" : "model" }, solId);
}

function componentRow(env, solId, comp) {
  if (componentIsAppKind(comp)) {
    return appRow(env, {
      id: comp.id,
      name: comp.name || comp.logicalName || comp.id,
      kind: comp.type === 300 ? "canvas" : "model",
    }, solId);
  }
  const url = componentUrl(env, solId, comp);
  const kind = classifyKind(comp.typeName);
  return row({
    label: comp.name || comp.logicalName || comp.id,
    sub: comp.primaryEntity || "",
    badge: kind.label,
    badgeCls: kind.cls,
    pinnable: true,
    url,
    onClick: () => openUrl(url),
  });
}

function renderComponentsColumn(components) {
  const env = selection.env;
  const sol = selection.solution;
  const col = cols[2];
  col.replaceChildren();

  col.appendChild(row({
    label: "Open solution in maker portal",
    onClick: () => openUrl(solutionUrl(env, sol.id)),
  }));

  const pinned = components.filter((c) => {
    if (componentIsAppKind(c)) {
      const urls = componentAppUrls(env, sol.id, c);
      return isPinned(urls.edit) || isPinned(urls.play);
    }
    return isPinned(componentUrl(env, sol.id, c));
  });
  if (pinned.length) {
    const body = group(2, "Pinned", pinned.length, { defaultOpen: true });
    for (const comp of pinned) body.appendChild(componentRow(env, sol.id, comp));
  }

  const byType = new Map();
  for (const c of components) {
    if (!byType.has(c.typeName)) byType.set(c.typeName, []);
    byType.get(c.typeName).push(c);
  }
  for (const [typeName, list] of byType) {
    const body = group(2, typeName, list.length, { kindCls: classifyKind(typeName).cls });
    for (const comp of list) body.appendChild(componentRow(env, sol.id, comp));
  }
  if (!components.length) col.appendChild(el("div", "empty", "Empty solution."));
  setStatus(`${sol.name} — ${components.length} components`);
}

/** Re-renders every visible column from cached data (after pin changes). */
function rerenderAll() {
  renderEnvColumn();
  if (lastEnvData && selection.env) renderEnvDataColumn(lastEnvData);
  if (lastComponents && selection.solution) renderComponentsColumn(lastComponents);
  applyFilter();
}

// ---------- filter ----------

function applyFilter() {
  const q = $("#filter").value.trim().toLowerCase();
  // While filtering, force groups open so matches are visible.
  $("#columns").classList.toggle("filtering", Boolean(q));
  const col = cols[activeCol];
  for (const r of col.querySelectorAll(".row")) {
    r.classList.toggle("hidden", Boolean(q) && !r.dataset.filterText?.includes(q));
  }
  for (const g of col.querySelectorAll(".group")) {
    g.classList.toggle("hidden", Boolean(q) && !g.querySelector(".row:not(.hidden)"));
  }
}

// ---------- top-level flow ----------

function fail(res) {
  if (res.code === "no_org_tab" || res.code === "org_unauthorized") {
    // Mirror Level Up: data needs an open, signed-in org tab.
    showSignInBar(res.code === "org_unauthorized"
      ? "Org tab isn't signed in."
      : "No open org tab for this environment.", {
      label: "Open org tab",
      onClick: () => openUrl(res.envUrl || selection.env?.url),
    });
  } else if (res.code === "signin_required") {
    showSignInBar("Session expired.", { label: "Sign in", onClick: doSignIn });
  }
  setStatus(res.error || "Something went wrong.", true);
}

function showSignInBar(msg, action) {
  $("#signin-bar").classList.remove("hidden");
  $("#signin-msg").textContent = msg;
  if (action) {
    $("#signin").textContent = action.label;
    $("#signin").onclick = action.onClick;
  }
}

function render() {
  renderEnvColumn();
  applyFilter();
}

async function init() {
  const [res, { solutionSort: storedSort }] = await Promise.all([
    send({ type: "getState" }),
    api.storage.local.get("solutionSort"),
  ]);
  if (storedSort && SOLUTION_SORTS[storedSort]) solutionSort = storedSort;
  if (!res.ok) return setStatus(res.error, true);
  state = res;

  if (!state.envs.length) {
    if (state.hasOwnApp) {
      showSignInBar("No environments yet — discover them via your Entra app.", {
        label: "Discover", onClick: doSignIn,
      });
    } else if (!state.hasOrgAccess) {
      showSignInBar("Grant access in Options so PowerPopup can detect your orgs.", {
        label: "Options", onClick: () => api.runtime.openOptionsPage(),
      });
    } else {
      showSignInBar("Open your org page and it's added automatically.", {
        label: "Options", onClick: () => api.runtime.openOptionsPage(),
      });
    }
  } else if (!state.envs.some((e) => e.hasTab)) {
    setStatus("Tip: keep an org tab open — data is read through it.");
  }
  render();
  $("#filter").focus();
}

async function doSignIn() {
  setStatus("Connecting…");
  const res = await send({ type: "signIn" });
  if (!res.ok) {
    showSignInBar(res.error || "Couldn't connect.", { label: "Retry", onClick: doSignIn });
    return setStatus(res.error || "Couldn't connect.", true);
  }
  $("#signin-bar").classList.add("hidden");
  state.envs = res.envs;
  setStatus(`Found ${res.envs.length} environments. Tag Dev/Prod in Options.`);
  render();
}

$("#filter").addEventListener("input", applyFilter);
$("#settings").addEventListener("click", () => api.runtime.openOptionsPage());
$("#refresh").addEventListener("click", async () => {
  setStatus("Refreshing…");
  if (activeCol === 2 && selection.solution) {
    const res = await send({ type: "getSolutionComponents", envId: selection.env.id, solutionId: selection.solution.id, force: true });
    if (!res.ok) return fail(res);
    lastComponents = res.components;
    renderComponentsColumn(res.components);
  } else if (activeCol === 1 && selection.env) {
    const res = await send({ type: "getEnvData", envId: selection.env.id, force: true });
    if (!res.ok) return fail(res);
    lastEnvData = res;
    renderEnvDataColumn(res);
  } else {
    const res = await send({ type: "refreshEnvironments" });
    if (!res.ok) return fail(res);
    state.envs = res.envs;
    render();
    setStatus(`Refreshed ${res.envs.length} environments.`);
  }
  applyFilter();
});

init();
