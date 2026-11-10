# release.md — how a release runs here, and every release so far

🔒 The ONE place this repo records its releases (owner, 2026-11-10; workspace letter H33, D3).
The workspace's uniform shape is `../../cmem/release-process.md` § 5 (slots U1–U12); this file is
that shape with this repo's commands. Ecosystem: the **Go proxy** — a Go module has no registry
upload; a pushed tag IS the release, so CI's tag (after its checks) is the publish (§ 6, § 8 D1).

## How a release runs

🔒 The owner's order (2026-11-10): **"CI to check first, then push the tag, and then create the
release page from the tag, then publish the package to the registry."** The owner's word
"release" = "push" (memory, commit, merge, push `main`), then this (working-rules § Owner commands).

**Local — the owner's machine, the tooling:**

- **U1 The go and the level** are the owner's; the level is a REQUIRED argument —
  `bun scripts/bump.ts patch|minor|major` (no default; no level → exit 2).
- **U2 Merge first:** the release notes (CHANGELOG `## [Unreleased]`, README's Breaking Changes
  `| _next release_` row for a breaking step) are merged into `main` before the bump. `bump.ts`
  makes the bump its own commit, `bump to vX.Y.Z`, holding only CHANGELOG.md / README.md.
- **U3 `bump.ts`** refuses a dirty tree (untracked files count), a stale `api-surface.txt` and a
  level below the floor (surface diff since the last tag; Rule 6 for 0.y); runs the previous tag's
  tests for a compatible step; stamps CHANGELOG (`## [vX.Y.Z] - <date>` + link ref) and README.
  A Go module has no version line: the top `## [vX.Y.Z]` heading is what arms the release in CI.
- **U4 `bun scripts/release.ts`** (`--dry-run` first): refuses unless the tree is clean, the branch
  is `main`, HEAD = GitHub's `main` + exactly the bump commit, CHANGELOG's top = the bumped version,
  the tag is absent here, on GitHub and on the Go proxy; runs the cold gate (go build, vet,
  `go test -count=1`, `bun test scripts/`, `compat.ts --release vX.Y.Z`); then pushes `main` ONLY
  and reads it back with `git ls-remote`. **No tag, ever** — never `git tag`, never `-f`.

**CI — `.github/workflows/release.yml`, one run per push of `main`:**

- **U5 `checks`** (`contents: read`, tokenless clone, HEAD = `github.sha`): pinned Go + Bun;
  `ci-release.ts state` — new (the top version is untagged), rerun (tagged on THIS commit), or
  none; go build / vet / test, `bun test scripts/`; for a release `compat.ts --release <tag>`,
  otherwise `compat.ts --no-tests`. A non-release push stops here.
- **U6 `tag`** (`contents: write`, no checkout): `ci-release.ts tag` — the annotated tag on
  `github.sha` through `git/tags` + `git/refs`; there already = done, elsewhere = refused; read back.
- **U7 `release`** (`contents: write`, no checkout): `ci-release.ts page` — the GitHub Release page
  FROM the tag, H32's order (tag peels to the commit; an existing page = done; POST with a
  pkg.go.dev link, the CHANGELOG section and generated notes; read back; peel again).
- **U8 `publish`** (`contents: read`, no checkout): `ci-release.ts proxy` — the first request makes
  proxy.golang.org fetch the tag; FATAL unless `.info`'s `Origin.Hash` is the commit and
  `Origin.Ref` the tag, `.mod` is served and sum.golang.org has the `h1:` line. Then U10 in CI:
  `go mod download -json <module>@<tag>` as a user, checksum-verified.
- **U9 Pins:** 0 `uses:`; Go (= `go.mod`'s `go` line) and Bun (Tooling 7: the latest installed,
  1.4.4) by version + sha256, downloads retried and time-limited; top-level `permissions: {}`;
  `concurrency` per ref, never cancelled; 30 s per request in `ci-release.ts` (7.21).

**After:**

- **U10** `go mod download -json …@vX.Y.Z` in CI (above); by hand, `go list -m -json …@vX.Y.Z`
  from a scratch folder.
- **U11** a "Release History" entry below, newest first, with a summary of what changed.
- **U12** a failed job → "Re-run failed jobs": `state` reads "rerun" (the tag peels to this
  commit), and each job skips what is done. Never a new tag for the same code, never a moved tag.

**Proof of this shape (2026-11-10, before it ever ran on GitHub):** `scripts/ci-release.test.ts`
(20 cases, one mock for GitHub, the proxy and sumdb; ten one-line mutants each caught by its own
case); every command read-only against the real services; a rehearsal against a scratch bare
`origin` (bump and every release.ts guard refused with nothing pushed; the real run pushed `main`
= the bump with NO tag; `state` on that commit → "new"). **Unmeasured on GitHub until the first
release in this order.**

## The workflow's history

- 2026-06-24: one job on `v*` tags — build, then the Release from the tag's CHANGELOG section.
- 2026-10-26: the `go vet` + `go test` gate.
- 2026-11-08 (`928d1df`): the compatibility gate `bun scripts/compat.ts --release $TAG`.
- 2026-11-08 (`2ff71ef`, workspace C30): two jobs, no `uses:`; Go and Bun by version + sha256.
  `12e3fb4`: the notes heading matched literally (gawk read the old dynamic regex as a bracket
  expression).
- 2026-11-09 (H30): the page through the REST API (`scripts/github-release.ts`) instead of the
  GitHub CLI; measured by v0.3.1.
- 2026-11-09 (H32, 7.21): the page in H32's order, 30 s per request, no checkout in the write job,
  no backfill trigger; measured by v0.3.2.
- **2026-11-10 (H33, owner's order): CI tags.** Triggered by pushes of `main`; `checks` → `tag`
  → `release` → `publish` in one run; `scripts/ci-release.ts` (state / tag / page / proxy) replaced
  `github-release.ts`; `scripts/release.ts` (local, pushes `main` only); `bump.ts` commits the bump.
  First run v0.3.4 (42892298910): checks, tag and page green; the proxy read-back failed on a miss
  the local guard had made the proxy cache. `3045f67`: the guard reads `@v/list`, never `.info`.

## Release History

Newest first. Each: what changed, then how it was released and read back.

### v0.3.5 — 2026-11-10

**What changed:** no library change. The release script's guard asks proxy.golang.org only for the
module's version LIST, never for the version itself before CI has tagged it — that question made
the proxy cache "not found" and failed v0.3.4's first read-back (best-practices L3).
**Release:** owner: "push and release", level patch. The fix landed with the push (`fee5dec`).
`bump.ts patch` (floor patch; v0.3.4's 20 tests green) committed `5d39a3a` `bump to v0.3.5`;
`release.ts` pushed `main` only. **Run 42904086097, green in every job on its first attempt:**
`checks` ("Is this a release?" → new) → `tag` 21:21:13–15Z, the annotated `v0.3.5` (object
`32cc8b7`, tagger `github-actions[bot]`) on `5d39a3a` → `release` 21:21:22–25Z, the page by
`github-actions[bot]`, not a draft → `publish` 21:21:32–44Z, the proxy served v0.3.5 within 12 s
(`Origin.Hash` = `5d39a3a`, sum.golang.org's `h1:`), then the checksum-verified download. **The
first release in the owner's order with no step by hand after `release.ts`.**

### v0.3.4 — 2026-11-10

**What changed:** no library change. Releases run in the owner's order — the maintainer's script
pushes `main` only; CI checks the commit, then creates the tag, then the Release page from the tag,
then reads the Go proxy and sum.golang.org back (workspace letter H33).
**Release — the first in this order:** owner: "push then release", level patch. The push of
`9dcf277` (run 42892127682) measured the non-release path: `checks` green, `tag` / `release`
skipped. `bump.ts patch` (floor patch; v0.3.3's 20 tests green) committed `ce6698f` `bump to
v0.3.4`; `release.ts` pushed `main` only (no tag). **Run 42892298910:** `checks` green ("Is this a
release?" → new) → `tag` 20:09:08–10Z made the annotated `v0.3.4` (object `e649501`, **tagger
`github-actions[bot]`**) on `ce6698f` → `release` 20:09:17–19Z made the page (by
`github-actions[bot]`, not a draft) → **`publish` FAILED** at 20:14:11Z: the read-back waited its
5 minutes on a CACHED 404 for `@v/v0.3.4.info` ("unknown revision v0.3.4"), while `@v/list`
already listed v0.3.4. Cause: `release.ts`'s own guard had requested that `.info` before the tag
existed (best-practices L3); fixed in `3045f67` (the guard reads `@v/list`; re-rehearsed: no
`.info` request). **The proxy served v0.3.4 at 20:41Z** (polled every 5 min: 404 until 20:36Z,
then 200 — the cached miss lasted about 30 min): `.info` `Origin.Hash` = `ce6698f`, `Ref` =
`refs/tags/v0.3.4`; sum.golang.org `h1:eLDAZJDgHYVEV9Gf+WkGuUl5glPGCC25Yj0xJkK8+t4=`; CI's own
`ci-release.ts proxy` run locally → exit 0. **Re-run (U12), owner, web UI:** attempt 2 of run
42892298910, 21:17:11Z — only `publish` ran (21:17:17–22Z, green: the proxy read-back and the
checksum-verified download); `checks` / `tag` / `release` kept attempt 1's success. **The run is
green; v0.3.4 is complete**, and the re-run path is measured.

### v0.3.3 — 2026-11-09

**What changed:** declares SPEC **4.0.1** — loader-js's § 11.1 port allowance names this loader's
zero-value `LoadOptions{}` (= the 30 s default; negative = error; `NoTimeout` = no limit) as
conformant (owner: "adjust for go"; ledger C35, closed). No behaviour change.
**Release:** `bump.ts patch` (floor patch: `SPEC 4.0.0 -> 4.0.1`; v0.3.2's 20 tests green) →
`805401e` `release: v0.3.3`; annotated tag `v0.3.3` (object `1daff89`), pushed by hand (the order
before H33); CI run 42666702412 green; page by `github-actions[bot]`, 17:39:44Z, not a draft; the
tag still peels to `805401e`; the Go proxy resolves v0.3.3.

### v0.3.2 — 2026-11-09

**What changed:** no library change. Each new tag's Release page is made in H32's order (an
existing page is left alone; the tag is re-checked after the write; no checkout beside the write
token), with a 30 s limit on every request; the page opens with a pkg.go.dev link.
**Release:** `bump.ts patch` (v0.3.1's 20 tests green) → `26f668b`; tag `v0.3.2` (object
`2dc0aa7`); run 42661227267 green in every step of both jobs; **the first page in H32's order**,
by `github-actions[bot]`, 17:06:22Z, with the link, the CHANGELOG section and generated notes; the
tag still peels to `26f668b`.

### v0.3.1 — 2026-11-09

**What changed:** no library change. The release workflow writes the GitHub Release through the
REST API instead of the GitHub CLI (H30).
**Release:** `bump.ts patch` (Rule 3 ran for real: v0.3.0's 20 tests green) → `e1bba28`; tag
`v0.3.1` (object `ac39bc6`); run 42638054957 green; the REST script created page `v0.3.1` by
`github-actions[bot]`, 14:47:40Z; the tag still peels to `e1bba28`.

### v0.3.0 — 2026-11-08

**What changed:** SPEC **4.0.0**, loud failures (breaking, a pre-1.0 minor under Rule 6): only an
absent `.wit` loads raw; strict `.wit` parsing (`u32` no longer read as `s32`); every WIT import
needs a host callback, its signature checked at load and its result checked, never coerced; typed
calls check count, kind and range; raw calls decode by the WASM signature (an `f64` result was its
bit pattern); a 30 s limit on each http(s) fetch (`ImportWithOptions`, `LoadOptions`,
`DefaultTimeout`, `NoTimeout`); a URL's query no longer reaches the `.wit` URL. Also the
compatibility gate (H6) and the two-job release workflow (C30).
**Release:** `bump.ts minor` (floor major: `SPEC 3.0.0 -> 4.0.0` + 5 additions; v0.2.0's 7 tests
green) → `faf46bb`; tag `v0.3.0` (object `b128bb4`); run 42508941015, the first of the two-job
workflow, green; GitHub Release `v0.3.0` with the CHANGELOG notes; proxy warmed with `go list -m`.

### v0.2.0 — 2026-10-20

**What changed:** the module path moved to `github.com/synapticforge1/universalWasmLoader-go`
after the repository's transfer — breaking for importers, no API change (overview § Repository
location).

### v0.1.0 — 2026-06-24

**What changed:** the first public release, under the old `github.com/jrmarcum/…` module path:
the Go port on pure-Go wazero, SPEC 3.0.0 (Canonical ABI, callee-allocated string returns),
`Load` / `Import`, `Call` / `Bind`, host callbacks, `@N` pinning, `CreateSingleton`,
`InstancePool`, WASI Preview 1. Annotated tag pushed; proxy warmed. (Its GitHub Release page was
backfilled once by the old workflow's dispatch.)
