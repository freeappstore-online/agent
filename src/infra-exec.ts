/** Execute infra tools server-side. Extracted from session.ts to keep it manageable. */

import type { StoreConfig } from "./config";
import type { DeployEnv, DeployStatus } from "./deploy";
import { deployApp, pushUpdate } from "./deploy";
import { checkDeployStatus, fetchUrl, getAuditResults, getBuildLogs, getCIResults, listDeployed } from "./infra";
import type { ToolCall } from "./providers/types";

interface ExecContext {
  appId: string | null;
  files: Map<string, string>;
  env: DeployEnv;
  config: StoreConfig;
  onDeployStatus: (status: DeployStatus) => void;
  onAppDeployed: (id: string, name: string) => void;
}

/** Execute a single infra tool. Returns the result string. */
export async function executeInfraTool(tc: ToolCall, ctx: ExecContext): Promise<string> {
  const { config } = ctx;

  // Authorization: scope write tools to the session's own item
  const targetId = tc.input.id as string | undefined;
  if (targetId && ["push_update", "get_build_logs", "get_ci_results", "check_deploy_status", "get_audit_results"].includes(tc.name)) {
    if (!ctx.appId) return `Error: no ${config.noun} deployed yet. Deploy first before using ${tc.name}.`;
    if (targetId !== ctx.appId)
      return `Error: you can only ${tc.name} on your own ${config.noun} "${ctx.appId}". No access to "${targetId}".`;
  }

  // Validate deploy ID
  if (tc.name === "deploy" && tc.input.id) {
    const id = tc.input.id as string;
    const RESERVED = [
      "platform",
      "admin",
      "api",
      "agent",
      "publish",
      "create",
      "sdk",
      "freeappstore",
      "freegamestore",
      "store",
      "www",
      "mail",
      "status",
    ];
    if (
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(id) ||
      id.length > 58 ||
      id.startsWith("free") ||
      id.startsWith("pro") ||
      RESERVED.includes(id)
    ) {
      return `Error: invalid ${config.noun} ID "${id}". Must be lowercase, numbers, hyphens. No "free"/"pro" prefix, no reserved names. Max 58 chars.`;
    }
    if (ctx.appId && ctx.appId !== id) {
      return `Error: this session already deployed "${ctx.appId}". Create a new project for a different ${config.noun}.`;
    }
  }

  switch (tc.name) {
    case "deploy":
      return executeDeploy(tc, ctx);
    case "push_update":
      return executePushUpdate(tc, ctx);
    case "check_deploy_status":
      return checkDeployStatus(targetId!, ctx.env, config);
    case "list_deployed_apps":
    case "list_deployed_games":
      return listDeployed(ctx.env, config);
    case "fetch_url":
      return executeFetchUrl(tc, config);
    case "get_build_logs":
      return getBuildLogs(targetId!, ctx.env, config);
    case "get_ci_results":
      return getCIResults(targetId!, ctx.env, config);
    case "get_audit_results":
      return getAuditResults(targetId!, config);
    default:
      return `Unknown infra tool: ${tc.name}`;
  }
}

async function executeDeploy(tc: ToolCall, ctx: ExecContext): Promise<string> {
  const appId = tc.input.id as string;
  const appName = tc.input.name as string;

  // Uniqueness check: reject if repo already exists and this session didn't create it
  if (!ctx.appId) {
    const res = await fetch(`https://api.github.com/repos/${ctx.config.org}/${appId}`, {
      headers: {
        Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": ctx.config.agentName,
      },
    });
    if (res.status === 200) {
      return `Error: ${ctx.config.noun} ID "${appId}" is already taken. Choose a different ID.`;
    }
  }

  // Replace APPNAME placeholders
  for (const [path, content] of ctx.files) {
    if (content.includes("APPNAME")) {
      const replaced = path.includes("package.json") ? content.replace(/APPNAME/g, appId) : content.replace(/APPNAME/g, appName);
      ctx.files.set(path, replaced);
    }
  }

  ctx.onAppDeployed(appId, appName);

  let deployError: string | null = null;
  let liveUrl: string | null = null;
  await deployApp(
    {
      id: appId,
      name: appName,
      category: tc.input.category as string,
      icon: tc.input.icon as string,
      iconBg: tc.input.iconBg as string,
      description: tc.input.description as string,
    },
    ctx.files,
    ctx.env,
    ctx.config,
    (status) => {
      ctx.onDeployStatus(status);
      if (status.phase === "live") liveUrl = status.appUrl;
    },
  ).catch((err) => {
    deployError = String(err);
  });

  if (deployError) {
    ctx.onDeployStatus({ phase: "error", error: deployError });
    return `Deploy FAILED: ${deployError}`;
  }
  return `Deploy succeeded. Preview: ${liveUrl || "building..."}`;
}

async function executePushUpdate(tc: ToolCall, ctx: ExecContext): Promise<string> {
  ctx.onDeployStatus({ phase: "pushing", progress: "Pushing update..." });
  const result = await pushUpdate(tc.input.id as string, ctx.files, (tc.input.message as string) || "Update", ctx.env, ctx.config);
  if (!result.startsWith("Error")) {
    ctx.onDeployStatus({ phase: "building", deployUrl: `Pushing update...` });
  }
  return result;
}

async function executeFetchUrl(tc: ToolCall, config: StoreConfig): Promise<string> {
  const url = tc.input.url as string;
  if (!url.startsWith("https://")) {
    return "Error: can only fetch public HTTPS URLs.";
  }
  // Block private IPs and internal platform services
  if (/localhost|127\.|192\.168|10\.|172\.1[6-9]\.|172\.2|172\.3[01]\.|169\.254|0\.0\.0\.0|\[::1\]/i.test(url)) {
    return "Error: cannot fetch private/internal URLs.";
  }
  if (
    /admin\.(freeappstore|freegamestore)|publish\.(freeappstore|freegamestore)|agent\.(freeappstore|freegamestore)|api\.(freeappstore|freegamestore)\.online\/v1\/(publish|apps|auth\/(exchange|me))/i.test(
      url,
    )
  ) {
    return "Error: cannot fetch internal platform URLs.";
  }
  return fetchUrl(url, (tc.input.method as string) || "GET", config.agentName);
}
