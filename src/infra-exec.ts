/** Execute infra tools server-side. Extracted from session.ts to keep it manageable. */

import type { StoreConfig } from "./config";
import type { DeployEnv, DeployStatus } from "./deploy";
import { deployApp, pushUpdate } from "./deploy";
import { checkDeployStatus, fetchUrl, getAuditResults, getBuildLogs, getCIResults, listDeployed } from "./infra";
import type { ToolCall } from "./providers/types";

interface ExecContext {
  appId: string | null;
  ownerLogin: string | null;
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

/** True if a repo with this id already exists in the org. */
async function repoExists(id: string, ctx: ExecContext): Promise<boolean> {
  const res = await fetch(`https://api.github.com/repos/${ctx.config.org}/${id}`, {
    headers: {
      Authorization: `Bearer ${ctx.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": ctx.config.agentName,
    },
  });
  return res.status === 200;
}

/**
 * Resolve a collision-free id. Returns the requested id if available, else the
 * first free `-2`, `-3`, … variant. Checking up front and picking an available
 * id beats erroring back to the model, which just guesses another name and
 * collides again. Trims the base so the suffix stays within the 58-char limit.
 */
async function resolveAvailableId(baseId: string, ctx: ExecContext): Promise<string> {
  if (!(await repoExists(baseId, ctx))) return baseId;
  for (let n = 2; n <= 50; n++) {
    const suffix = `-${n}`;
    const candidate = `${baseId.slice(0, 58 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!(await repoExists(candidate, ctx))) return candidate;
  }
  throw new Error(`Could not find an available ${ctx.config.noun} ID based on "${baseId}". Try a different name.`);
}

async function executeDeploy(tc: ToolCall, ctx: ExecContext): Promise<string> {
  const requestedId = tc.input.id as string;
  const appName = tc.input.name as string;

  // Always check for duplicates before choosing the id: if the requested id is
  // taken, deploy under the next available `-N` variant instead of failing.
  let appId = requestedId;
  if (!ctx.appId) {
    try {
      appId = await resolveAvailableId(requestedId, ctx);
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Replace placeholders: APPNAME -> display name (or the id in package.json),
  // APPID -> the lowercase app id everywhere (used by the SDK: initApp({ appId: "APPID" })).
  applyPlaceholders(ctx.files, appId, appName);

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

  // Insert D1 hosting route so the host worker can serve this app from R2
  if (ctx.env.DB) {
    const r2Prefix = `${ctx.config.nounPlural}/${appId}`;
    try {
      await ctx.env.DB.prepare(
        `INSERT INTO routes (slug, zone, r2_prefix, store, hosted_on, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'r2', ?5, ?5)
           ON CONFLICT (slug, zone) DO UPDATE SET
             r2_prefix = excluded.r2_prefix, store = excluded.store,
             hosted_on = excluded.hosted_on, updated_at = excluded.updated_at`,
      )
        .bind(appId, ctx.config.domain, r2Prefix, ctx.config.store, Date.now())
        .run();
    } catch {
      /* D1 insert failed — app deploys but won't be routable until published */
    }

    // Record app ownership so /v1/apps/mine returns it in the console
    if (ctx.ownerLogin) {
      try {
        await ctx.env.DB.prepare(
          `INSERT OR IGNORE INTO apps (id, owner_login, created_at, category, type, oneliner, display_name, store)
             VALUES (?, ?, ?, ?, 'standalone', ?, ?, ?)`,
        )
          .bind(
            appId,
            ctx.ownerLogin,
            Date.now(),
            (tc.input.category as string) || "utilities",
            (tc.input.description as string) || appName,
            appName,
            ctx.config.store,
          )
          .run();
      } catch {
        /* ownership record is best-effort */
      }
    }
  }

  const renamed = appId !== requestedId ? ` (ID "${requestedId}" was taken — deployed as "${appId}")` : "";
  return `Deploy succeeded${renamed}. Preview: ${liveUrl || "building..."}`;
}

/** Replace APPNAME (display name; id in package.json) + APPID (the slug, everywhere). */
export function applyPlaceholders(files: Map<string, string>, appId: string, appName: string): void {
  for (const [path, content] of files) {
    if (!content.includes("APPNAME") && !content.includes("APPID")) continue;
    let next = content.replace(/APPID/g, appId);
    next = path.includes("package.json") ? next.replace(/APPNAME/g, appId) : next.replace(/APPNAME/g, appName);
    files.set(path, next);
  }
}

async function executePushUpdate(tc: ToolCall, ctx: ExecContext): Promise<string> {
  // Post-deploy edits may reintroduce the APPID placeholder (e.g. the SDK
  // initApp call). Resolve it against the deployed id before pushing.
  if (ctx.appId) applyPlaceholders(ctx.files, ctx.appId, ctx.appId);
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
