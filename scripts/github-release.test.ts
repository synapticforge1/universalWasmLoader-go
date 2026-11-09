// Tests for scripts/github-release.ts (workspace H32's order) against a mock GitHub REST API.
// Run: `bun test scripts/` (CI's `checks` job runs it). The script runs as a CHILD process with
// Bun.spawn — never spawnSync, which would block this process's event loop and the mock with it.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "github-release.ts");
const REPO = "o/r";
const TAG = "v1.2.3";
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const TAGOBJ = "c".repeat(40);
const CHANGELOG = `# Changelog\n\n## [${TAG}] - 2026-11-09\n\n### Fixed\n\n- a thing\n\n## [v1.2.2] - x\n\nold\n\n[${TAG}]: https://x\n`;

type Req = { method: string; path: string; auth: string; body: any };
type Mock = {
  annotated: boolean; // the tag ref points at a tag object
  tagTo: string | null; // null = the tag does not exist
  release: any | null;
  postStatus: number;
  readBackDraft: boolean;
  moveTagOnPost: boolean;
  changelog: string | null; // null = 404
  stall: boolean; // never answer
  reqs: Req[];
};

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
});

function mock(over: Partial<Mock> = {}): Mock {
  const m: Mock = { annotated: true, tagTo: COMMIT, release: null, postStatus: 201, readBackDraft: false, moveTagOnPost: false, changelog: CHANGELOG, stall: false, reqs: [], ...over };
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname;
      const text = req.method === "GET" ? "" : await req.text();
      m.reqs.push({ method: req.method, path: p + u.search, auth: req.headers.get("authorization") ?? "", body: text ? JSON.parse(text) : null });
      if (m.stall) return new Promise<Response>(() => {}); // never answers
      if (p === `/repos/${REPO}/git/ref/tags/${TAG}`) {
        if (m.tagTo === null) return new Response("{}", { status: 404 });
        return Response.json({ object: m.annotated ? { type: "tag", sha: TAGOBJ } : { type: "commit", sha: m.tagTo } });
      }
      if (p === `/repos/${REPO}/git/tags/${TAGOBJ}`) return Response.json({ object: { type: "commit", sha: m.tagTo } });
      if (p === `/repos/${REPO}/contents/CHANGELOG.md`) return m.changelog === null ? new Response("{}", { status: 404 }) : new Response(m.changelog);
      if (req.method === "GET" && p === `/repos/${REPO}/releases/tags/${TAG}`) {
        return m.release ? Response.json(m.release) : new Response("{}", { status: 404 });
      }
      if (req.method === "POST" && p === `/repos/${REPO}/releases`) {
        if (m.postStatus !== 201) return new Response('{"message":"Validation Failed"}', { status: m.postStatus });
        const b = JSON.parse(text);
        m.release = { id: 1, tag_name: b.tag_name, name: b.name, body: b.body, draft: m.readBackDraft, html_url: "u" };
        if (m.moveTagOnPost) m.tagTo = OTHER;
        return Response.json(m.release, { status: 201 });
      }
      return new Response(`unexpected ${req.method} ${p}`, { status: 500 });
    },
  });
  return m;
}

async function run(opts: { dry?: boolean; token?: boolean; timeoutMs?: number } = {}) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(GITHUB_|RELEASE_)/.test(k)) env[k] = v;
  Object.assign(env, { GITHUB_REPOSITORY: REPO, RELEASE_TAG: TAG, RELEASE_SHA: COMMIT, GITHUB_API_URL: `http://127.0.0.1:${server!.port}` });
  if (opts.token !== false) env.GITHUB_TOKEN = "t0k";
  if (opts.timeoutMs) env.RELEASE_TIMEOUT_MS = String(opts.timeoutMs);
  const child = Bun.spawn(["bun", SCRIPT, ...(opts.dry ? ["--dry-run"] : [])], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out: out + err };
}

const writes = (m: Mock) => m.reqs.filter((r) => r.method !== "GET");

test("annotated tag: creates the page — link on top, CHANGELOG section, generated notes, Bearer", async () => {
  const m = mock();
  const r = await run();
  expect(r.code).toBe(0);
  expect(writes(m)).toHaveLength(1);
  const post = writes(m)[0]!;
  expect(post.auth).toBe("Bearer t0k");
  expect(post.body.tag_name).toBe(TAG);
  expect(post.body.generate_release_notes).toBe(true);
  expect(post.body.body.split("\n")[0]).toContain(`pkg.go.dev/github.com/synapticforge1/universalWasmLoader-go@${TAG}`);
  expect(post.body.body).toContain("### Fixed\n\n- a thing");
  expect(post.body.body).not.toContain("old");
  expect(m.reqs.some((q) => q.path === `/repos/${REPO}/contents/CHANGELOG.md?ref=${COMMIT}`)).toBe(true);
});

test("lightweight tag: creates the page", async () => {
  const m = mock({ annotated: false });
  expect((await run()).code).toBe(0);
  expect(writes(m)).toHaveLength(1);
});

test("missing tag: refused, no write (a POST would create it)", async () => {
  const m = mock({ tagTo: null });
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("does not exist");
  expect(writes(m)).toHaveLength(0);
});

test("tag at another commit: refused, no write", async () => {
  const m = mock({ tagTo: OTHER });
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("refusing");
  expect(writes(m)).toHaveLength(0);
});

test("a page already there: done, no write", async () => {
  const m = mock({ release: { id: 1, tag_name: TAG, name: TAG, body: "anything", draft: false, html_url: "u" } });
  const r = await run();
  expect(r.code).toBe(0);
  expect(r.out).toContain("already exists");
  expect(writes(m)).toHaveLength(0);
});

test("POST 422: exit 1", async () => {
  const m = mock({ postStatus: 422 });
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("HTTP 422");
  expect(writes(m)).toHaveLength(1);
});

test("read-back as a draft: exit 1", async () => {
  mock({ readBackDraft: true });
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("draft");
});

test("tag moved by the POST: exit 1 (the second peel)", async () => {
  mock({ moveTagOnPost: true });
  const r = await run();
  expect(r.code).toBe(1);
  expect(r.out).toContain("after the POST");
});

test("no CHANGELOG section: the link and the generated notes stand alone", async () => {
  const m = mock({ changelog: null });
  expect((await run()).code).toBe(0);
  expect(writes(m)[0]!.body.body.split("\n")).toHaveLength(1);
});

test("dry-run: no write", async () => {
  const m = mock();
  const r = await run({ dry: true });
  expect(r.code).toBe(0);
  expect(r.out).toContain("dry-run: would POST");
  expect(writes(m)).toHaveLength(0);
});

test("no token: no write, exit 1", async () => {
  const m = mock();
  const r = await run({ token: false });
  expect(r.code).toBe(1);
  expect(writes(m)).toHaveLength(0);
});

test("a stalled API: fails at the time limit instead of hanging (7.21)", async () => {
  mock({ stall: true });
  const start = Date.now();
  const r = await run({ timeoutMs: 300 });
  expect(r.code).toBe(1);
  expect(r.out).toContain("timed out after 300 ms");
  expect(Date.now() - start).toBeLessThan(10_000);
}, 15_000);
