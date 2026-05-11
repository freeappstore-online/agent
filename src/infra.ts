/** Infra query tools — read-only operations against GitHub, CF, and audit APIs. */

import type { StoreConfig } from "./config";
import type { DeployEnv } from "./deploy";

function makeGhApi(token: string, agentName: string) {
  return async (path: string) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": agentName,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    return res.json() as Promise<any>;
  };
}

async function cfApi(token: string, _accountId: string, path: string) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return res.json() as Promise<any>;
}

/** Check the latest deployment status on CF Pages. */
export async function checkDeployStatus(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const cfProject = config.cfProjectName(appId);
  const res = await cfApi(
    env.CF_API_TOKEN,
    env.CF_ACCOUNT_ID,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/deployments?sort_by=created_on&sort_order=desc&per_page=1`,
  );
  if (!res.success || !res.result?.length) {
    return `No deployments found for ${cfProject}. The ${config.noun} may not be provisioned yet.`;
  }
  const d = res.result[0];
  const status = d.latest_stage?.status || "unknown";
  const url = d.url || `https://${appId}.${config.domain}`;
  const created = d.created_on ? new Date(d.created_on).toISOString() : "unknown";
  return `Latest deploy: ${status}\nURL: ${url}\nCreated: ${created}\nStage: ${d.latest_stage?.name || "unknown"}`;
}

/** List all items from the store registry. */
export async function listDeployed(env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const file = await ghApi(`/repos/${config.org}/${config.storeRepo}/contents/registry.json`);
  if (!file.content) return "Could not read registry.";
  const rawBytes = Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
  const registry = JSON.parse(new TextDecoder().decode(rawBytes));
  const items = registry[config.nounPlural] || [];
  if (items.length === 0) return `No ${config.nounPlural} deployed yet.`;
  return items.map((a: any) => `${a.id} — ${a.name} (${a.category}) ${a.appUrl}`).join("\n");
}

/** Fetch a URL and return the response. */
export async function fetchUrl(url: string, method: string, agentName: string): Promise<string> {
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": agentName } });
    const body = await res.text();
    return `${res.status} ${res.statusText}\n${body.slice(0, 2000)}`;
  } catch (err) {
    return `Fetch error: ${err}`;
  }
}

/** Get CF Pages build logs for the latest deployment. */
export async function getBuildLogs(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const cfProject = config.cfProjectName(appId);
  const deps = await cfApi(
    env.CF_API_TOKEN,
    env.CF_ACCOUNT_ID,
    `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/deployments?sort_by=created_on&sort_order=desc&per_page=1`,
  );
  if (!deps.success || !deps.result?.length) return `No deployments found for ${cfProject}.`;
  const deployId = deps.result[0].id;
  const status = deps.result[0].latest_stage?.status || "unknown";
  const stageName = deps.result[0].latest_stage?.name || "unknown";

  const logRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/deployments/${deployId}/history/logs`,
    { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
  );
  const logData = (await logRes.json()) as any;
  const lines: string[] = (logData.result?.data || []).map((l: any) => l.line || l.message || JSON.stringify(l));

  return `Deploy ${deployId.slice(0, 8)} — stage: ${stageName}, status: ${status}\n\n${lines.join("\n").slice(-3000) || "(no log output)"}`;
}

/** Get GitHub Actions CI check results for a repo. */
export async function getCIResults(appId: string, env: DeployEnv, config: StoreConfig): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;
  const runs = await ghApi(`/repos/${repo}/commits/main/check-runs`);
  if (!runs.check_runs?.length) return `No CI check runs found for ${repo}. CI may not have run yet.`;

  const results = runs.check_runs.map((r: any) => {
    const status = r.status === "completed" ? r.conclusion : r.status;
    let detail = "";
    if (r.output?.summary) detail = r.output.summary.slice(0, 200);
    else if (r.output?.text) detail = r.output.text.slice(0, 200);
    return `${status === "success" ? "PASS" : status === "failure" ? "FAIL" : status.toUpperCase()}: ${r.name}${detail ? ` — ${detail}` : ""}`;
  });

  return `CI results for ${repo} (${runs.check_runs.length} checks):\n${results.join("\n")}`;
}

/** Get quality audit results from the store's audit API. */
export async function getAuditResults(appId: string, config: StoreConfig): Promise<string> {
  try {
    const res = await fetch(`https://api.${config.domain}/v1/audit?${config.auditParam}=${appId}`, {
      headers: { "User-Agent": config.agentName },
    });
    if (!res.ok) return `Audit API returned ${res.status}. The ${config.noun} may not have been audited yet.`;
    const data = (await res.json()) as any;

    if (data.summary) {
      const s = data.summary;
      const lines = [`Audit for ${appId}: ${s.pass} pass, ${s.warn} warn, ${s.fail} fail`];
      if (data.checks) {
        for (const c of data.checks) {
          const icon = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : "FAIL";
          lines.push(`  ${icon}: ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
        }
      }
      return lines.join("\n");
    }

    return JSON.stringify(data, null, 2).slice(0, 2000);
  } catch (err) {
    return `Could not reach audit API: ${err}`;
  }
}
