// The compatibility gate (workspace layout-and-packaging.md § "The compatibility gate",
// Rules 1–3 and 6): the FLOOR a release must meet, and the previous tag's tests run against
// the current code. Modelled on universalWasmLoader-c's scripts/compat.ts.
//
// Usage: bun scripts/compat.ts                  report: last tag, floor, previous-tag tests
//        bun scripts/compat.ts --release vX.Y.Z on the commit tagged vX.Y.Z (CI): the step from
//                                               the tag before it must meet the floor, and the
//                                               previous tests must pass for a compatible step
//        add --no-tests to skip the previous-tag run (floor only); --keep keeps .compat/
//
// The surface is produced by a TEST, never by hand: `go test ./internal/apisurface` reads the
// package with go/ast. For an older tag, the tag's tree is extracted with `git archive` into
// .compat/ (gitignored, deleted after) and the CURRENT surface test reads it with -root, so a
// tag that predates the test (v0.2.0) still has a surface.
//
// Go modules have no version line: the version IS the tag. Rule 6 (pre-1.0): a 0.y.z minor
// may stand where the floor says major, if README's "Breaking Changes" table has the row.
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
const COMPAT = join(ROOT, ".compat");

export type Level = "patch" | "minor" | "major";
export const LEVELS: Level[] = ["patch", "minor", "major"];
export const rank = (l: Level) => LEVELS.indexOf(l);
const maxLevel = (a: Level, b: Level): Level => (rank(a) >= rank(b) ? a : b);

export function parseVersion(v: string): [number, number, number] {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`not a MAJOR.MINOR.PATCH version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export function levelOf(from: string, to: string): Level {
  if (compareVersions(from, to) >= 0) throw new Error(`${to} is not above ${from}`);
  const [a, b] = [parseVersion(from), parseVersion(to)];
  if (b[0] !== a[0]) return "major";
  if (b[1] !== a[1]) return "minor";
  return "patch";
}

export function bumpVersion(v: string, kind: Level): string {
  const [x, y, z] = parseVersion(v);
  if (kind === "major") return `v${x + 1}.0.0`;
  if (kind === "minor") return `v${x}.${y + 1}.0`;
  return `v${x}.${y}.${z + 1}`;
}

export function run(cmd: string[], cwd = ROOT): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString() + p.stderr.toString() };
}

export function git(args: string[]): string {
  const r = run(["git", ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.out.trim()}`);
  return r.out;
}

/** Release tags reachable from HEAD, highest first. */
export function releaseTags(): string[] {
  return git(["tag", "--merged", "HEAD", "--list", "v*"])
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => compareVersions(b, a));
}

/** Extract `paths` of `ref` into dir (relative tar paths: GNU tar reads `X:\…` as host:path). */
function extract(ref: string, dir: string, paths: string[]) {
  mkdirSync(dir, { recursive: true });
  const present = paths.filter((p) => run(["git", "cat-file", "-e", `${ref}:${p}`]).code === 0);
  if (present.length === 0) return;
  const tar = run(["git", "archive", "--format=tar", "-o", join(dir, "x.tar"), ref, ...present]);
  if (tar.code !== 0) throw new Error(`git archive ${ref} failed: ${tar.out.trim()}`);
  const x = run(["tar", "-xf", "x.tar"], dir);
  if (x.code !== 0) throw new Error(`tar -xf failed: ${x.out.trim()}`);
  rmSync(join(dir, "x.tar"));
}

function goFilesAt(ref: string): string[] {
  return git(["ls-tree", "--name-only", ref])
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => f.endsWith(".go") || f === "go.mod" || f === "go.sum");
}

export type Surface = { lines: string[]; spec: string; module: string };

function parseSurface(text: string): Surface {
  const lines = text.split("\n").filter((l) => l !== "");
  const spec = lines.find((l) => l.startsWith("spec: "))?.slice(6) ?? "";
  const module = lines.find((l) => l.startsWith("module: "))?.slice(8) ?? "";
  if (!spec || !module) throw new Error("a surface must have its module: and spec: lines");
  return { lines, spec, module };
}

/** The surface of a tree on disk, by the CURRENT surface test. */
function surfaceOfDir(dir: string): Surface {
  const outFile = join(COMPAT, `surface-${Date.now()}.txt`);
  mkdirSync(COMPAT, { recursive: true });
  const r = run(["go", "test", "-count=1", "-run", "^TestAPISurface$", "./internal/apisurface", "-args", `-root=${dir}`, `-out=${outFile}`]);
  if (r.code !== 0) throw new Error(`surface of ${dir} failed:\n${r.out}`);
  const s = parseSurface(readFileSync(outFile, "utf8"));
  rmSync(outFile);
  return s;
}

export function surfaceAt(ref: string): Surface {
  const dir = join(COMPAT, `tree-${ref}`);
  rmSync(dir, { recursive: true, force: true });
  extract(ref, dir, goFilesAt(ref));
  try {
    return surfaceOfDir(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function snapshot(): Surface {
  return parseSurface(readFileSync(join(ROOT, "api-surface.txt"), "utf8"));
}

/** Rule 2: a line only in prev (removed or changed) → major; only in next → minor.
 *  The SPEC version moves the floor by its own level (lowered: major); a module path change is major. */
export function floorOf(prev: Surface, next: Surface): { floor: Level; reasons: string[] } {
  let floor: Level = "patch";
  const reasons: string[] = [];
  const p = new Set(prev.lines.filter((l) => !/^(spec|module): /.test(l)));
  const n = new Set(next.lines.filter((l) => !/^(spec|module): /.test(l)));
  for (const l of p) if (!n.has(l)) { floor = "major"; reasons.push(`major: removed or changed: ${l}`); }
  for (const l of n) if (!p.has(l)) { floor = maxLevel(floor, "minor"); reasons.push(`minor: added: ${l}`); }
  if (prev.module !== next.module) { floor = "major"; reasons.push(`major: module path ${prev.module} -> ${next.module}`); }
  if (prev.spec !== next.spec) {
    const lowered = compareVersions(next.spec, prev.spec) < 0;
    const l: Level = lowered ? "major" : levelOf(prev.spec, next.spec);
    floor = maxLevel(floor, l);
    reasons.push(`${l}: SPEC ${prev.spec} -> ${next.spec}${lowered ? " (lowered)" : ""}`);
  }
  return { floor, reasons };
}

/** Rule 6: may a 0.y.z `step` stand below `floor`? Only a minor for a major floor, with the README row. */
export function rule6Allows(version: string, step: Level, floor: Level, row: string): boolean {
  return parseVersion(version)[0] === 0 && step === "minor" && floor === "major" && breakingRow(row);
}

/** README's Breaking Changes table has a row whose first cell starts with `label`. */
export function breakingRow(label: string): boolean {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const table = readme.split(/^### ⚠️ Breaking Changes\s*$/m)[1]?.split(/^#{1,3} /m)[0] ?? "";
  return table.split("\n").some((l) => l.startsWith(`| ${label}`));
}

export type TestResult = { ok: boolean; passed: number; failed: number; code: number; out: string; fixtures: string };

/** Rule 3: the tag's *_test.go (and its tests/ fixtures; the current ones if it has none) against
 *  the CURRENT non-test sources. The verdict is read from the OUTPUT, not only the exit code. */
export function previousTests(tag: string, keep = false): TestResult {
  const dir = join(COMPAT, "prev");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    for (const f of readdirSync(ROOT)) {
      if ((f.endsWith(".go") && !f.endsWith("_test.go")) || f === "go.mod" || f === "go.sum") copyFileSync(join(ROOT, f), join(dir, f));
    }
    const tagTests = goFilesAt(tag).filter((f) => f.endsWith("_test.go"));
    extract(tag, dir, tagTests);
    let fixtures = `${tag}'s tests/`;
    if (run(["git", "cat-file", "-e", `${tag}:tests/fixtures.json`]).code === 0) {
      extract(tag, dir, ["tests"]);
    } else {
      fixtures = `the CURRENT tests/ (${tag} tracked no fixtures)`;
      extract("HEAD", dir, ["tests"]);
    }
    const r = run(["go", "test", "-count=1", "-v", "."], dir);
    const passed = [...r.out.matchAll(/^--- PASS: /gm)].length;
    const failed = [...r.out.matchAll(/^--- FAIL: /gm)].length;
    return { ok: r.code === 0 && failed === 0 && passed > 0, passed, failed, code: r.code, out: r.out, fixtures };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

export function describeTests(tag: string, r: TestResult): string {
  return `previous-tag tests (${tag}'s *_test.go vs current code, fixtures: ${r.fixtures}): ${r.ok ? "GREEN" : "RED"} — ${r.passed} passed, ${r.failed} failed, exit ${r.code}`;
}

/** The snapshot must be the working tree's surface (the surface test checks the same). */
export function assertSnapshotCurrent() {
  const now = surfaceOfDir(ROOT);
  const snap = snapshot();
  if (now.lines.join("\n") !== snap.lines.join("\n")) {
    console.error("api-surface.txt is stale; see `go test ./internal/apisurface` for the difference.");
    process.exit(1);
  }
}

function printFloor(prevTag: string, f: { floor: Level; reasons: string[] }) {
  console.log(`floor vs ${prevTag}: ${f.floor}`);
  for (const r of f.reasons) console.log(`  ${r}`);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const noTests = args.includes("--no-tests");
  const keep = args.includes("--keep");
  try {
    assertSnapshotCurrent();
    const rel = args.indexOf("--release");
    if (rel !== -1) {
      const version = args[rel + 1] ?? "";
      parseVersion(version);
      const prevTag = releaseTags().find((t) => compareVersions(t, version) < 0);
      if (!prevTag) {
        console.log(`no release before ${version}; nothing to compare`);
        process.exit(0);
      }
      const step = levelOf(prevTag, version);
      const f = floorOf(surfaceAt(prevTag), snapshot());
      console.log(`release ${version} is a ${step} step from ${prevTag}`);
      printFloor(prevTag, f);
      let ok = true;
      let compatible = rank(step) >= rank(f.floor);
      if (!compatible) {
        if (rule6Allows(version, step, f.floor, version)) {
          console.log(`Rule 6: a pre-1.0 minor where the floor is major; README Breaking Changes row "${version}" present`);
        } else {
          console.error(`BLOCKED: ${step} is below the floor (${f.floor})` + (parseVersion(version)[0] === 0 ? ` — under Rule 6 a 0.y minor needs README's Breaking Changes row "| ${version}"` : ""));
          ok = false;
        }
      }
      if (!noTests && step !== "major") {
        const r = previousTests(prevTag, keep);
        console.log(describeTests(prevTag, r));
        if (!r.ok && compatible) {
          console.error(r.out);
          console.error(`BLOCKED: a compatible ${step} release requires the previous tag's tests to pass`);
          ok = false;
        } else if (!r.ok) {
          console.log("(not blocking: the step is a declared breaking change under Rule 6)");
        }
      }
      process.exit(ok ? 0 : 1);
    }

    const prevTag = releaseTags()[0];
    if (!prevTag) {
      console.log("no release tag yet; nothing to compare");
      process.exit(0);
    }
    const f = floorOf(surfaceAt(prevTag), snapshot());
    console.log(`last release tag: ${prevTag}`);
    printFloor(prevTag, f);
    const next = bumpVersion(prevTag, f.floor);
    const pre1 = parseVersion(prevTag)[0] === 0 && f.floor === "major";
    console.log(`next version at the floor: ${next}` + (pre1 ? ` (or ${bumpVersion(prevTag, "minor")} under Rule 6, with the README Breaking Changes row)` : ""));
    if (!noTests) {
      const r = previousTests(prevTag, keep);
      console.log(describeTests(prevTag, r));
      if (!r.ok) {
        console.error(r.out);
        process.exit(1);
      }
    }
  } finally {
    if (!keep) rmSync(COMPAT, { recursive: true, force: true });
  }
}
