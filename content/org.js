// Org-tab agent: runs on authenticated Dataverse org pages
// (https://yourorg.crm*.dynamics.com) and performs read-only, same-origin
// Web API GETs on behalf of the extension — the same model the "Level Up"
// extension uses. The org's own session cookie authorizes the request, so
// there is no token, no OAuth, and nothing stored.
//
// Protocol (chrome.runtime messaging):
//   background -> tab  { type: "pe-dv-get", path }   GET /api/data/v9.2<path>,
//                                                    follows OData paging.
//   background -> tab  { type: "pe-org-info" }       WhoAmI + org details.
//   tab -> background  { type: "orgDetected", env }  sent once per page load
//                                                    after WhoAmI returns 200.

(() => {
  const api = globalThis.browser ?? chrome;

  // Only real org hosts (crm, crm2, crm4, …); the manifest match is broader.
  if (!/\.crm[0-9]*\.dynamics\.com$/i.test(location.hostname)) return;
  if (window.top !== window) return;

  const API_BASE = "/api/data/v9.2";
  const HEADERS = {
    Accept: "application/json",
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
  };

  async function dvFetch(pathOrUrl) {
    const url = new URL(pathOrUrl, location.origin);
    if (url.origin !== location.origin) throw new Error("Cross-origin request refused.");
    const res = await fetch(url.href, {
      credentials: "include",
      headers: HEADERS,
      redirect: "manual",
    });
    if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
      const err = new Error(`Not authorized on ${location.origin} — is this tab signed in?`);
      err.code = "org_unauthorized";
      throw err;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dataverse request failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return res.json();
  }

  // GET an API path, following server-driven paging. Returns
  // { rows } for collections or { data } for single objects/functions.
  async function dvGetAll(path) {
    let url = `${API_BASE}${path}`;
    const rows = [];
    while (url) {
      const json = await dvFetch(url);
      if (!Array.isArray(json.value)) return { data: json };
      rows.push(...json.value);
      url = json["@odata.nextLink"] || null;
    }
    return { rows };
  }

  // WhoAmI proves the session works; RetrieveCurrentOrganization enriches the
  // env with the EnvironmentId GUID (needed for maker-portal deep links) and
  // the friendly name. The latter is optional — some users may lack the priv.
  async function orgInfo() {
    const who = await dvFetch(`${API_BASE}/WhoAmI`);
    const env = {
      id: null,
      name: location.hostname.split(".")[0],
      url: location.origin,
      apiUrl: location.origin,
    };
    try {
      const org = await dvFetch(
        `${API_BASE}/RetrieveCurrentOrganization(AccessType=@p1)?@p1=Microsoft.Dynamics.CRM.EndpointAccessType'Default'`
      );
      const d = org.Detail || {};
      if (d.EnvironmentId) env.id = d.EnvironmentId;
      if (d.FriendlyName) env.name = d.FriendlyName;
    } catch {
      // deep links degrade gracefully without the GUID
    }
    return { env, userId: who.UserId };
  }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "pe-dv-get") {
      dvGetAll(msg.path)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
      return true;
    }
    if (msg?.type === "pe-org-info") {
      orgInfo()
        .then((info) => sendResponse({ ok: true, ...info }))
        .catch((e) => sendResponse({ ok: false, error: e.message, code: e.code }));
      return true;
    }
    return false;
  });

  // Announce this org so the extension auto-adds it to the environment list.
  orgInfo()
    .then((info) => api.runtime.sendMessage({ type: "orgDetected", env: info.env }))
    .catch(() => { /* not signed in yet — background will probe on demand */ });
})();
