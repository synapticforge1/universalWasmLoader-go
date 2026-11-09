/**
 * Create (or update) the GitHub Release for a tag through GitHub's REST API — never the GitHub CLI
 * (workspace letter H30; owner, 2026-11-08: no `gh`, in CI too). Run by `.github/workflows/
 * release.yml`'s `release` job from the tag's clone:
 *
 *   bun scripts/github-release.ts            # create the Release, or update its notes
 *   bun scripts/github-release.ts --dry-run  # every check and read, no write
 *
 * Environment:
 *   GITHUB_REPOSITORY  owner/repo                  (set by Actions)
 *   RELEASE_TAG        the tag, e.g. v0.3.0         (the workflow's TAG)
 *   RELEASE_SHA        the commit the `checks` job passed
 *   GITHUB_TOKEN       contents: write — only for the write; reads of this public repo work without
 *   GITHUB_API_URL     default https://api.github.com (a mock in the proof)
 *
 * Steps, each refusing with exit 1 on anything unexpected:
 *   1. The tag must exist on GitHub and peel (annotated tags followed) to RELEASE_SHA.
 *      `POST /releases` CREATES a missing tag from the default branch, so this is the check the
 *      CLI's `--verify-tag` used to give (loader-rs's hazard, workspace Tooling rule 9).
 *   2. The notes: the tag's `## [<tag>]` section of CHANGELOG.md (read from the working directory;
 *      a tag that predates the file reads the default branch's copy through the API); a default
 *      line when there is no section. The heading is matched literally.
 *   3. A Release for the tag exists → PATCH its title / notes when they differ (as `gh release edit`
 *      did; a re-run is safe). Otherwise POST it. Either way, read it back.
 *
 * `node:` builtins and `fetch` only.
 */
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
for (const a of args) if (a !== "--dry-run") fail(`unknown argument "${a}" — use --dry-run or nothing`);

function fail(msg: string): never {
  console.error(`github-release: ${msg}`);
  process.exit(1);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set`);
  return v;
}

const repo = need("GITHUB_REPOSITORY");
const tag = need("RELEASE_TAG");
const sha = need("RELEASE_SHA");
const token = process.env.GITHUB_TOKEN ?? "";
const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");

if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`GITHUB_REPOSITORY "${repo}" is not owner/repo`);
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`RELEASE_TAG "${tag}" is not a vX.Y.Z tag`);
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`RELEASE_SHA "${sha}" is not a full commit id`);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${repo} release workflow`,
    ...extra,
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function call(method: string, path: string, body?: unknown, accept?: string): Promise<{ status: number; json: any; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${api}${path}`, {
      method,
      headers: headers({
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accept ? { Accept: accept } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    fail(`${method} ${path}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// 1. The tag exists and peels to the commit `checks` passed.
const ref = await call("GET", `/repos/${repo}/git/ref/tags/${tag}`);
if (ref.status === 404) fail(`tag ${tag} does not exist on GitHub; refusing (a release would create it)`);
if (ref.status !== 200) fail(`GET tag ref ${tag}: HTTP ${ref.status} ${ref.text.slice(0, 200)}`);
let object = ref.json?.object as { type: string; sha: string } | undefined;
for (let depth = 0; object?.type === "tag"; depth++) {
  if (depth > 5) fail(`tag ${tag} nests more than 5 tag objects`);
  const t = await call("GET", `/repos/${repo}/git/tags/${object.sha}`);
  if (t.status !== 200) fail(`GET tag object ${object.sha}: HTTP ${t.status}`);
  object = t.json?.object;
}
if (object?.type !== "commit") fail(`tag ${tag} does not point to a commit (${JSON.stringify(object)})`);
if (object.sha !== sha) fail(`tag ${tag} is ${object.sha}, the checks passed ${sha}; refusing`);
console.log(`tag ${tag} = ${sha}`);

// 2. The notes.
let changelog: string | null = null;
if (existsSync("CHANGELOG.md")) {
  changelog = readFileSync("CHANGELOG.md", "utf8");
} else {
  const r = await call("GET", `/repos/${repo}/contents/CHANGELOG.md`, undefined, "application/vnd.github.raw+json");
  if (r.status === 200) {
    changelog = r.text;
    console.log(`CHANGELOG.md is not in ${tag}; using the default branch's copy`);
  } else if (r.status !== 404) {
    fail(`GET CHANGELOG.md: HTTP ${r.status}`);
  }
}
function notesFor(text: string, version: string): string {
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (!inSection) {
      if (line.startsWith(`## [${version}]`)) inSection = true;
      continue;
    }
    if (line.startsWith("## [")) break;
    if (/^\[[^\]]+\]: /.test(line)) continue; // link references
    out.push(line);
  }
  return out.join("\n").trim();
}
let notes = changelog === null ? "" : notesFor(changelog, tag);
if (notes === "") {
  console.log(`no CHANGELOG.md section for ${tag}; using a default note`);
  notes = `Release ${tag}.`;
}
console.log(`----- notes for ${tag} (${notes.split("\n").length} lines) -----\n${notes}\n-----`);

// 3. Create or update, then read back.
const existing = await call("GET", `/repos/${repo}/releases/tags/${tag}`);
if (existing.status !== 200 && existing.status !== 404) fail(`GET release ${tag}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);
let method: "POST" | "PATCH";
let path: string;
let body: Record<string, unknown>;
if (existing.status === 200) {
  if (existing.json?.name === tag && (existing.json?.body ?? "").trim() === notes) {
    console.log(`GitHub Release ${tag} exists with these notes: ${existing.json?.html_url}`);
    process.exit(0);
  }
  method = "PATCH";
  path = `/repos/${repo}/releases/${existing.json?.id}`;
  body = { name: tag, body: notes };
} else {
  method = "POST";
  path = `/repos/${repo}/releases`;
  body = { tag_name: tag, name: tag, body: notes, draft: false, prerelease: false };
}
if (dryRun) {
  console.log(`dry-run: would ${method} ${path} (${Object.keys(body).join(", ")})`);
  process.exit(0);
}
if (!token) fail("GITHUB_TOKEN is not set; cannot write the release");
const wrote = await call(method, path, body);
if (wrote.status !== (method === "POST" ? 201 : 200)) fail(`${method} release ${tag}: HTTP ${wrote.status} ${wrote.text.slice(0, 200)}`);
const back = await call("GET", `/repos/${repo}/releases/tags/${tag}`);
if (back.status !== 200 || back.json?.tag_name !== tag || (back.json?.body ?? "").trim() !== notes) {
  fail(`read-back of release ${tag}: HTTP ${back.status}, notes ${back.json?.body === undefined ? "missing" : "differ"}`);
}
console.log(`GitHub Release ${tag} ${method === "POST" ? "created" : "updated"}: ${back.json?.html_url}`);
