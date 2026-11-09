/**
 * Make the GitHub Release page for a NEW tag through GitHub's REST API (workspace letters H30 — no
 * GitHub CLI, in CI too — and H32 — every tagged release gets its page from CI, in this order).
 * `.github/workflows/release.yml`'s `release` job fetches this file ALONE at the tagged commit and
 * runs it; nothing of the package is checked out beside the write token (C30).
 *
 *   bun scripts/github-release.ts            # make the page (or find it already there)
 *   bun scripts/github-release.ts --dry-run  # every check and read, no write
 *
 * Environment:
 *   GITHUB_REPOSITORY  owner/repo                    (set by Actions)
 *   RELEASE_TAG        the tag, e.g. v0.3.2           (the workflow's github.ref_name)
 *   RELEASE_SHA        the commit the `checks` job passed (= github.sha)
 *   GITHUB_TOKEN       contents: write — only for the POST; reads of this public repo work without
 *   GITHUB_API_URL     default https://api.github.com (a mock in the tests)
 *   RELEASE_TIMEOUT_MS default 30000 — the limit for EACH request, request to last byte
 *                      (workspace best-practices 7.21)
 *
 * The order (H32 — keep it), each step refusing with exit 1 on anything unexpected:
 *   1. The tag exists on GitHub and peels (annotated tags followed) to RELEASE_SHA. `POST
 *      /releases` CREATES a missing tag from the default branch, so nothing is written otherwise.
 *   2. A Release for the tag already there → done, exit 0, NO write (a re-run is safe).
 *   3. POST it — a pkg.go.dev link on top, then the tag's `## [<tag>]` section of CHANGELOG.md read
 *      at RELEASE_SHA, with `generate_release_notes` — then read it back (the tag, not a draft) and
 *      peel the tag again.
 *
 * `node:` builtins and `fetch` only.
 */
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
const limitMs = Number(process.env.RELEASE_TIMEOUT_MS ?? "30000");
const MODULE = "github.com/synapticforge1/universalWasmLoader-go";

if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`GITHUB_REPOSITORY "${repo}" is not owner/repo`);
if (!/^v\d+\.\d+\.\d+$/.test(tag)) fail(`RELEASE_TAG "${tag}" is not a vX.Y.Z tag`);
if (!/^[0-9a-f]{40}$/.test(sha)) fail(`RELEASE_SHA "${sha}" is not a full commit id`);
if (!Number.isFinite(limitMs) || limitMs <= 0) fail(`RELEASE_TIMEOUT_MS "${process.env.RELEASE_TIMEOUT_MS}" is not a positive number`);

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

/** One request under ONE time limit that covers the body too (7.21). */
async function call(method: string, path: string, body?: unknown, accept?: string): Promise<{ status: number; json: any; text: string }> {
  const signal = AbortSignal.timeout(limitMs);
  try {
    const res = await fetch(`${api}${path}`, {
      method,
      signal,
      headers: headers({
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(accept ? { Accept: accept } : {}),
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (e) {
    if (signal.aborted) fail(`${method} ${path}: timed out after ${limitMs} ms`);
    fail(`${method} ${path}: ${(e as Error).message}`);
  }
}

/** The commit the tag peels to on GitHub, or null when the tag does not exist. */
async function peel(): Promise<string | null> {
  const ref = await call("GET", `/repos/${repo}/git/ref/tags/${tag}`);
  if (ref.status === 404) return null;
  if (ref.status !== 200) fail(`GET tag ref ${tag}: HTTP ${ref.status} ${ref.text.slice(0, 200)}`);
  let object = ref.json?.object as { type: string; sha: string } | undefined;
  for (let depth = 0; object?.type === "tag"; depth++) {
    if (depth > 5) fail(`tag ${tag} nests more than 5 tag objects`);
    const t = await call("GET", `/repos/${repo}/git/tags/${object.sha}`);
    if (t.status !== 200) fail(`GET tag object ${object.sha}: HTTP ${t.status}`);
    object = t.json?.object;
  }
  if (object?.type !== "commit") fail(`tag ${tag} does not point to a commit (${JSON.stringify(object)})`);
  return object.sha;
}

/** The tag's CHANGELOG.md section (heading matched literally), "" when there is none. */
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

// 1. The tag exists and peels to the commit `checks` passed.
const at = await peel();
if (at === null) fail(`tag ${tag} does not exist on GitHub; refusing (a release would create it)`);
if (at !== sha) fail(`tag ${tag} is ${at}, the checks passed ${sha}; refusing`);
console.log(`tag ${tag} = ${sha}`);

// 2. A page already there is done — no write.
const existing = await call("GET", `/repos/${repo}/releases/tags/${tag}`);
if (existing.status === 200) {
  console.log(`GitHub Release ${tag} already exists, nothing to do: ${existing.json?.html_url}`);
  process.exit(0);
}
if (existing.status !== 404) fail(`GET release ${tag}: HTTP ${existing.status} ${existing.text.slice(0, 200)}`);

// 3. The body: the registry link on top, then the CHANGELOG section at the tagged commit.
const cl = await call("GET", `/repos/${repo}/contents/CHANGELOG.md?ref=${sha}`, undefined, "application/vnd.github.raw+json");
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
const created = await call("POST", `/repos/${repo}/releases`, payload);
if (created.status !== 201) fail(`POST release ${tag}: HTTP ${created.status} ${created.text.slice(0, 200)}`);

// Read it back, and peel the tag again: the POST must not have created or moved it.
const back = await call("GET", `/repos/${repo}/releases/tags/${tag}`);
if (back.status !== 200 || back.json?.tag_name !== tag) fail(`read-back of release ${tag}: HTTP ${back.status}`);
if (back.json?.draft !== false) fail(`release ${tag} reads back as a draft`);
const after = await peel();
if (after !== sha) fail(`after the POST, tag ${tag} peels to ${after ?? "(missing)"}, not ${sha}`);
console.log(`GitHub Release ${tag} created: ${back.json?.html_url} (tag still ${sha})`);
