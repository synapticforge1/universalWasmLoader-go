// bun scripts/bump.ts patch|minor|major — prepare a release, gated (workspace
// layout-and-packaging.md § "The compatibility gate", Rule 2). A Go module has no version line:
// the version IS the git tag. So this script computes the next version from the last tag,
// refuses a bump below the surface floor (Rule 6: a 0.y.z minor may stand for a major floor
// only with README's Breaking Changes row), runs the previous tag's tests for a compatible
// step (Rule 3), and then stamps CHANGELOG.md (`## [Unreleased]` → `## [vX.Y.Z] - <date>` +
// the link ref) and README.md (`| _next release_` → `| vX.Y.Z`).
//
// It does NOT commit, tag or push: review the diff, commit it as `release: vX.Y.Z`, and the
// owner tags and pushes (a pushed `v*` tag publishes — .github/workflows/release.yml).
// `--dry-run` prints the decision and changes nothing.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT, type Level, LEVELS, assertSnapshotCurrent, breakingRow, bumpVersion, describeTests, floorOf,
  git, previousTests, rank, releaseTags, snapshot, surfaceAt,
} from "./compat.ts";

const args = Bun.argv.slice(2);
const kind = args.find((a) => !a.startsWith("--")) as Level | undefined;
const dryRun = args.includes("--dry-run");
if (!kind || !LEVELS.includes(kind) || args.filter((a) => !a.startsWith("--")).length !== 1) {
  console.error("usage: bun scripts/bump.ts patch|minor|major [--dry-run]");
  process.exit(2);
}

function main(): number {
  if (!dryRun && git(["status", "--porcelain"]).trim() !== "") {
    console.error("BLOCKED: the working tree is not clean; the gate must run on committed code");
    return 1;
  }
  assertSnapshotCurrent();
  const prevTag = releaseTags()[0];
  if (!prevTag) {
    console.error("no release tag to bump from");
    return 1;
  }
  const next = bumpVersion(prevTag, kind!);
  const f = floorOf(surfaceAt(prevTag), snapshot());
  console.log(`${prevTag} -> ${next} (${kind}); floor: ${f.floor}`);
  for (const r of f.reasons) console.log(`  ${r}`);

  const compatible = rank(kind!) >= rank(f.floor);
  const pre1 = prevTag.startsWith("v0.");
  if (!compatible) {
    const r6 = pre1 && kind === "minor" && f.floor === "major" && breakingRow("_next release_");
    if (!r6) {
      console.error(`BLOCKED: ${kind} is below the floor (${f.floor})` +
        (pre1 && f.floor === "major" ? "; under Rule 6 a 0.y minor needs README's Breaking Changes row \"| _next release_\"" : ""));
      return 1;
    }
    console.log("Rule 6: a pre-1.0 minor where the floor is major; README Breaking Changes row present");
  }
  if (kind !== "major") {
    const r = previousTests(prevTag);
    console.log(describeTests(prevTag, r));
    if (!r.ok && compatible) {
      console.error(r.out);
      console.error(`BLOCKED: a compatible ${kind} bump requires ${prevTag}'s tests to pass`);
      return 1;
    }
  }
  if (dryRun) {
    console.log("--dry-run: nothing written");
    return 0;
  }

  const date = new Date().toISOString().slice(0, 10);
  const clPath = join(ROOT, "CHANGELOG.md");
  let cl = readFileSync(clPath, "utf8");
  if (!cl.includes("## [Unreleased]")) {
    console.error("BLOCKED: CHANGELOG.md has no `## [Unreleased]` section to release");
    return 1;
  }
  cl = cl.replace("## [Unreleased]", `## [${next}] - ${date}`);
  const ref = `[${next}]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/${next}`;
  cl = cl.replace(/^\[v\d+\.\d+\.\d+\]: /m, (m) => `${ref}\n${m}`);
  writeFileSync(clPath, cl);

  const rdPath = join(ROOT, "README.md");
  const rd = readFileSync(rdPath, "utf8");
  if (rd.includes("| _next release_")) writeFileSync(rdPath, rd.replace("| _next release_", `| ${next}`));

  for (const [file, want] of [["CHANGELOG.md", `## [${next}] - ${date}`], ["README.md", null]] as const) {
    const text = readFileSync(join(ROOT, file), "utf8");
    if (want && !text.includes(want)) {
      console.error(`read-back failed: ${file} does not contain ${want}`);
      return 1;
    }
  }
  console.log(`stamped CHANGELOG.md${rd.includes("| _next release_") ? " and README.md" : ""} for ${next}.`);
  console.log(`next: review, \`git commit -F <file>\` as "release: ${next}"; tagging ${next} and pushing are the owner's.`);
  return 0;
}

let code = 1;
try {
  code = main();
} finally {
  rmSync(join(ROOT, ".compat"), { recursive: true, force: true });
}
process.exit(code);
