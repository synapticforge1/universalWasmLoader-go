// bun scripts/release.ts [--dry-run] — the local half of a release (workspace letter H33,
// release-process.md § 5 U4; owner, 2026-11-10: "CI to check first, then push the tag, and then
// create the release page from the tag, then publish the package to the registry").
//
// Run it after `bun scripts/bump.ts <level>` has made the `bump to vX.Y.Z` commit. It refuses
// unless:
//   - the tree is clean (untracked files count) and the branch is `main`;
//   - HEAD is GitHub's `main` plus exactly that one bump commit (read with `git ls-remote`);
//   - CHANGELOG.md's top `## [vX.Y.Z]` names the bumped version;
//   - the tag is absent here AND on GitHub, and the Go proxy does not serve the version;
//   - the cold gate passes: go build, go vet, go test -count=1, bun test scripts/, and
//     `compat.ts --release vX.Y.Z` (floor + previous-tag tests on the untagged candidate).
// Then it pushes `main` ONLY and reads it back. It makes and pushes NO tag, ever: CI tags after
// its own checks (U6), then makes the Release page (U7), then reads the proxy back (U8).
//
// `--dry-run` runs every guard and the gate and pushes nothing. GOPROXY_URL overrides the proxy
// (a rehearsal's mock); the remote is `origin`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, git, run } from "./compat.ts";

const MODULE = "github.com/synapticforge1/universalWasmLoader-go";
const args = Bun.argv.slice(2);
const dryRun = args.includes("--dry-run");
for (const a of args) {
  if (a !== "--dry-run") {
    console.error(`usage: bun scripts/release.ts [--dry-run]   (unknown argument "${a}")`);
    process.exit(2);
  }
}

function blocked(msg: string): never {
  console.error(`BLOCKED: ${msg}`);
  process.exit(1);
}

function remoteRef(ref: string): string | null {
  const out = git(["ls-remote", "origin", ref]).trim();
  if (out === "") return null;
  return out.split(/\s+/)[0]!;
}

const escapePath = (p: string) => p.replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`);

// --- guards ---
if (git(["status", "--porcelain"]).trim() !== "") blocked("the working tree is not clean (untracked files count)");
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
if (branch !== "main") blocked(`on branch "${branch}", not main`);
const head = git(["rev-parse", "HEAD"]).trim();
const remoteMain = remoteRef("refs/heads/main");
if (remoteMain === null) blocked("origin has no main branch");
const parent = git(["rev-parse", "HEAD^"]).trim();
const subject = git(["log", "-1", "--format=%s"]).trim();
const m = subject.match(/^bump to (v\d+\.\d+\.\d+)$/);
if (!m) blocked(`HEAD is "${subject}", not a "bump to vX.Y.Z" commit — run bun scripts/bump.ts <level> first`);
const tag = m[1]!;
if (parent !== remoteMain) blocked(`HEAD must be origin's main (${remoteMain.slice(0, 7)}) plus exactly the bump commit; its parent is ${parent.slice(0, 7)}`);
const changelog = existsSync(join(ROOT, "CHANGELOG.md")) ? readFileSync(join(ROOT, "CHANGELOG.md"), "utf8") : "";
const top = changelog.match(/^## \[(v\d+\.\d+\.\d+)\]/m)?.[1];
if (top !== tag) blocked(`CHANGELOG.md's top version is ${top ?? "(none)"}, the bump commit says ${tag}`);
if (git(["tag", "--list", tag]).trim() !== "") blocked(`the tag ${tag} exists locally — CI makes the tag; delete the local one`);
if (remoteRef(`refs/tags/${tag}`) !== null) blocked(`the tag ${tag} already exists on origin`);

// Read the module's version LIST, never `@v/<tag>.info`: asking the proxy for a version before its
// tag exists makes it CACHE the miss ("unknown revision"), and CI's read-back then times out on
// that cached 404 (v0.3.4, 2026-11-10, run 42892298910 — best-practices L3).
const proxy = (process.env.GOPROXY_URL || "https://proxy.golang.org").replace(/\/+$/, "");
const listUrl = `${proxy}/${escapePath(MODULE)}/@v/list`;
let listed: string[];
try {
  const res = await fetch(listUrl, { signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (res.status !== 200) blocked(`the proxy answered HTTP ${res.status} for ${listUrl}`);
  listed = text.split(/\s+/).filter(Boolean);
} catch (e) {
  blocked(`could not read the proxy's version list: ${(e as Error).message}`);
}
if (listed.includes(tag)) blocked(`the Go proxy already lists ${MODULE}@${tag}`);
console.log(`guards: clean, on main = origin/main + "bump to ${tag}", ${tag} absent here, on origin and on the proxy`);

// --- the cold gate ---
const gate: [string, string[]][] = [
  ["go build", ["go", "build", "./..."]],
  ["go vet", ["go", "vet", "./..."]],
  ["go test", ["go", "test", "-count=1", "./..."]],
  ["bun test scripts/", ["bun", "test", "scripts/"]],
  [`compat --release ${tag}`, ["bun", "scripts/compat.ts", "--release", tag]],
];
for (const [name, cmd] of gate) {
  const r = run(cmd);
  if (r.code !== 0) {
    console.error(r.out);
    blocked(`the gate failed at ${name} (exit ${r.code})`);
  }
  console.log(`gate: ${name} ok`);
}
if (git(["status", "--porcelain"]).trim() !== "") blocked("the gate left the tree dirty");

if (dryRun) {
  console.log(`--dry-run: would push main (${head.slice(0, 7)}, "bump to ${tag}") to origin; nothing pushed`);
  process.exit(0);
}

// --- push main ONLY, read back ---
const push = run(["git", "push", "origin", "refs/heads/main:refs/heads/main"]);
if (push.code !== 0) {
  console.error(push.out);
  blocked("git push of main failed");
}
const after = remoteRef("refs/heads/main");
if (after !== head) blocked(`read-back: origin's main is ${after}, not ${head}`);
if (remoteRef(`refs/tags/${tag}`) !== null) blocked(`read-back: a tag ${tag} appeared on origin — this script never pushes one`);
console.log(`pushed main = ${head} (read back with ls-remote); no tag pushed.`);
console.log(`CI now checks ${head.slice(0, 7)}, then tags ${tag}, makes the Release page, and reads the Go proxy back.`);
