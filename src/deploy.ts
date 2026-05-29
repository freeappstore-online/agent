/** Deploy: provision via GitHub APIs, then push all files. */

import type { StoreConfig } from "./config";
import { makeGhApi } from "./github";

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

type TreeItem = { path: string; mode: string; type: string; sha: string };

async function createBlobs(ghApi: ReturnType<typeof makeGhApi>, repo: string, files: Map<string, string>): Promise<TreeItem[]> {
  const items: TreeItem[] = [];
  for (const [path, content] of files) {
    const blob = await ghApi(`/repos/${repo}/git/blobs`, "POST", { content, encoding: "utf-8" });
    if (!blob.sha) throw new Error(`Failed to create blob for ${path}: ${blob.message || "unknown error"}`);
    items.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  return items;
}

/** Deploy = create repo + push code. No DNS, no registry.
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
      description: (deployConfig.description || "").slice(0, 200),
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

  // Step 2: Push files to GitHub → GitHub Actions will deploy to R2
  onStatus({ phase: "pushing", progress: "Creating file tree..." });
  await pushFilesToGitHub(deployConfig.id, files, env.GITHUB_TOKEN, config);
  steps.push({ name: "Pushing code", status: "ok", detail: "Code pushed" });
  onStatus({ phase: "provisioning", steps: [...steps] });

  // Step 3: Wait for GitHub Actions deploy
  const appUrl = `https://${deployConfig.id}.${config.domain}`;
  onStatus({ phase: "building", deployUrl: appUrl });

  const deadline = Date.now() + 150_000; // 2.5 min
  const repo = `${config.org}/${deployConfig.id}`;
  while (Date.now() < deadline) {
    await sleep(8000);
    try {
      const runs = await ghApi(`/repos/${repo}/actions/runs?per_page=1&status=completed`);
      const latestRun = runs.workflow_runs?.[0];
      if (latestRun) {
        if (latestRun.conclusion === "success") {
          onStatus({ phase: "live", appUrl });
          return;
        }
        if (latestRun.conclusion === "failure") {
          onStatus({ phase: "error", error: `GitHub Actions deploy failed. Check: https://github.com/${repo}/actions` });
          return;
        }
      }
    } catch {
      /* GH API transient error — retry on next poll */
    }
  }
  onStatus({ phase: "live", appUrl }); // timeout — assume deploying
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

  const treeItems = await createBlobs(ghApi, repo, files);

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

  let treeItems: TreeItem[];
  try {
    treeItems = await createBlobs(ghApi, repo, files);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
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

  return `Pushed update to ${repo} (${commit.sha?.slice(0, 7)}). GitHub Actions will deploy to R2.`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
