// Dataverse Web API queries: pure paths + row mappers. Execution is injected
// (`get(path)` resolves to rows / a single object) so the same queries run
// over the org-tab relay (primary, cookie-authorized) or the token-based
// fetch (optional own-app fallback).

import { getToken } from "./auth.js";

const DISCOVERY = "https://globaldisco.crm.dynamics.com";

// Component type 29 ("Workflow") covers classic workflows, dialogs, business
// rules, actions, cloud flows, desktop flows, and business process flows
// alike — the workflow table's `category` field is what actually tells them
// apart.
const WORKFLOW_CATEGORY_NAMES = {
  0: "Classic Workflow",
  1: "Dialog",
  2: "Business Rule",
  3: "Action",
  4: "Business Process Flow",
  5: "Cloud Flow",
  6: "Desktop Flow",
};

/** Builds the query API on top of any `get(path)` executor. */
export function createApi(get) {
  return {
    /** Model-driven apps in the environment. */
    async listModelApps() {
      const rows = await get(
        "/appmodules?$select=name,appmoduleid,uniquename&$orderby=name"
      );
      return rows.map((r) => ({
        kind: "model",
        id: r.appmoduleid,
        name: r.name,
        uniqueName: r.uniquename,
      }));
    },

    /** Canvas apps (Dataverse-backed environments expose them as a table). */
    async listCanvasApps() {
      try {
        const rows = await get(
          "/canvasapps?$select=displayname,canvasappid,name&$orderby=displayname"
        );
        return rows.map((r) => ({
          kind: "canvas",
          id: r.canvasappid,
          name: r.displayname || r.name,
        }));
      } catch {
        // Some environments don't expose the canvasapps table — degrade gracefully.
        return [];
      }
    },

    /**
     * The environment's own "Default Solution" id — the maker portal opens
     * model-driven apps inside this solution's URL context by default
     * (`/s/{solutionId}/app/edit/{appId}`) rather than the old `/s/appdesigner/`
     * path.
     */
    async getDefaultSolutionId() {
      const rows = await get(
        "/solutions?$select=solutionid&$filter=uniquename eq 'Default'&$top=1"
      );
      return rows[0]?.solutionid || null;
    },

    /** Visible (unmanaged-editable) solutions, most recently modified first. */
    async listSolutions() {
      const rows = await get(
        "/solutions?$select=friendlyname,uniquename,solutionid,ismanaged,modifiedon,createdon&$filter=isvisible eq true&$orderby=modifiedon desc"
      );
      return rows.map((r) => ({
        id: r.solutionid,
        name: r.friendlyname,
        uniqueName: r.uniquename,
        managed: r.ismanaged,
        modified: r.modifiedon,
        created: r.createdon,
      }));
    },

    /**
     * Components inside a solution, via the same summary view the maker portal
     * uses (gives display names + type names without extra lookups).
     */
    async listSolutionComponents(solutionId) {
      const rows = await get(
        `/msdyn_solutioncomponentsummaries?$filter=msdyn_solutionid eq '${solutionId}'` +
          "&$select=msdyn_displayname,msdyn_name,msdyn_componenttype,msdyn_componenttypename,msdyn_objectid,msdyn_componentlogicalname,msdyn_primaryentityname" +
          "&$orderby=msdyn_componenttypename,msdyn_displayname"
      );
      const components = rows.map((r) => ({
        id: r.msdyn_objectid,
        name: r.msdyn_displayname || r.msdyn_name,
        logicalName: r.msdyn_name,
        type: Number(r.msdyn_componenttype),
        typeName: r.msdyn_componenttypename || `Type ${r.msdyn_componenttype}`,
        componentLogicalName: r.msdyn_componentlogicalname,
        primaryEntity: r.msdyn_primaryentityname,
      }));

      const workflowIds = components.filter((c) => c.type === 29).map((c) => c.id);
      if (workflowIds.length) {
        const filter = workflowIds.map((id) => `workflowid eq '${id}'`).join(" or ");
        const workflows = await get(`/workflows?$select=workflowid,category&$filter=${filter}`);
        const categoryById = new Map(workflows.map((w) => [w.workflowid, w.category]));
        for (const c of components) {
          if (c.type !== 29) continue;
          const name = WORKFLOW_CATEGORY_NAMES[categoryById.get(c.id)];
          if (name) c.typeName = name;
        }
      }

      return components;
    },
  };
}

// ---------------------------------------------------------------------------
// Token-based executor + Global Discovery — only used when the user has
// configured their own Entra app (optional fallback path).
// ---------------------------------------------------------------------------

async function tokenFetchAll(resource, path, { interactive = false } = {}) {
  const token = await getToken(resource, { interactive });
  const rows = [];
  let url = `${resource}${path}`;
  while (url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Dataverse request failed (${res.status}) for ${path}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    if (Array.isArray(json.value)) rows.push(...json.value);
    else return json;
    url = json["@odata.nextLink"] || null;
  }
  return rows;
}

/** `get(path)` executor that calls `resource` with a bearer token (fallback). */
export function tokenGet(resource) {
  return (path) => tokenFetchAll(resource, `/api/data/v9.2${path}`);
}

/** Lists environments via Global Discovery — requires the own-app fallback. */
export async function listEnvironments({ interactive = false } = {}) {
  const rows = await tokenFetchAll(
    DISCOVERY,
    "/api/discovery/v2.0/Instances?$select=FriendlyName,EnvironmentId,ApiUrl,Url,UniqueName,UrlName",
    { interactive }
  );
  return rows.map((r) => ({
    id: r.EnvironmentId,
    name: r.FriendlyName || r.UniqueName,
    apiUrl: (r.ApiUrl || "").replace(/\/$/, ""),
    url: (r.Url || "").replace(/\/$/, ""),
    uniqueName: r.UniqueName,
  }));
}
