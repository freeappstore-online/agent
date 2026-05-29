import type { StoreConfig } from "./config";

/** Run offline compliance checks against the session's virtual filesystem. */
export function runComplianceCheck(files: Map<string, string>, config: StoreConfig): string {
  const results: string[] = [];
  const pass = (name: string) => results.push(`PASS: ${name}`);
  const fail = (name: string, detail: string) => results.push(`FAIL: ${name} — ${detail}`);

  checkLicense(files, pass, fail);
  checkEnvProduction(files, pass, fail);
  checkTracking(files, pass, fail);
  checkBrandFonts(files, pass, fail);
  checkCssVars(files, config, pass, fail);
  checkHtmlMeta(files, pass, fail);
  checkPwaManifest(files, pass, fail);
  checkPwaMeta(files, pass, fail);
  checkStoreLink(files, config, pass, fail);
  checkStoreSpecific(files, config, pass, fail);
  checkPnpmWorkspace(files, pass, fail);
  checkPlaceholders(files, pass, fail);

  const passes = results.filter((r) => r.startsWith("PASS")).length;
  const fails = results.filter((r) => r.startsWith("FAIL")).length;
  return `Compliance: ${passes} pass, ${fails} fail\n\n${results.join("\n")}`;
}

type Pass = (name: string) => void;
type Fail = (name: string, detail: string) => void;

function checkLicense(files: Map<string, string>, pass: Pass, fail: Fail) {
  const license = files.get("LICENSE");
  if (license && /mit/i.test(license)) pass("MIT License");
  else fail("MIT License", "Missing LICENSE file or not MIT");
}

function checkEnvProduction(files: Map<string, string>, pass: Pass, fail: Fail) {
  if (!files.has(".env.production") && !files.has("web/.env.production")) pass("No .env.production");
  else fail("No .env.production", ".env.production found in project");
}

function checkTracking(files: Map<string, string>, pass: Pass, fail: Fail) {
  const forbidden = /google-analytics|gtag|amplitude|mixpanel|segment|hotjar|plausible|posthog/i;
  let found = false;
  for (const [path, content] of files) {
    if (path.startsWith("web/src/") && forbidden.test(content)) {
      found = true;
      break;
    }
  }
  if (!found && forbidden.test(files.get("web/package.json") || "")) found = true;
  if (!found) pass("No tracking SDKs");
  else fail("No tracking SDKs", "Found forbidden tracking SDK reference");
}

function checkBrandFonts(files: Map<string, string>, pass: Pass, fail: Fail) {
  const css = files.get("web/src/index.css") || "";
  const hasManrope = /manrope/i.test(css);
  const hasFraunces = /fraunces/i.test(css);
  if (hasManrope && hasFraunces) pass("Brand fonts (Manrope + Fraunces)");
  else fail("Brand fonts", `Missing: ${!hasManrope ? "Manrope" : ""} ${!hasFraunces ? "Fraunces" : ""}`.trim());
}

function checkCssVars(files: Map<string, string>, config: StoreConfig, pass: Pass, fail: Fail) {
  const css = files.get("web/src/index.css") || "";
  if (config.store === "games") {
    if (/--bg/.test(css) && /--ink/.test(css) && /--accent/.test(css)) pass("CSS variables (--bg, --ink, --accent)");
    else fail("CSS variables", "Missing --bg, --ink, or --accent in index.css");
  } else {
    if (/--paper/.test(css) && /--ink/.test(css) && /--accent/.test(css)) pass("CSS variables (--paper, --ink, --accent)");
    else fail("CSS variables", "Missing --paper, --ink, or --accent in index.css");
  }
}

function checkHtmlMeta(files: Map<string, string>, pass: Pass, fail: Fail) {
  const html = files.get("web/index.html") || "";
  const missing = [!/lang=/.test(html) && "lang", !/viewport/.test(html) && "viewport", !/<title>/.test(html) && "title"].filter(Boolean);
  if (missing.length === 0) pass("HTML meta tags (lang, viewport, title)");
  else fail("HTML meta tags", `Missing: ${missing.join(", ")}`);
}

function checkPwaManifest(files: Map<string, string>, pass: Pass, fail: Fail) {
  const manifest = files.get("web/public/manifest.json") || "";
  if (/name/.test(manifest) && /display/.test(manifest) && /start_url/.test(manifest)) pass("PWA manifest");
  else fail("PWA manifest", "Missing name, display, or start_url in manifest.json");
}

function checkPwaMeta(files: Map<string, string>, pass: Pass, fail: Fail) {
  const html = files.get("web/index.html") || "";
  if (/apple-mobile-web-app-capable|mobile-web-app-capable/i.test(html)) pass("PWA meta tags");
  else fail("PWA meta tags", "Missing apple-mobile-web-app-capable or mobile-web-app-capable");
}

function checkStoreLink(files: Map<string, string>, config: StoreConfig, pass: Pass, fail: Fail) {
  for (const [path, content] of files) {
    if (path.startsWith("web/src/") && content.includes(config.domain)) {
      pass(`${config.storeName} link in source`);
      return;
    }
  }
  fail(`${config.storeName} link`, `No reference to ${config.domain} in web/src/`);
}

function checkStoreSpecific(files: Map<string, string>, config: StoreConfig, pass: Pass, fail: Fail) {
  const css = files.get("web/src/index.css") || "";
  if (config.store === "games") {
    if (/overflow:\s*hidden/i.test(css) || /overflow-hidden/.test(css)) pass("Overflow hidden");
    else fail("Overflow hidden", "Body or #root must have overflow: hidden for games");
  } else {
    for (const [path, content] of files) {
      if (path.startsWith("web/src/") && /prefers-color-scheme|data-theme|color-scheme/.test(content)) {
        pass("Dark mode support");
        return;
      }
    }
    fail("Dark mode", "No prefers-color-scheme, data-theme, or color-scheme in web/src/");
  }
}

function checkPnpmWorkspace(files: Map<string, string>, pass: Pass, fail: Fail) {
  if (files.has("pnpm-workspace.yaml") && /pnpm/.test(files.get("package.json") || "")) pass("pnpm workspace");
  else fail("pnpm workspace", "Missing pnpm-workspace.yaml or pnpm reference in package.json");
}

function checkPlaceholders(files: Map<string, string>, pass: Pass, fail: Fail) {
  for (const [, content] of files) {
    if (/APPNAME/.test(content)) {
      fail("APPNAME placeholders", "Found unreplaced APPNAME placeholder");
      return;
    }
  }
  pass("No APPNAME placeholders");
}
