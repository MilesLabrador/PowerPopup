// Every deep-link pattern the extension emits lives here, so when Microsoft
// changes a maker-portal URL you fix it in one place.
//
// env  = { id, url, apiUrl }         (id = EnvironmentId GUID, url = org URL)
// item = app or solution component objects produced by lib/dataverse.js

const MAKE = "https://make.powerapps.com";
const FLOW = "https://make.powerautomate.com";
const PLAY = "https://apps.powerapps.com";

export function environmentHome(env) {
  return `${MAKE}/environments/${env.id}/home`;
}

export function solutionUrl(env, solutionId) {
  return `${MAKE}/environments/${env.id}/solutions/${solutionId}`;
}

export function modelAppPlayUrl(env, appId) {
  return `${env.url}/main.aspx?appid=${appId}`;
}

export function modelAppEditUrl(env, appId, solutionId) {
  // The maker portal opens apps inside a solution's URL context. Without a
  // known solution it falls back to the old (still-working) generic path.
  if (solutionId) return `${MAKE}/e/${env.id}/s/${solutionId}/app/edit/${appId}`;
  return `${MAKE}/e/${env.id}/s/appdesigner/${appId}`;
}

export function canvasAppPlayUrl(env, appId) {
  return `${PLAY}/play/e/${env.id}/a/${appId}`;
}

export function canvasAppEditUrl(env, appId) {
  const resourceId = encodeURIComponent(`/providers/Microsoft.PowerApps/apps/${appId}`);
  return `${MAKE}/e/${env.id}/canvas/?action=edit&app-id=${resourceId}`;
}

export function flowEditUrl(env, workflowId) {
  return `${FLOW}/environments/${env.id}/flows/${workflowId}`;
}

export function tableUrl(env, solutionId, objectId) {
  return `${MAKE}/environments/${env.id}/solutions/${solutionId}/entities/${objectId}`;
}

export function appUrls(env, app, defaultSolutionId) {
  if (app.kind === "canvas") {
    return { play: canvasAppPlayUrl(env, app.id), edit: canvasAppEditUrl(env, app.id) };
  }
  return { play: modelAppPlayUrl(env, app.id), edit: modelAppEditUrl(env, app.id, defaultSolutionId) };
}

// Solution component types (subset we deep-link directly; everything else
// falls back to the solution's objects page).
// 1 = Entity/Table, 29 = Process (covers workflows, BPFs, business rules, etc),
// 80 = Model-driven app, 300 = Canvas app.
export function componentUrl(env, solutionId, comp) {
  switch (comp.type) {
    case 1:
      return tableUrl(env, solutionId, comp.id);
    case 29:
      if (comp.typeName?.includes("Business Process Flow")) {
        return `${env.url}/Tools/ProcessControl/UnifiedProcessDesigner.aspx?id=${encodeURIComponent(`{${comp.id}}`)}`;
      }
      if (comp.componentLogicalName === "workflow") return flowEditUrl(env, comp.id);
      break;
    case 80:
      return modelAppEditUrl(env, comp.id, solutionId);
    case 300:
      return canvasAppEditUrl(env, comp.id);
  }
  return solutionUrl(env, solutionId);
}
