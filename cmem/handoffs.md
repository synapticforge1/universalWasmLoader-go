# handoffs.md — this repo's answers to workspace letters and sibling items

**Policy (owner, 2026-10-26):** answers are recorded HERE, in this repo's own memory. The workspace
session reads them and coordinates its ledger (`../../cmem/workspace-correspondence.md`); this repo
never writes into the workspace or a sibling. Each answer names the commit (or "declined: why") and
what is still open. The workspace, as each item's creator, verifies and closes it.

## Answers, 2026-11-09, later

Rows re-read (owner: "review workspace for items needing this project's attention …"). New:
**H32** (every tagged release's page made by CI, in one order; loader-go is NOT on its change list,
but -dotnet's check against the recipe showed the same kind of gaps here), **C40** (closed;
it made best-practices **7.21**, a time limit on every network fetch in a script), **C41**
(loader-py's survey: "-go 4/4/4", every page by `github-actions[bot]`).

- **H32 — checked against the recipe; four gaps, fixed (local `main`, NOT pushed).** (2) an
  existing page was PATCHed — now done with no write; 7.21 — no time limit per request — now
  30 s each, request to last byte; (3) no second peel and no "not a draft" check — both added;
  C30 / H32 — the `release` job cloned the tag — it now fetches the script alone at `github.sha`.
  `workflow_dispatch` removed (no backfill, owner). Tests committed:
  `scripts/github-release.test.ts` (12 cases, run in `checks`); five mutants each caught only by
  their own case. Real-GitHub dry runs as recorded in overview § the release workflow history.
  **First page by the new order: the next tag** (its `author.login` goes into the H32 cell).
- **C35 (this repo's row) — the workspace's half verified, NOT closed.** Re-derived: H15, H22, H25,
  H29 are `closed`; `projects.md:86` carries loader-go at v0.3.1. Missing: loader-js (also an
  addressee) has not recorded the owner's §11.1 ruling for Go (zero = the default) — no hit in
  `-js/cmem/` or `SPEC.md`. C35 stays open for that one acknowledgement.

## Answers, 2026-11-09

Rows naming loader-go re-read first (owner: "review workspace for items needing this project's
attention …"). New since 2026-11-08: **H30** (change: CI) and **H31** (record). The workspace has
already verified H6 and H28 for this repo, and loader-js verified C29's tag.

- **H30 — no GitHub CLI: done, local `main` only, NOT pushed.** `release.yml:153`–`:156` (the
  letter's lines: the CLI's view / edit / create), and the `awk` notes step, are replaced by
  **`scripts/github-release.ts`** (Bun pinned by sha256, the same 1.4.4 pair as `checks`; the
  REST API with `GITHUB_TOKEN`). The hazard rule comes first: the tag must exist on GitHub and peel
  to the commit `checks` passed. Then the notes come from the tag's CHANGELOG.md section (a tag
  that predates the file reads the default branch's copy). An existing Release has its notes
  PATCHed when they differ, as the CLI's `edit` did. A write is read back. **Proof:** read-only
  against the real GitHub (`--dry-run`): v0.1.0, v0.2.0, v0.3.0 at their commits → "exists with
  these notes", so the new notes equal what the old `awk` + CLI step wrote, byte for byte after
  trim (Tooling 1's output-diff rule); `v0.3.0` at v0.2.0's commit → refused; `v9.9.9` → refused
  ("a release would create it"). A mock REST API covered 8 cases: create (annotated tag peeled,
  `Bearer` sent, notes exact); re-run with the same notes → no write; different notes → PATCH;
  POST 422 → exit 1; `--dry-run`, no token and a moved tag → no write; no CHANGELOG.md → contents
  API. Inverted: with the commit check disabled, exactly "tag moved" went red (it created the
  release). Bun.YAML: `checks` {contents: read} / `release` {contents: write}, 0 `uses:`, 0 CLI
  calls. `git grep -n -w gh -- . ':!cmem' ':!*.md'` → 0 hits. **UNMEASURED on GitHub until the
  next tag run.** Rule recorded: `working-rules.md` Tooling 6.
- **H30, same day (owner: "update the project memory files, commit, push then release"):**
  `c41d421`, `b094de3`, `34d9b38` and `2d1ff09` (header comments re-worded so the re-grep finds 0
  hits) are pushed with this memory update; **v0.3.1** (a patch: floor patch, no library change)
  is the first tag run of `scripts/github-release.ts`. **Measured:** run 42638054957 green in both
  jobs; GitHub Release `v0.3.1` created by `github-actions[bot]` (not a draft, CHANGELOG notes);
  tag `v0.3.1^{}` still `e1bba28` (`ls-remote`). Detail: overview § Release history.
- **H31 — Bun pins: record-only, nothing to move.** `bun --version` = 1.4.4 (measured 2026-11-09);
  the one pin, `release.yml` `BUN_VERSION: 1.4.4` + its sha256, is already current; no minimum Bun
  is declared. Rule recorded: `working-rules.md` Tooling 7.

## Answers, 2026-11-08

Every row of `../../cmem/workspace-correspondence.md` naming loader-go was read first (owner:
"review workspace for items needing this project's attention and make the requested fixes"). Open
for this repo: H6, H15, H22, H25 §3(d), H28, H29, C29; C30 record-only. Work on branch
`spec-4.0.0`, merged `--no-ff` into `main`. (Written before the release; **later the same day
everything was pushed and released as v0.3.0** — see the "RELEASED" bullet below. `origin/main`
carries all of it.)

- **C29 — SPEC 4.0.0: done, `1ee9771`.** All five items. (1) The `.wit` is read BEFORE the
  `.wasm`; raw only when it is absent (`fs.ErrNotExist`, HTTP 404 / 410) or the path does not end
  in `.wasm`; anything else → `cannot read .wit "<path>"` / `HTTP <status> for <url>` /
  `timed out after <limit> fetching <url>` / `cancelled`, before the `.wasm` is fetched. (2) A
  strict parser ported from `wit-parser.js` 2.0.0, same grammar and messages, strict UTF-8 →
  `invalid .wit "<path>": …`; a WIT export the module lacks fails the load. (3) Every import needs a
  callback, all missing named at load; a `string`-result import refused; the callback's static
  signature checked at load; a callback returning `any` checked by value when called (the error
  reaches the export's caller); a channel result (Go's nearest to a Promise) refused. (4) Typed calls
  check count, kind and range, never coercing (`s32`/`s64`: any Go integer in range; `f32`/`f64`:
  `float32`/`float64`; no result accessors → that half n/a). (5) A 30 s limit per http(s) fetch,
  request to last byte (`ImportWithOptions`, `LoadOptions{Timeout}`, `NoTimeout`); `ctx` cancels;
  one request per file. `CreateSingleton` / `NewInstancePool` are file-only (n/a, as -c / -dotnet).
  **The check, § 8 Refusals:** every row is a test (`refusal_test.go`, 11 tests; http rows on an
  `httptest` server that counts requests). `go test`: root 9 → 20, all green, + 1 surface test.
  On v0.2.0's code the 10 compilable new tests are all red; 8 single mutants on the new code each
  turn exactly their own test red. **Version decision: v0.3.0** — gate floor major
  (`SPEC 3.0.0 -> 4.0.0` + 5 additions); pre-1.0 Rule 6 minor with README's Breaking Changes row;
  v0.2.0's 7 tests GREEN on the new code; fixtures unchanged (12/12 as stamped). Not bumped; the
  release is the owner's. **Port divergence for -js:** SPEC §11.1 makes a zero limit an error; Go's
  zero value `LoadOptions{}` means the default here (a negative limit is the error).
- **H29 — the three checks, measured on v0.2.0 BEFORE the change (scratch copy, local server):**
  (1) S10 `.wasm`: 404 and 500 → an error naming the status and URL, one request ✔ — but **no time
  limit at all** (`http.DefaultClient`) ✘. S10 `.wit`: a 500 → **raw, silently** ✘. **New, the
  C31 defect here too:** `x.wasm?v=1` → the `.wit` URL became `x.wasm?v=1.wit`, so the `.wasm` was
  fetched a second time AS its `.wit` (2 requests) and parsed as an empty interface ✘. (2) The `.wit`
  fallback is now the SPEC 4.0.0 rule. (3) S8: raw `multiply(2.5, 4.0)` (no `.wit`) →
  `4621819117588971520` (uint64), **the f64's bit pattern** — -jvm's defect class ✘; typed
  `add(2.7, 1)` = 3, `add(1, 2^31)` wrapped to −2147483647, `add(true, 1)` = 2, `isEven(4.0)` =
  true — **silent coercion** ✘; no kind-specific accessors exist. (4) S9: `imports_50` with no
  callbacks LOADED; `scale` / `combine` → **0** ✘. Also: a `u32` `.wit` read as `s32`; a malformed
  parameter list loaded; an empty `.wit` read as "no `.wit`"; a path not ending in `.wasm` looked
  for `<path>.wit`; a string argument on a module without `cabi_realloc` would have panicked (nil
  func). **All fixed in `1ee9771`**; each has a test.
- **H6 — gate + ★ block: done.** Gate `928d1df`: `api-surface.txt` produced by the test
  `internal/apisurface` (go/ast); `scripts/compat.ts` (floor, Rule 3 previous-tag tests, Rule 6);
  `scripts/bump.ts` (refuses below the floor; never tags); `release.yml` runs
  `bun scripts/compat.ts --release $TAG` (Bun 1.4.4). Inverted in a scratch clone: patch below a
  major floor BLOCKED; Rule-6 minor without the README row BLOCKED; a rename without re-baseline →
  "stale"; a bool-decode mutant vs a scratch tag → previous-tag tests RED 19/1, patch BLOCKED; an
  addition → floor minor, patch BLOCKED; a removal → floor major. **★ block** (H24 / H27 / C8 met at
  once): `cmem/best-practices.md`, first copy, stamp `Copied from synapticforge1/cmem/best-practices.md
  on 2026-11-08`; text check 28 = 28, 0 differences; inverted (one word of 1.1 → `DIFF 1.1`); 6.1
  carries `8d9ba0cb9`. Memory layout: INDEX + overview + working-rules + best-practices + open-work
  + handoffs.
- **H15 — recorded** (`cmem/working-rules.md` § Tooling): Go → Bun (`go run` builds an
  executable); nothing to port — the first committed scripts (`compat.ts`, `bump.ts`) are Bun.
- **H22 / H25 §3(d) — recorded**: the path test ("machine-specific?") in `working-rules.md`
  § Privacy. Scan of the tree before committing: 0 hits (text and `-a`).
- **H28 — recorded**: the maintainer-address exception in `working-rules.md` § Privacy (no
  manifest field in Go; no contact note committed); this repo never cited wabt-ts / binaryen-ts.
- **C30 — read (record-only, reasoned, not measured):** no `id-token: write`, no `concurrency:`, no
  `bun fmt`, so (1)–(3) do not apply as written; the same hazard in this repo's form — one job with
  a `contents: write` token runs third-party code. **Fixed the same day on the owner's go-ahead**
  ("yes split the release workflow"): `release.yml` is two jobs — `checks` (`contents: read`;
  tokenless clone; build, vet, test, gate) and `release` (`contents: write`; runs only git, awk,
  `gh`; first checks the tag is still the commit `checks` passed). No `uses:` step at all: Go 1.26.4
  and Bun 1.4.4 come from their official downloads, pinned by version and sha256, so no
  third-party action code runs and the Actions policy cannot block a step.
- **RELEASED as v0.3.0, 2026-11-08:** `release: v0.3.0` `faf46bb` = tag `v0.3.0` (annotated) =
  `origin/main` (`ls-remote`). CI run 42508941015 green in both jobs; GitHub Release present with
  its notes; `proxy.golang.org` lists v0.3.0 at `faf46bb`. Also `12e3fb4`: the notes step now
  matches the CHANGELOG heading literally (gawk read the old dynamic regex as a bracket
  expression; Ubuntu's mawk did not, so earlier Releases were fine).
- **Owner rulings, 2026-11-08:** "yes release 0.3.0"; "yes split the release workflow"; on the
  §11.1 zero-limit divergence, *"adjust for go"* — Go's zero value `LoadOptions{}` stays the 30 s
  default here (overview § Canonical ABI / SPEC conformance).

## Answers, 2026-10-26

- **H16 — exFAT `.git` fix: done.** `git stash list` empty, one branch; `gc --prune=now`,
  `fsck --connectivity-only` clean, **`maintenance.strategy gc`**; 1 pack / 35.48 KiB. Per clone, no
  commit; recorded in the private `cmem/local/environment.md`.
**Pushed 2026-10-26 (owner: "commit and push"):** `d8f24d6`, `333a8eb`, `d03da9c` and `524b64f`
are on `origin/main` (read back with `ls-remote`: `524b64f` = local). No tag was pushed and no
release was cut.

- **H7 — `cmem/` un-ignored (L1): done, `d8f24d6`.** Scanned before tracking
  (drive paths, emails, tokens; HEAD re-scanned with `git grep -a`): 0 hits. `cmem/local/` and
  `.claude/settings.local.json` gitignored. The pointer `CLAUDE.md` stays gitignored until it is cut
  to a pointer (its body is stale — drift L2).
- **H7 / C11 — fixtures: re-copied from loader-js `36aa661`** (wasmtk stamp `4a5c3cf668d`;
  `36aa661` is on loader-js `origin/main`, and its `tests/` fixtures are unchanged at `origin/main`
  `bcab4b4`). Exported with `git archive` (committed bytes, no checkout line-ending conversion), the
  13 files copied unmodified: the five `*_50` `.wasm`/`.wit` pairs, `init_check.wat`/`.wasm`,
  `fixtures.json`. Verified: 12/12 `files` sha256 match; `fixtures.json` byte-identical to -js's
  blob (copied, never regenerated — loader-dart's `describe` finding). Before: the four `*_50.wasm`
  differed from the stamped set (`.wit` identical) and `init_check`, `wasi_io_50`, `fixtures.json`
  were missing. `go vet` clean, `go test ./...` 7/7; inverted (`math_50.wasm` truncated → exactly
  TestMath, TestBind, TestSingleton, TestPool red; the other three green), restored and re-verified.
  **`tests/` is TRACKED** (owner, 2026-10-26, reversing the 2026-06-24 "kept local" decision), with
  `.gitattributes` `tests/** -text` so no checkout converts the fixtures' line endings (fresh
  `autocrlf=true` clone: 12/12 sha256, `go test` green).
- **H7 / projects.md "CI builds, never tests" — fixed, `d03da9c`:** `init_check`
  and `wasi_io_50` now tested (`TestInitialize`, `TestWasiIO`; 9/9), each inverted by a loader
  mutation on a scratch copy (only its own test red). `release.yml` gates every tag on `go vet` +
  `go test` (only a manual backfill of a pre-fixture tag may skip, with a warning). Not added: a
  CI run on push / PR (the repo has only the tag-triggered workflow).
