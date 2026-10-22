const api = globalThis.browser ?? chrome;
const $ = (sel) => document.querySelector(sel);

const ROLES = ["other", "dev", "prod"];
const ORG_HOST_PERMISSION = "https://*.dynamics.com/*";

let loadedEnvs = []; // last state from the background (keeps ids/source stable)

async function load() {
  const res = await api.runtime.sendMessage({ type: "getState" });
  if (!res?.ok) return;

  $("#redirect").value = res.redirectUrl;
  $("#clientId").value = res.rawConfig?.clientId || "";
  $("#tenantId").value = res.rawConfig?.tenantId || "";
  $("#pocketEnabled").checked = res.rawConfig?.pocketEnabled !== false;

  renderSession(res);
  loadedEnvs = res.envs || [];
  renderEnvs(loadedEnvs, res.envRoles || {});
}

function renderSession(res) {
  const box = $("#sessionStatus");
  const grantRow = $("#grantAccessRow");
  if (!res.hasOrgAccess) {
    box.className = "session-status warn";
    box.textContent =
      "Environment detection isn't enabled yet — grant access to *.dynamics.com so PowerPopup can detect your orgs.";
    grantRow.hidden = false;
    return;
  }
  grantRow.hidden = true;
  const withTab = (res.envs || []).filter((e) => e.hasTab);
  if (withTab.length) {
    box.className = "session-status ok";
    box.textContent = `✓ Signed-in org tab detected: ${withTab.map((e) => e.name).join(", ")}.`;
  } else if ((res.envs || []).length) {
    box.className = "session-status warn";
    box.textContent =
      "No org tab open right now. Open your org (https://yourorg.crm.dynamics.com) to enable data loading.";
  } else {
    box.className = "session-status warn";
    box.textContent =
      "No environments yet — open your org page (https://yourorg.crm.dynamics.com) and it will appear here.";
  }
}

function envRow(env = {}, role = "other") {
  const rowEl = document.createElement("div");
  rowEl.className = "env-row";
  rowEl.dataset.envId = env.id || "";
  rowEl.dataset.source = env.source || "manual";

  const name = document.createElement("input");
  name.className = "name";
  name.placeholder = "Friendly name";
  name.value = env.name || "";

  const url = document.createElement("input");
  url.className = "url";
  url.placeholder = "https://yourorg.crm.dynamics.com";
  url.value = env.url || "";

  const select = document.createElement("select");
  for (const r of ROLES) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r === "other" ? "(untagged)" : r.toUpperCase();
    if (role === r) opt.selected = true;
    select.appendChild(opt);
  }

  const tab = document.createElement("span");
  tab.className = "tab-dot";
  tab.title = env.hasTab ? "Org tab open — data available" : "No open org tab";
  tab.textContent = env.hasTab ? "●" : "○";

  const remove = document.createElement("button");
  remove.className = "danger";
  remove.textContent = "✕";
  remove.title = "Remove environment";
  remove.addEventListener("click", () => rowEl.remove());

  rowEl.append(name, url, select, tab, remove);
  return rowEl;
}

function renderEnvs(envs, envRoles) {
  const list = $("#envList");
  list.replaceChildren();
  if (!envs.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No environments yet — open your org page, or add one below.";
    list.appendChild(p);
    return;
  }
  for (const env of envs) {
    list.appendChild(envRow(env, envRoles[env.id] || "other"));
  }
}

function collectEnvs() {
  const envs = [];
  const envRoles = {};
  for (const rowEl of document.querySelectorAll("#envList .env-row")) {
    const name = rowEl.querySelector(".name").value.trim();
    let url = rowEl.querySelector(".url").value.trim();
    if (!url) continue;
    try {
      url = new URL(url).origin;
    } catch {
      continue; // skip rows with an unparseable URL
    }
    const prior = loadedEnvs.find((e) => e.id === rowEl.dataset.envId);
    const id = prior?.id || url; // URL is the placeholder id until the GUID is detected
    envs.push({
      id,
      name: name || new URL(url).hostname.split(".")[0],
      url,
      apiUrl: url,
      source: rowEl.dataset.source || "manual",
      lastSeen: prior?.lastSeen,
    });
    const role = rowEl.querySelector("select").value;
    if (role !== "other") envRoles[id] = role;
  }
  return { envs, envRoles };
}

$("#addEnv").addEventListener("click", () => {
  const list = $("#envList");
  list.querySelector(".empty")?.remove();
  list.appendChild(envRow());
});

$("#save").addEventListener("click", async () => {
  const config = {
    clientId: $("#clientId").value.trim(),
    tenantId: $("#tenantId").value.trim(),
    pocketEnabled: $("#pocketEnabled").checked,
  };
  const { envs, envRoles } = collectEnvs();
  await api.storage.local.set({ config, envs, envRoles });
  loadedEnvs = envs;
  $("#saved").textContent = "Saved ✓";
  setTimeout(() => ($("#saved").textContent = ""), 2000);
});

$("#grantAccess").addEventListener("click", async () => {
  const granted = await api.permissions.request({ origins: [ORG_HOST_PERMISSION] });
  if (!granted) return;
  await api.runtime.sendMessage({ type: "orgAccessGranted" });
  load();
});

$("#refreshEnvs").addEventListener("click", async () => {
  const res = await api.runtime.sendMessage({ type: "refreshEnvironments" });
  if (res?.ok) {
    load();
  } else {
    alert(res?.error || "Failed to refresh.");
  }
});

$("#signOut").addEventListener("click", async () => {
  await api.runtime.sendMessage({ type: "signOut" });
  alert("Fallback tokens cleared.");
});

load();
