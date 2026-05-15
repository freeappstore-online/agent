/** Deploy: provision via CF/GitHub APIs, then push all files. */

import type { StoreConfig } from "./config";

export interface DeployConfig {
  id: string;
  name: string;
  category: string;
  icon: string;
  iconBg: string;
  description: string;
}

export interface DeployEnv {
  GITHUB_TOKEN: string;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_GLOBAL_KEY: string;
  CF_EMAIL: string;
}

interface DeployStep {
  name: string;
  status: "ok" | "skip" | "fail";
  detail: string;
}

export type DeployStatus =
  | { phase: "provisioning"; steps: DeployStep[] }
  | { phase: "pushing"; progress: string }
  | { phase: "building"; deployUrl: string }
  | { phase: "live"; appUrl: string }
  | { phase: "error"; error: string };

async function cfApi(token: string, _accountId: string, path: string, method = "GET", body?: unknown) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
}

function makeGhApi(token: string, agentName: string) {
  return async (path: string, method = "GET", body?: unknown) => {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": agentName,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json() as Promise<any>;
  };
}

/** Deploy = create repo + push code. No CF Pages, no DNS, no registry.
 *  Those are for PUBLISH (separate action). */
export async function deployApp(
  deployConfig: DeployConfig,
  files: Map<string, string>,
  env: DeployEnv,
  config: StoreConfig,
  onStatus: (status: DeployStatus) => void,
): Promise<void> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const steps: DeployStep[] = [];
  onStatus({ phase: "provisioning", steps: [] });

  // Step 1: Create GitHub repo
  const repoCheck = await ghApi(`/repos/${config.org}/${deployConfig.id}`);
  if (repoCheck.id) {
    steps.push({ name: "GitHub repo", status: "skip", detail: `${config.org}/${deployConfig.id} already exists` });
  } else {
    const createRepo = await ghApi(`/orgs/${config.org}/repos`, "POST", {
      name: deployConfig.id,
      private: false,
      description: deployConfig.description,
      auto_init: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    });
    if (createRepo.id) {
      steps.push({ name: "GitHub repo", status: "ok", detail: `Created ${config.org}/${deployConfig.id}` });
    } else {
      steps.push({ name: "GitHub repo", status: "fail", detail: createRepo.message || "Failed" });
      onStatus({ phase: "error", error: `GitHub repo creation failed: ${createRepo.message}` });
      return;
    }
  }
  onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 2: Create CF Pages project — try clean name first, prefix if squatted
  const cfBody = (name: string) => ({
    name,
    source: {
      type: "github",
      config: {
        owner: config.org,
        repo_name: deployConfig.id,
        production_branch: "main",
        deployments_enabled: true,
        production_deployments_enabled: true,
      },
    },
    build_config: { build_command: "npx pnpm@10 install && npx pnpm@10 build", destination_dir: "web/dist" },
    deployment_configs: { production: { env_vars: { NODE_VERSION: { value: "22" } } } },
  });

  const candidates = [deployConfig.id, `${deployConfig.id}-${Date.now() % 10000}`];

  let cfProject = "";
  for (const name of candidates) {
    // Check if we already own this project
    const check = await cfApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${name}`);
    if (check.success) {
      cfProject = name;
      steps.push({ name: "CF Pages", status: "skip", detail: `${name}.pages.dev` });
      break;
    }
    // Try creating it
    const result = await cfApi(env.CF_API_TOKEN, env.CF_ACCOUNT_ID, `/accounts/${env.CF_ACCOUNT_ID}/pages/projects`, "POST", cfBody(name));
    if (result.success) {
      cfProject = name;
      steps.push({ name: "CF Pages", status: "ok", detail: `${name}.pages.dev` });
      break;
    }
    // "already exists" means squatted by someone else — try next candidate
    if (result.errors?.[0]?.message?.includes("already")) continue;
    // Other error — fail
    steps.push({ name: "CF Pages", status: "fail", detail: result.errors?.[0]?.message || "Failed" });
    break;
  }
  if (!cfProject) {
    onStatus({ phase: "error", error: "Could not create CF Pages project — all name candidates taken." });
    return;
  }
  onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 3: Push files to GitHub → CF Pages auto-builds
  onStatus({ phase: "pushing", progress: "Creating file tree..." });
  await pushFilesToGitHub(deployConfig.id, files, env.GITHUB_TOKEN, config);
  steps.push({ name: "Pushing code", status: "ok", detail: "Code pushed" });
  onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 4: Wait for CF Pages to build
  const previewUrl = `https://${cfProject}.pages.dev`;
  onStatus({ phase: "building", deployUrl: previewUrl });

  const deadline = Date.now() + 150_000; // 2.5 min
  while (Date.now() < deadline) {
    await sleep(8000);
    try {
      const deps = await cfApi(
        env.CF_API_TOKEN,
        env.CF_ACCOUNT_ID,
        `/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/deployments?sort_by=created_on&sort_order=desc&per_page=1`,
      );
      const dep = deps.result?.[0];
      if (!dep) continue;
      if (dep.latest_stage?.status === "success") {
        onStatus({ phase: "live", appUrl: previewUrl });
        return;
      }
      if (dep.latest_stage?.status === "failure") {
        let buildLog = "";
        try {
          const logRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/pages/projects/${cfProject}/deployments/${dep.id}/history/logs`,
            { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } },
          );
          const logData = (await logRes.json()) as any;
          buildLog = ((logData.result?.data || []) as any[])
            .map((l: any) => l.line || "")
            .join("\n")
            .slice(-2000);
        } catch {}
        onStatus({ phase: "error", error: `Build failed.\n\n${buildLog || "(no logs)"}` });
        return;
      }
    } catch {}
  }
  onStatus({ phase: "live", appUrl: previewUrl }); // timeout — assume building
}

/** Push all files as a single commit via the Git Data API (tree + commit + ref). */
async function pushFilesToGitHub(repoId: string, files: Map<string, string>, token: string, config: StoreConfig): Promise<void> {
  const ghApi = makeGhApi(token, config.agentName);
  const repo = `${config.org}/${repoId}`;

  // Check if repo is empty (no refs). Git Data API doesn't work on empty repos.
  const ref = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  if (!ref.object?.sha) {
    // Initialize empty repo with a seed file via Contents API (works on empty repos)
    const initContent = btoa("# Initial commit\n");
    await ghApi(`/repos/${repo}/contents/README.md`, "PUT", {
      message: "Initialize repo",
      content: initContent,
    });
    // Small delay for GitHub to process
    await sleep(1000);
  }

  // Now Git Data API works — get current HEAD
  const headRef = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  const parentSha = headRef.object?.sha;

  // Create blobs for each file
  const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const [path, content] of files) {
    const blob = await ghApi(`/repos/${repo}/git/blobs`, "POST", {
      content,
      encoding: "utf-8",
    });
    if (!blob.sha) throw new Error(`Failed to create blob for ${path}: ${blob.message || "unknown error"}`);
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // Create tree
  const tree = await ghApi(`/repos/${repo}/git/trees`, "POST", {
    tree: treeItems,
  });
  if (!tree.sha) throw new Error(`Failed to create tree: ${tree.message || "unknown error"}`);

  // Create commit
  const commit = await ghApi(`/repos/${repo}/git/commits`, "POST", {
    message: `Initial ${config.noun} — built with ${config.storeName} AI agent`,
    tree: tree.sha,
    parents: parentSha ? [parentSha] : [],
  });
  if (!commit.sha) throw new Error(`Failed to create commit: ${commit.message || "unknown error"}`);

  // Update main ref (no force — fails if someone else pushed, preventing data loss)
  await ghApi(`/repos/${repo}/git/refs/heads/main`, "PATCH", {
    sha: commit.sha,
  });
}

/** Push an update to an existing repo (new commit on top of existing). */
export async function pushUpdate(
  appId: string,
  files: Map<string, string>,
  commitMessage: string,
  env: DeployEnv,
  config: StoreConfig,
): Promise<string> {
  const ghApi = makeGhApi(env.GITHUB_TOKEN, config.agentName);
  const repo = `${config.org}/${appId}`;

  const ref = await ghApi(`/repos/${repo}/git/ref/heads/main`);
  const parentSha = ref.object?.sha;
  if (!parentSha) return `Error: could not find HEAD for ${repo}. Is the ${config.noun} deployed?`;

  const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const [path, content] of files) {
    const blob = await ghApi(`/repos/${repo}/git/blobs`, "POST", {
      content,
      encoding: "utf-8",
    });
    if (!blob.sha) return `Error: failed to create blob for ${path}: ${blob.message || "unknown"}`;
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const parentCommit = await ghApi(`/repos/${repo}/git/commits/${parentSha}`);
  if (!parentCommit.tree?.sha) return `Error: could not read parent commit tree for ${repo}.`;

  const tree = await ghApi(`/repos/${repo}/git/trees`, "POST", {
    base_tree: parentCommit.tree.sha,
    tree: treeItems,
  });

  const commit = await ghApi(`/repos/${repo}/git/commits`, "POST", {
    message: commitMessage,
    tree: tree.sha,
    parents: [parentSha],
  });

  const refUpdate = await ghApi(`/repos/${repo}/git/refs/heads/main`, "PATCH", {
    sha: commit.sha,
  });
  if (!refUpdate.ref) return `Error: failed to update ref for ${repo}: ${refUpdate.message || "unknown"}`;

  return `Pushed update to ${repo} (${commit.sha?.slice(0, 7)}). CF Pages will auto-deploy.`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
