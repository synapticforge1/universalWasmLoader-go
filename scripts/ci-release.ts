/**
 * The CI half of a release, in the owner's order (workspace letter H33, `release-process.md` § 5,
 * owner 2026-11-10: "CI to check first, then push the tag, and then create the release page from
 * the tag, then publish the package to the registry"). GitHub's REST API only — no GitHub CLI
 * (H30). `.github/workflows/release.yml` runs one command per job:
 *
 *   bun scripts/ci-release.ts state   # `checks` (U5): is this pushed `main` commit a release?
 *   bun scripts/ci-release.ts tag     # `tag` (U6): CI's annotated tag vX.Y.Z on the commit
 *   bun scripts/ci-release.ts page    # `release` (U7): the GitHub Release page FROM the tag
 *   bun scripts/ci-release.ts proxy   # `publish` (U8): the Go proxy and sum.golang.org read back
 *   add --dry-run to `tag` / `page` for every check and read, no write
 *
 * Environment:
 *   GITHUB_REPOSITORY  owner/repo (set by Actions)
 *   RELEASE_SHA        the commit the run is for (= github.sha)
 *   RELEASE_TAG        vX.Y.Z (tag / page / proxy; `state` derives it from CHANGELOG.md)
 *   GITHUB_TOKEN       contents: write — only for the writes (tag, page)
 *   GITHUB_OUTPUT      `state` appends release=new|rerun|none and tag=vX.Y.Z when set
 *   GITHUB_API_URL     default https://api.github.com;  GOPROXY_URL default https://proxy.golang.org;
 *   GOSUMDB_URL        default https://sum.golang.org (mocks in the tests)
 *   RELEASE_TIMEOUT_MS default 30000 — the limit for EACH request, request to last byte (7.21)
 *   PROXY_WAIT_MS      default 300000 — how long `proxy` polls for the new version
 *   PROXY_POLL_MS      default 15000 — the pause between those polls
 *
 * A Go module has no version line: the version being released is the top `## [vX.Y.Z]` heading of
 * CHANGELOG.md, which `scripts/bump.ts` stamps in the `bump to vX.Y.Z` commit. `state` answers
 * "new" when that tag does not exist on GitHub, "rerun" when it peels to THIS commit (a re-run of
 * a release run), and "none" otherwise (an ordinary push after a release).
 *
 * `node:` builtins and `fetch` only.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import process from "node:process";

const MODULE ="github.com/synapticforge1/universalWasmLoader-go";

const argv = process.argv.slice(2);
const cmd = argv[0];
const dryRun = argv.includes("--dry-run");
for (const a of argv.slice(1)) if (a !== "--dry-run") fail(`unknown argument "${a}"`);
if (!["state", "tag", "page", "proxy"].includes(cmd ?? "")) fail("usage: bun scripts/ci-release.ts state|tag|page|proxy [--dry-run]");
if (dryRun && (cmd === "state" || cmd === "proxy")) fail(`--dry-run applies to tag and page only (${cmd} writes nothing)`);

function fail(msg: string): never {
  console.error(`ci-release: ${msg}`);
  process.exit(1);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set`);
  return v;
}

function num(name: string, def: number): number {
  const v = Number(process.env[name] ?? def);
  if (!Number.isFinite(v) || v <= 0) fail(`${name} "${process.env[name]}" is not a positive number`);
  return v;
}

const repo = need("GITHUB_REPOSITORY");
const sha = need("RELEASE_SHA");
const token = process.env.GITHUB_TOKEN ?? "";
const api = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
const goproxy = (process.env.GOPROXY_URL || "https://proxy.golang.org").replace(/\/+$/, "");
const gosumdb = (process.env.GOSUMDB_URL || "https://sum.golang.org").replace(/\/+$/, "");
const limitMs = num("RELEASE_TIMEOUT_MS", 30_000);

if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`GITHUB_REPOSITORY "${repo}" is not owner/repo`);
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`RELEASE_SHA "${sha}" is not a full commit id`);

/** One request under ONE time limit that covers the body too (best-practices 7.21). */
async function http(url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; text: string }> {
  const signal = AbortSignal.timeout(limitMs);
  try {
    const res = await fetch(url, { ...init, signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (e) {
    if (signal.aborted) fail(`${init.method ?? "GET"} ${url}: timed out after ${limitMs} ms`);
    fail(`${init.method ?? "GET"} ${url}: ${(e as Error).message}`);
  }
}

function github(method: string, path: string, body?: unknown, accept?: string) {
  const headers: Record<string, string> = {
    Accept: accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${repo} release workflow`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return http(`${api}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function needTag(): string {
  const tag = need("RELEASE_TAG");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`RELEASE_TAG "${tag}" is not a vX.Y.Z tag`);
  return tag;
}

/** The commit a tag peels to on GitHub (annotated tags followed), or null when it does not exist. */
async function peel(tag: string): Promise<string | null> {
  const ref = await github("GET", `/repos/${repo}/git/ref/tags/${tag}`);
  if (ref.status === 404) return null;
  if (ref.status !== 200) fail(`GET tag ref ${tag}: HTTP ${ref.status} ${ref.text.slice(0, 200)}`);
  let object = ref.json?.object as { type: string; sha: string } | undefined;
  for (let depth = 0; object?.type === "tag"; depth++) {
    if (depth > 5) fail(`tag ${tag} nests more than 5 tag objects`);
    const t = await github("GET", `/repos/${repo}/git/tags/${object.sha}`);
    if (t.status !== 200) fail(`GET tag object ${object.sha}: HTTP ${t.status}`);
    object = t.json?.object;
  }
  if (object?.type !== "commit") fail(`tag ${tag} does not point to a commit (${JSON.stringify(object)})`);
  return object.sha;
}

/** The top `## [vX.Y.Z]` heading of a CHANGELOG ([Unreleased] skipped), or null. */
function topVersion(changelog: string): string | null {
  for (const line of changelog.split(/\r?\n/)) {
    const m = line.match(/^## \[(v\d+\.\d+\.\d+)\]/);
    if (m) return m[1]!;
  }
  return null;
}

/** A version's CHANGELOG section (heading matched literally), "" when there is none. */
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

/** A module path as the proxy and sumdb spell it: each capital becomes "!" + its lower case. */
function escapePath(p: string): string {
  return p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------------------------

if (cmd === "state") {
  // U5: is this pushed `main` commit a release?
  if (!existsSync("CHANGELOG.md")) fail("CHANGELOG.md is not in the working directory");
  const tag = topVersion(readFileSync("CHANGELOG.md", "utf8"));
  let release: "new" | "rerun" | "none";
  if (tag === null) {
    release = "none";
    console.log("CHANGELOG.md has no versioned heading: not a release");
  } else {
    const at = await peel(tag);
    release = at === null ? "new" : at === sha ? "rerun" : "none";
    console.log(
      release === "new"
        ? `${tag} is not tagged on GitHub: a NEW release of ${sha}`
        : release === "rerun"
          ? `${tag} is tagged on THIS commit: a re-run of its release`
          : `${tag} is tagged on ${at}: an ordinary push, not a release`,
    );
  }
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `release=${release}\ntag=${tag ?? ""}\n`);
  console.log(`release=${release} tag=${tag ?? ""}`);
  process.exit(0);
}

if (cmd === "tag") {
  // U6: CI's annotated tag on the checked commit; there already = done; elsewhere = refused.
  const tag = needTag();
  const at = await peel(tag);
  if (at === sha) {
    console.log(`tag ${tag} already peels to ${sha}: nothing to do`);
    process.exit(0);
  }
  if (at !== null) fail(`tag ${tag} already exists on ${at}, not ${sha}; refusing (a published tag never moves)`);
  if (dryRun) {
    console.log(`dry-run: would create the annotated tag ${tag} on ${sha}`);
    process.exit(0);
  }
  if (!token) fail("GITHUB_TOKEN is not set; cannot create the tag");
  const obj = await github("POST", `/repos/${repo}/git/tags`, {
    tag,
    message: `${tag}\n\nTagged by CI after its checks passed on ${sha}.`,
    object: sha,
    type: "commit",
  });
  if (obj.status !== 201 || !/^[0-9a-f]{40}$/.test(obj.json?.sha ?? "")) fail(`POST git/tags ${tag}: HTTP ${obj.status} ${obj.text.slice(0, 200)}`);
  const ref = await github("POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: obj.json.sha });
  if (ref.status !== 201) fail(`POST git/refs refs/tags/${tag}: HTTP ${ref.status} ${ref.text.slice(0, 200)}`);
  const back = await peel(tag);
  if (back !== sha) fail(`read-back: tag ${tag} peels to ${back ?? "(missing)"}, not ${sha}`);
  console.log(`tag ${tag} created (object ${obj.json.sha}) and read back: peels to ${sha}`);
  process.exit(0);
}

if (cmd === "page") {
  // U7: the Release page FROM the tag, H32's order.
  const tag = needTag();
  const at = await peel(tag);
  if (at === null) fail(`tag ${tag} does not exist on GitHub; refusing (a release would create it)`);
  if (at !== sha) fail(`tag ${tag} is ${at}, the checks passed ${sha}; refusing`);
  console.log(`tag ${tag} = ${sha}`);

  const existing = await github("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (existing.status === 200) {
    console.log(`GitHub Release ${tag} already exists, nothing to do: ${existing.json?.html_url}`);
    process.exit(0);
  }
  if (existing.status !== 404) fail(`GET release ${tag}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);

  const cl = await github("GET", `/repos/${repo}/contents/CHANGELOG.md?ref=${sha}`, undefined, "application/vnd.github.raw+json");
  if (cl.status !== 200 && cl.status !== 404) fail(`GET CHANGELOG.md at ${sha}: HTTP ${cl.status}`);
  const section = cl.status === 200 ? notesFor(cl.text, tag) : "";
  if (section === "") console.log(`no CHANGELOG.md section for ${tag}; the generated notes stand alone`);
  const body = [
    `**Go module:** \`go get ${MODULE}@${tag}\` — [pkg.go.dev](https://pkg.go.dev/${MODULE}@${tag})`,
    ...(section ? ["", section] : []),
  ].join("\n");
  const payload = { tag_name: tag, name: tag, body, generate_release_notes: true, draft: false, prerelease: false };
  console.log(`----- body for ${tag} (${body.split("\n").length} lines, + generated notes) -----\n${body}\n-----`);
  if (dryRun) {
    console.log(`dry-run: would POST /repos/${repo}/releases`);
    process.exit(0);
  }
  if (!token) fail("GITHUB_TOKEN is not set; cannot create the release");
  const created = await github("POST", `/repos/${repo}/releases`, payload);
  if (created.status !== 201) fail(`POST release ${tag}: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  const back = await github("GET", `/repos/${repo}/releases/tags/${tag}`);
  if (back.status !== 200 || back.json?.tag_name !== tag) fail(`read-back of release ${tag}: HTTP ${back.status}`);
  if (back.json?.draft !== false) fail(`release ${tag} reads back as a draft`);
  const after = await peel(tag);
  if (after !== sha) fail(`after the POST, tag ${tag} peels to ${after ?? "(missing)"}, not ${sha}`);
  console.log(`GitHub Release ${tag} created: ${back.json?.html_url} (tag still ${sha})`);
  process.exit(0);
}

if (cmd === "proxy") {
  // U8: the publish of a Go module is the proxy serving the tag; read it back, FATAL.
  const tag = needTag();
  const esc = escapePath(MODULE);
  const waitMs = num("PROXY_WAIT_MS", 300_000);
  const pollMs = num("PROXY_POLL_MS", 15_000);
  const deadline = Date.now() + waitMs;
  let info: { status: number; json: any; text: string };
  for (let attempt = 1; ; attempt++) {
    info = await http(`${goproxy}/${esc}/@v/${tag}.info`);
    if (info.status === 200) break;
    if (info.status !== 404 && info.status !== 410) fail(`GET ${tag}.info: HTTP ${info.status} ${info.text.slice(0, 200)}`);
    if (Date.now() + pollMs > deadline) {
      fail(
        `the proxy does not serve ${MODULE}@${tag} after ${waitMs} ms (HTTP ${info.status}, ${attempt} tries: ${info.text.trim().slice(0, 160)}). ` +
          `If it says "unknown revision", someone asked for ${tag} before its tag existed and the proxy cached the miss: ` +
          `"Re-run failed jobs" once it serves the version (U12) — the tag and the page are already done.`,
      );
    }
    console.log(`proxy: ${tag} not served yet (HTTP ${info.status}); retrying in ${pollMs} ms`);
    await Bun.sleep(pollMs);
  }
  if (info.json?.Version !== tag) fail(`proxy .info names ${info.json?.Version}, not ${tag}`);
  if (info.json?.Origin?.Hash !== sha) fail(`proxy .info Origin.Hash is ${info.json?.Origin?.Hash ?? "(none)"}, not ${sha}`);
  if (info.json?.Origin?.Ref !== `refs/tags/${tag}`) fail(`proxy .info Origin.Ref is ${info.json?.Origin?.Ref ?? "(none)"}, not refs/tags/${tag}`);
  const mod = await http(`${goproxy}/${esc}/@v/${tag}.mod`);
  if (mod.status !== 200 || !mod.text.includes(`module ${MODULE}`)) fail(`proxy .mod for ${tag}: HTTP ${mod.status}`);
  const sum = await http(`${gosumdb}/lookup/${esc}@${tag}`);
  const line = `${MODULE} ${tag} h1:`;
  if (sum.status !== 200 || !sum.text.includes(line)) fail(`sum.golang.org has no "${line}" (HTTP ${sum.status})`);
  console.log(`proxy serves ${MODULE}@${tag} from ${sha}; sum.golang.org: ${sum.text.split("\n").find((l) => l.startsWith(line))}`);
  process.exit(0);
}
