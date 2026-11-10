// Tests for scripts/ci-release.ts (workspace H33's CI order: state → tag → page → proxy) against
// one mock that serves GitHub's REST API (/api), the Go proxy (/proxy) and sum.golang.org (/sumdb).
// Run: `bun test scripts/` (CI's `checks` job runs it). The script runs as a CHILD process with
// Bun.spawn — never spawnSync, which would block this process's event loop and the mock with it.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "ci-release.ts");
const MOD = "github.com/synapticforge1/universalWasmLoader-go";
const ESC = "github.com/synapticforge1/universal!wasm!loader-go";
const REPO = "o/r";
const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const TAGOBJ = "c".repeat(40);
const NEWOBJ = "d".repeat(40);
const CHANGELOG = `# Changelog\n\n## [Unreleased]\n\n## [${TAG}] - 2026-11-10\n\n### Fixed\n\n- a thing\n\n## [v1.2.2] - x\n\nold\n\n[${TAG}]: https://x\n`;

type Req = { method: string; path: string; auth: string; body: any };
type Mock = {
  annotated: boolean;
  tagTo: string | null; // null = the tag does not exist on GitHub
  release: any | null;
  postStatus: number;
  readBackDraft: boolean;
  moveTagOnPost: boolean;
  tagPostStatus: number;
  refPointsElsewhere: boolean; // the created ref peels to another commit (a broken write)
  changelog: string | null;
  stall: boolean;
  proxyAfter: number; // the proxy answers 404 this many times, then 200
  proxyHash: string;
  proxyStatus: number; // the status once "served" (200 normally)
  sumdb: boolean;
  reqs: Req[];
};

let server: ReturnType<typeof Bun.serve> | null = null;
let cwd: string | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = null;
});

function mock(over: Partial<Mock> = {}): Mock {
  const m: Mock = {
    annotated: true, tagTo: COMMIT, release: null, postStatus: 201, readBackDraft: false, moveTagOnPost: false,
    tagPostStatus: 201, refPointsElsewhere: false, changelog: CHANGELOG, stall: false, proxyAfter: 0, proxyHash: COMMIT,
    proxyStatus: 200, sumdb: true, reqs: [], ...over,
  };
  let proxyCalls = 0;
  let createdTagObj: string | null = null;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const text = req.method === "GET" ? "" : await req.text();
      m.reqs.push({ method: req.method, path: p + u.search, auth: req.headers.get("authorization") ?? "", body: text ? JSON.parse(text) : null });
      if (m.stall) return new Promise<Response>(() => {});
      // --- GitHub ---
      if (p === `/api/repos/${REPO}/git/ref/tags/${TAG}`) {
        if (m.tagTo === null) return new Response("{}", { status: 404 });
        if (createdTagObj) return Response.json({ object: { type: "tag", sha: createdTagObj } });
        return Response.json({ object: m.annotated ? { type: "tag", sha: TAGOBJ } : { type: "commit", sha: m.tagTo } });
      }
      if (p === `/api/repos/${REPO}/git/tags/${TAGOBJ}` || (createdTagObj && p === `/api/repos/${REPO}/git/tags/${createdTagObj}`)) {
        return Response.json({ object: { type: "commit", sha: m.tagTo } });
      }
      if (req.method === "POST" && p === `/api/repos/${REPO}/git/tags`) {
        if (m.tagPostStatus !== 201) return new Response('{"message":"no"}', { status: m.tagPostStatus });
        return Response.json({ sha: NEWOBJ }, { status: 201 });
      }
      if (req.method === "POST" && p === `/api/repos/${REPO}/git/refs`) {
        const b = JSON.parse(text);
        createdTagObj = b.sha;
        m.tagTo = m.refPointsElsewhere ? OTHER : COMMIT;
        return Response.json({ ref: b.ref }, { status: 201 });
      }
      if (p === `/api/repos/${REPO}/contents/CHANGELOG.md`) return m.changelog === null ? new Response("{}", { status: 404 }) : new Response(m.changelog);
      if (req.method === "GET" && p === `/api/repos/${REPO}/releases/tags/${TAG}`) return m.release ? Response.json(m.release) : new Response("{}", { status: 404 });
      if (req.method === "POST" && p === `/api/repos/${REPO}/releases`) {
        if (m.postStatus !== 201) return new Response('{"message":"Validation Failed"}', { status: m.postStatus });
        const b = JSON.parse(text);
        m.release = { id: 1, tag_name: b.tag_name, name: b.name, body: b.body, draft: m.readBackDraft, html_url: "u" };
        if (m.moveTagOnPost) m.tagTo = OTHER;
        return Response.json(m.release, { status: 201 });
      }
      // --- the Go proxy and sumdb ---
      if (p === `/proxy/${ESC}/@v/${TAG}.info`) {
        if (proxyCalls++ < m.proxyAfter) return new Response("not found", { status: 404 });
        if (m.proxyStatus !== 200) return new Response("bad", { status: m.proxyStatus });
        return Response.json({ Version: TAG, Origin: { VCS: "git", Hash: m.proxyHash, Ref: `refs/tags/${TAG}` } });
      }
      if (p === `/proxy/${ESC}/@v/${TAG}.mod`) return new Response(`module ${MOD}\n\ngo 1.26.4\n`);
      if (p === `/sumdb/lookup/${ESC}@${TAG}`) {
        return m.sumdb ? new Response(`123\n${MOD} ${TAG} h1:abc=\n${MOD} ${TAG}/go.mod h1:def=\n`) : new Response("not found", { status: 404 });
      }
      return new Response(`unexpected ${req.method} ${p}`, { status: 500 });
    },
  });
  return m;
}

async function run(cmd: string, opts: { dry?: boolean; token?: boolean; timeoutMs?: number; tag?: string | null; changelogFile?: string | null } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(GITHUB_|RELEASE_|GOPROXY|GOSUMDB|PROXY_)/.test(k)) env[k] = v;
  const base = `http://127.0.0.1:${server!.port}`;
  cwd = mkdtempSync(join(tmpdir(), "uwl-go-ci-"));
  Object.assign(env, {
    GITHUB_REPOSITORY: REPO, RELEASE_SHA: COMMIT, GITHUB_API_URL: `${base}/api`, GOPROXY_URL: `${base}/proxy`, GOSUMDB_URL: `${base}/sumdb`,
    PROXY_WAIT_MS: "3000", PROXY_POLL_MS: "50", GITHUB_OUTPUT: join(cwd, "out.txt"),
  });
  if (opts.tag !== null) env.RELEASE_TAG = opts.tag ?? TAG;
  if (opts.token !== false) env.GITHUB_TOKEN = "t0k";
  if (opts.timeoutMs) env.RELEASE_TIMEOUT_MS = String(opts.timeoutMs);
  if (opts.changelogFile !== null) writeFileSync(join(cwd, "CHANGELOG.md"), opts.changelogFile ?? CHANGELOG);
  const child = Bun.spawn(["bun", SCRIPT, cmd, ...(opts.dry ? ["--dry-run"] : [])], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let outputs = "";
  try {
    outputs = readFileSync(join(cwd, "out.txt"), "utf8");
  } catch {}
  return { code, out: out + err, outputs };
}

const writes = (m: Mock) => m.reqs.filter((r) => r.method !== "GET");

// --- state (U5) ---

test("state: version untagged on GitHub → new (the top versioned heading, [Unreleased] skipped)", async () => {
  mock({ tagTo: null });
  const r = await run("state", { tag: null });
  expect(r.code).toBe(0);
  expect(r.outputs).toContain("release=new");
  expect(r.outputs).toContain(`tag=${TAG}`);
});

test("state: tag on THIS commit → rerun", async () => {
  mock();
  const r = await run("state", { tag: null });
  expect(r.outputs).toContain("release=rerun");
});

test("state: tag on another commit → none (an ordinary push)", async () => {
  mock({ tagTo: OTHER });
  const r = await run("state", { tag: null });
  expect(r.code).toBe(0);
  expect(r.outputs).toContain("release=none");
});

test("state: no versioned heading → none; no CHANGELOG.md → exit 1", async () => {
  const m = mock();
  const r = await run("state", { tag: null, changelogFile: "# Changelog\n\n## [Unreleased]\n" });
  expect(r.outputs).toContain("release=none");
  expect(m.reqs).toHaveLength(0);
  const r2 = await run("state", { tag: null, changelogFile: null });
  expect(r2.code).toBe(1);
});

// --- tag (U6) ---

test("tag: absent → annotated tag created on the commit, Bearer, read back", async () => {
  const m = mock({ tagTo: null });
  const r = await run("tag");
  expect(r.code).toBe(0);
  const w = writes(m);
  expect(w.map((q) => q.path)).toEqual([`/api/repos/${REPO}/git/tags`, `/api/repos/${REPO}/git/refs`]);
  expect(w[0]!.auth).toBe("Bearer t0k");
  expect(w[0]!.body).toMatchObject({ tag: TAG, object: COMMIT, type: "commit" });
  expect(w[1]!.body).toEqual({ ref: `refs/tags/${TAG}`, sha: NEWOBJ });
  expect(r.out).toContain("read back");
});

test("tag: already on this commit → done, no write", async () => {
  const m = mock();
  const r = await run("tag");
  expect(r.code).toBe(0);
  expect(r.out).toContain("nothing to do");
  expect(writes(m)).toHaveLength(0);
});

test("tag: already on ANOTHER commit → refused, no write (a tag never moves)", async () => {
  const m = mock({ tagTo: OTHER });
  const r = await run("tag");
  expect(r.code).toBe(1);
  expect(r.out).toContain("never moves");
  expect(writes(m)).toHaveLength(0);
});

test("tag: the created ref reads back elsewhere → exit 1", async () => {
  mock({ tagTo: null, refPointsElsewhere: true });
  const r = await run("tag");
  expect(r.code).toBe(1);
  expect(r.out).toContain("read-back");
});

test("tag: POST git/tags refused → exit 1, no ref written", async () => {
  const m = mock({ tagTo: null, tagPostStatus: 422 });
  const r = await run("tag");
  expect(r.code).toBe(1);
  expect(writes(m).filter((q) => q.path.endsWith("/git/refs"))).toHaveLength(0);
});

test("tag: dry-run and no token → no write", async () => {
  const m = mock({ tagTo: null });
  expect((await run("tag", { dry: true })).code).toBe(0);
  expect((await run("tag", { token: false })).code).toBe(1);
  expect(writes(m)).toHaveLength(0);
});

// --- page (U7) ---

test("page: creates it — link on top, CHANGELOG section at the commit, generated notes, read back", async () => {
  const m = mock();
  const r = await run("page");
  expect(r.code).toBe(0);
  const post = writes(m)[0]!;
  expect(post.body.generate_release_notes).toBe(true);
  expect(post.body.body.split("\n")[0]).toContain(`pkg.go.dev/${MOD}@${TAG}`);
  expect(post.body.body).toContain("### Fixed\n\n- a thing");
  expect(post.body.body).not.toContain("old");
  expect(m.reqs.some((q) => q.path === `/api/repos/${REPO}/contents/CHANGELOG.md?ref=${COMMIT}`)).toBe(true);
});

test("page: missing tag or another commit → refused, no write", async () => {
  const m = mock({ tagTo: null });
  expect((await run("page")).code).toBe(1);
  m.tagTo = OTHER;
  expect((await run("page")).code).toBe(1);
  expect(writes(m)).toHaveLength(0);
});

test("page: already there → done, no write", async () => {
  const m = mock({ release: { id: 1, tag_name: TAG, name: TAG, body: "x", draft: false, html_url: "u" } });
  const r = await run("page");
  expect(r.code).toBe(0);
  expect(writes(m)).toHaveLength(0);
});

test("page: 422, draft read-back, tag moved by the POST → each exit 1", async () => {
  mock({ postStatus: 422 });
  expect((await run("page")).code).toBe(1);
  server!.stop(true);
  mock({ readBackDraft: true });
  expect((await run("page")).out).toContain("draft");
  server!.stop(true);
  mock({ moveTagOnPost: true });
  expect((await run("page")).out).toContain("after the POST");
});

// --- proxy (U8) ---

test("proxy: served from this commit, .mod and sumdb present → exit 0, escaped path", async () => {
  const m = mock();
  const r = await run("proxy");
  expect(r.code).toBe(0);
  expect(r.out).toContain(`h1:abc=`);
  expect(m.reqs.some((q) => q.path === `/proxy/${ESC}/@v/${TAG}.info`)).toBe(true);
  expect(writes(m)).toHaveLength(0);
});

test("proxy: 404 at first, then served → polls and passes", async () => {
  const m = mock({ proxyAfter: 3 });
  const r = await run("proxy");
  expect(r.code).toBe(0);
  expect(m.reqs.filter((q) => q.path.endsWith(".info"))).toHaveLength(4);
});

test("proxy: never served within the wait → exit 1", async () => {
  mock({ proxyAfter: 1_000_000 });
  const r = await run("proxy");
  expect(r.code).toBe(1);
  expect(r.out).toContain("does not serve");
});

test("proxy: Origin.Hash is another commit → exit 1 (FATAL)", async () => {
  mock({ proxyHash: OTHER });
  const r = await run("proxy");
  expect(r.code).toBe(1);
  expect(r.out).toContain("Origin.Hash");
});

test("proxy: sumdb has no line → exit 1; a proxy 500 → exit 1", async () => {
  mock({ sumdb: false });
  const r = await run("proxy");
  expect(r.code).toBe(1);
  expect(r.out).toContain("sum.golang.org has no");
  server!.stop(true);
  mock({ proxyStatus: 500 });
  expect((await run("proxy")).code).toBe(1);
});

test("a stalled API fails at the time limit instead of hanging (7.21)", async () => {
  mock({ stall: true });
  const start = Date.now();
  const r = await run("tag", { timeoutMs: 300 });
  expect(r.code).toBe(1);
  expect(r.out).toContain("timed out after 300 ms");
  expect(Date.now() - start).toBeLessThan(10_000);
}, 15_000);
