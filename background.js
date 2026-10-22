// Background worker: routes Dataverse reads through an open, signed-in org
// tab (content/org.js — same-origin, cookie-authorized, Level Up-style) and
// owns the local cache. The popup and the edge pocket talk to it exclusively
// through messages.
//
// Environments are a stored, user-editable list (Options page) that is
// auto-populated whenever a *.crm*.dynamics.com tab announces itself.
// The optional own-Entra-app path (lib/auth.js) is only a fallback.

import { getAuthStatus, signOut, getRedirectUrl, getConfig } from "./lib/auth.js";
import { createApi, tokenGet, listEnvironments } from "./lib/dataverse.js";

const api = globalThis.browser ?? chrome;

const CACHE_TTL_MS = 15 * 60 * 1000;
const ORG_TAB_PATTERN = "https://*.dynamics.com/*";
const ORG_SCRIPT_ID = "org-detect";

// ---------------------------------------------------------------------------
// Org-tab access (chrome: optional host permission, granted per-user-gesture
// from the Options page; firefox: still required at install, so this is
// granted immediately) — content/org.js is registered dynamically rather
// than statically in the manifest so the *.dynamics.com access it needs
// stays out of the install-time permission set on Chrome.
// ---------------------------------------------------------------------------

async function hasOrgAccess() {
  try {
    return await api.permissions.contains({ origins: [ORG_TAB_PATTERN] });
  } catch {
    return false;
  }
}

async function registerOrgContentScript() {
  const existing = await api.scripting.getRegisteredContentScripts({ ids: [ORG_SCRIPT_ID] });
  if (existing.length) return;
  await api.scripting.registerContentScripts([
    {
      id: ORG_SCRIPT_ID,
      matches: [ORG_TAB_PATTERN],
      js: ["content/org.js"],
      runAt: "document_idle",
    },
  ]);
}

async function ensureOrgContentScript() {
  if (await hasOrgAccess()) {
    try {
      await registerOrgContentScript();
    } catch {
      // already registered
    }
  }
}

ensureOrgContentScript();
api.runtime.onInstalled.addListener(ensureOrgContentScript);
api.runtime.onStartup?.addListener(ensureOrgContentScript);

async function store(keys) {
  return api.storage.local.get(keys);
}

// ---------------------------------------------------------------------------
// Environment list (stored, user-editable, auto-populated from open org tabs)
// ---------------------------------------------------------------------------

function normalizeUrl(url) {
  try {
    return new URL(url).origin;
  } catch {
    return (url || "").replace(/\/+$/, "");
  }
}

/** Merge a detected org into the stored env list. Fills blanks; never
 *  overwrites a name or role the user already set. */
async function upsertEnv(detected) {
  const url = normalizeUrl(detected.url);
  if (!url) return;
  const { envs = [], envRoles = {} } = await store(["envs", "envRoles"]);
  const idx = envs.findIndex((e) => normalizeUrl(e.url) === url);
  if (idx >= 0) {
    const cur = envs[idx];
    // Manual envs use their URL as a placeholder id until the GUID is known.
    if (detected.id && cur.id !== detected.id) {
      if (envRoles[cur.id]) {
        envRoles[detected.id] = envRoles[cur.id];
        delete envRoles[cur.id];
      }
      cur.id = detected.id;
    }
    if (!cur.name) cur.name = detected.name;
    cur.url = url;
    cur.apiUrl = url;
    cur.lastSeen = Date.now();
    envs[idx] = cur;
  } else {
    envs.push({
      id: detected.id || url,
      name: detected.name || new URL(url).hostname.split(".")[0],
      url,
      apiUrl: url,
      source: "auto",
      lastSeen: Date.now(),
    });
    envs.sort((a, b) => a.name.localeCompare(b.name));
  }
  await api.storage.local.set({ envs, envRoles });
}

async function findEnv(envId) {
  const { envs = [] } = await store("envs");
  const env = envs.find((e) => e.id === envId || e.url === envId);
  if (!env) throw new Error("Unknown environment — check the list in Options.");
  return env;
}

// ---------------------------------------------------------------------------
// Org-tab relay (primary data path)
// ---------------------------------------------------------------------------

async function findOrgTabs(env) {
  const tabs = await api.tabs.query({ url: `${env.url}/*` });
  // Prefer the active tab, then the most recently created.
  return tabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || b.id - a.id);
}

function noOrgTabError(env) {
  const err = new Error(`No open, signed-in tab for ${env.name} (${env.url}).`);
  err.code = "no_org_tab";
  err.envUrl = env.url;
  return err;
}

/** Sends one Web API GET to a signed-in tab of the env's org. */
async function orgTabGet(env, tabs, path) {
  let lastErr = null;
  for (const tab of tabs) {
    let res;
    try {
      res = await api.tabs.sendMessage(tab.id, { type: "pe-dv-get", path });
    } catch (e) {
      lastErr = e; // tab without our content script yet (e.g. extension just reloaded)
      continue;
    }
    if (res?.ok) return res.rows ?? res.data;
    lastErr = new Error(res?.error || "Org tab request failed.");
    lastErr.code = res?.code;
    // A real API error from a signed-in tab won't improve on another tab.
    if (res?.code !== "org_unauthorized") throw lastErr;
  }
  if (lastErr?.code === "org_unauthorized") {
    lastErr.envUrl = env.url;
    throw lastErr;
  }
  if (lastErr && !lastErr.code) {
    // Tab exists but our content script isn't there (extension was reloaded).
    const err = new Error(`Couldn't reach the ${env.name} tab — reload that tab and try again.`);
    err.code = "no_org_tab";
    err.envUrl = env.url;
    throw err;
  }
  throw lastErr ?? noOrgTabError(env);
}

/** Returns a Dataverse query API for the environment: org-tab relay when a
 *  tab is open, else the own-app token path if configured. */
async function getDataApi(env) {
  const tabs = await findOrgTabs(env);
  if (tabs.length) {
    // Opportunistically fill in the EnvironmentId GUID for deep links.
    if (env.id === env.url) probeTab(tabs[0].id);
    return createApi((path) => orgTabGet(env, tabs, path));
  }
  const cfg = await getConfig();
  if (cfg.hasOwnApp) return createApi(tokenGet(env.apiUrl || env.url));
  throw noOrgTabError(env);
}

/** Asks an org tab for its identity and merges the result into the env list. */
async function probeTab(tabId) {
  try {
    const res = await api.tabs.sendMessage(tabId, { type: "pe-org-info" });
    if (res?.ok && res.env) await upsertEnv(res.env);
    return res;
  } catch {
    return null;
  }
}

/** Probes every open dynamics tab so the env list reflects reality. */
async function probeOpenOrgTabs() {
  const tabs = await api.tabs.query({ url: ORG_TAB_PATTERN });
  await Promise.all(tabs.map((t) => probeTab(t.id)));
}

// ---------------------------------------------------------------------------
// Cached queries
// ---------------------------------------------------------------------------

async function getEnvData(envId, force) {
  const env = await findEnv(envId);
  const key = `cache:${envId}`;
  const cached = (await store(key))[key];
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  const dv = await getDataApi(env);
  const [modelApps, canvasApps, solutions, defaultSolutionId] = await Promise.all([
    dv.listModelApps(),
    dv.listCanvasApps(),
    dv.listSolutions(),
    dv.getDefaultSolutionId(),
  ]);
  const data = {
    apps: [...canvasApps, ...modelApps].sort((a, b) => a.name.localeCompare(b.name)),
    solutions,
    defaultSolutionId,
    ts: Date.now(),
  };
  await api.storage.local.set({ [key]: data });
  return data;
}

async function getSolutionComponents(envId, solutionId, force) {
  const env = await findEnv(envId);
  const key = `cache:${envId}:${solutionId}`;
  const cached = (await store(key))[key];
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
  const dv = await getDataApi(env);
  const components = await dv.listSolutionComponents(solutionId);
  const data = { components, ts: Date.now() };
  await api.storage.local.set({ [key]: data });
  return data;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

const handlers = {
  async orgDetected(msg) {
    await upsertEnv(msg.env || {});
    return {};
  },

  async getState() {
    const { config: rawConfig = {}, envs = [], envRoles = {}, pins = [] } = await store([
      "config", "envs", "envRoles", "pins",
    ]);
    const config = await getConfig();
    const status = await getAuthStatus();
    // Which envs currently have an open org tab (drives popup hints).
    const orgTabs = await api.tabs.query({ url: ORG_TAB_PATTERN });
    const openUrls = new Set(orgTabs.map((t) => normalizeUrl(t.url)));
    return {
      hasOwnApp: config.hasOwnApp,
      hasOrgAccess: await hasOrgAccess(),
      signedIn: status.signedIn,
      redirectUrl: getRedirectUrl(),
      config, rawConfig, envRoles, pins,
      envs: envs.map((e) => ({ ...e, hasTab: openUrls.has(normalizeUrl(e.url)) })),
    };
  },

  // Called after the Options page has already obtained the *.dynamics.com
  // permission via a user-gesture chrome.permissions.request() call.
  async orgAccessGranted() {
    await registerOrgContentScript();
    await probeOpenOrgTabs();
    return {};
  },

  // Own-app fallback only: discover environments via Global Discovery.
  async signIn() {
    const cfg = await getConfig();
    if (!cfg.hasOwnApp) {
      const err = new Error(
        "Open your org page (https://yourorg.crm.dynamics.com) and it will be added automatically — or configure an Entra app in Options."
      );
      err.code = "no_session";
      throw err;
    }
    const discovered = await listEnvironments({ interactive: true });
    for (const env of discovered) await upsertEnv(env);
    const { envs = [] } = await store("envs");
    return { envs };
  },

  async signOut() {
    await signOut();
    return {};
  },

  async refreshEnvironments() {
    await probeOpenOrgTabs();
    const cfg = await getConfig();
    const status = await getAuthStatus();
    if (cfg.hasOwnApp && status.signedIn) {
      try {
        for (const env of await listEnvironments()) await upsertEnv(env);
      } catch { /* fallback discovery is best-effort */ }
    }
    const { envs = [] } = await store("envs");
    return { envs };
  },

  async saveEnvironments({ envs }) {
    await api.storage.local.set({ envs });
    return { envs };
  },

  async getEnvData({ envId, force }) {
    return getEnvData(envId, force);
  },

  async getSolutionComponents({ envId, solutionId, force }) {
    return getSolutionComponents(envId, solutionId, force);
  },

  async open({ url }) {
    await api.tabs.create({ url });
    return {};
  },

  async togglePin({ pin }) {
    const { pins = [] } = await store("pins");
    const idx = pins.findIndex((p) => p.url === pin.url);
    if (idx >= 0) pins.splice(idx, 1);
    else pins.push(pin);
    await api.storage.local.set({ pins });
    return { pins };
  },

  // A pin's `label` is what the pinned list shows; `name` remembers what the
  // item was actually called when it was pinned, so a rename can be undone by
  // clearing the field.
  async renamePin({ url, label }) {
    const { pins = [] } = await store("pins");
    const pin = pins.find((p) => p.url === url);
    if (!pin) return { pins };
    const next = (label || "").trim();
    if (next) {
      if (!pin.name) pin.name = pin.label;
      pin.label = next;
      if (pin.label === pin.name) delete pin.name;
    } else if (pin.name) {
      pin.label = pin.name;
      delete pin.name;
    }
    await api.storage.local.set({ pins });
    return { pins };
  },

  // `urls` is the pinned list in its new order. Pins added elsewhere while the
  // popup was open aren't in it, so they keep their place at the end.
  async reorderPins({ urls = [] }) {
    const { pins = [] } = await store("pins");
    const byUrl = new Map(pins.map((p) => [p.url, p]));
    const next = urls.map((u) => byUrl.get(u)).filter(Boolean);
    const moved = new Set(next.map((p) => p.url));
    for (const p of pins) if (!moved.has(p.url)) next.push(p);
    await api.storage.local.set({ pins: next });
    return { pins: next };
  },
};

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  handler(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code, envUrl: e.envUrl }));
  return true; // async response
});

api.commands?.onCommand.addListener(async (command) => {
  if (command === "toggle-pocket") {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) api.tabs.sendMessage(tab.id, { type: "togglePocket" }).catch(() => {});
  }
});
