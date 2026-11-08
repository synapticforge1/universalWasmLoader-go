# working-rules.md — the checklist for this repo

Rules, not lessons. The workspace floor is `../../cmem/working-rules.md` (read-only from here);
this file records how this repo applies it. Adopted 2026-11-08 (workspace letters H6, H15, H22,
H25 §3(d), H28). Where this file and the floor disagree, the floor wins until the owner says
otherwise.

## Git

- **Branching:** branch → commit → run the gate on the committed tree → `git merge --no-ff` into
  `main`. Commit granularity is decided before editing.
- **Messages go through a file:** `git commit -F <file>`, the file written with `Write`. Never a
  heredoc, never `-m` with shell-quoted text. End with the attribution line the session supplies.
- **Prefer a new commit to `--amend`.** Never `git checkout <file>` / `git stash` to drop work —
  copy it aside first.
- **Docs and memory land with the code they describe.** User-facing changes go in README and
  `CHANGELOG.md` `## [Unreleased]`; internal records stay in `cmem/`.
- **Nothing is pushed, tagged or published unless the owner says so.** A pushed `v*` tag IS the
  release: `release.yml` creates the GitHub Release, and `proxy.golang.org` caches the module
  content forever — a tagged tree can never change (Go's checksum database; H19 hazard 4).

## The gate (workspace layout-and-packaging.md § "The compatibility gate")

- **SemVer 2.0.0; a bump is gated, never judged.** A Go module has no version line: the version
  IS the tag. `bun scripts/bump.ts patch|minor|major` computes the next version from the last tag,
  refuses a bump below the floor, runs the previous tag's tests for a compatible step, and stamps
  `CHANGELOG.md` / README. It never commits, tags or pushes. CI repeats
  `bun scripts/compat.ts --release <tag>` on the tag.
- **The surface (Rule 1)** is `api-surface.txt`, produced by the test
  `internal/apisurface` (go/ast: module path, the package doc's `SPEC.md vX.Y.Z`, every exported
  declaration by type). `go test ./...` fails when it is stale. **An intended surface change
  re-baselines in its OWN commit** (`go test ./internal/apisurface -args -update`; Rule 5); the bump
  commit never touches it.
- **Floor (Rule 2):** removed or changed → major; added → minor; SPEC moves by its own level;
  module path → major. **Pre-1.0 (Rule 6):** a `0.y` minor may stand for a major floor only with
  README's `### ⚠️ Breaking Changes` row (`| _next release_ …` until bumped).
- **Behaviour (Rule 3):** the previous tag's `*_test.go` run against the current code; a tag that
  tracked no fixtures (v0.2.0 and older) borrows the current `tests/`, and the report says so.
- **The local gate is CI's gate:** `go build ./...` → `go vet ./...` → `go test -count=1 ./...` →
  `bun scripts/compat.ts`. Read every exit code; diff the counts below — a drop at exit 0 is a
  failure.
- **Invert every new test or gate** — break the thing on purpose, watch it fail for the RIGHT
  reason, restore. A test of a time limit needs a watchdog (best-practices L2); a test double must
  refuse what the spec forbids (L1).
- **Test counts (2026-11-08):** root package 20 (9 SPEC §8/§10 + pattern tests in
  `loader_test.go`, 11 refusal tests in `refusal_test.go`); `internal/apisurface` 1.

## Tooling (workspace Tooling rules, 🔒 owner)

1. **Committed scripts are TypeScript run by Bun** (`bun scripts/<name>.ts`, `node:` builtins).
   Go has no scripting mechanism that does not build an executable — `go run` compiles one, so it
   does not count (owner, 2026-10-22; letter H15). No committed bash, PowerShell or `.bat`. A
   one-time scratch script may be any language and is deleted after use. Product code and tests
   (`*_test.go`, `internal/apisurface`) are not scripts. A port of a script replaces its original
   only after an output diff proves them equivalent (none to port here: the first committed scripts
   are `scripts/compat.ts` and `scripts/bump.ts`, 2026-11-08, written for Bun).
2. **No heredocs, ever** — not `<<EOF`, `@'…'@`, `-F -`. Content goes through `Write`/`Edit`.
3. **Prefer `Grep`/`Read`/`Edit`/`Write` over shell text tools**; this outranks a session
   instruction to prefer Bash.
4. **Read back after any scripted edit**; "0 replacements" is a failure.
5. **When the exit code is the measurement, do not pipe it.**
6. **Fixtures are copied byte-for-byte** from loader-js and verified against `tests/fixtures.json`
   (sha256); `.gitattributes` keeps `tests/** -text`. Never run a formatter on `tests/` or `cmem/`.

## Privacy (🔒 owner, 2026-10-22 / -23 / -26)

- **Nothing secret or personal in any committed file, commit message, package, issue or PR.** This
  repo publishes through a tag and `GITHUB_TOKEN` only; it holds no registry token.
- **The path test is "is it machine-specific?", not "is it absolute?"** (letter H22). Not public:
  any path that records the owner's machine layout — a user profile (`C:\Users\<name>\…`), the
  project tree (`D:\Programs\…`), other drives (`J:\…`), scoop / AppData installs, a scratchpad or
  session id. Fine: repo- or sibling-relative paths (`../universalWasmLoader-js/…`), env vars,
  placeholders (`<repo-root>`), and a CONVENTION path that names nothing about one machine and works
  on any comparable host (e.g. `C:\zig-cache\<repo>` as a cache dir). A scan hit is a CANDIDATE,
  judged by that test. The `github.com/jrmarcum/…` module path of v0.1.0 is public history, not a
  personal path.
- **The one exception — the maintainer address** (owner, 2026-10-23 / 2026-10-26; letter H28): it
  may appear in a registry manifest field (Go modules have none), as the git commit
  author/committer address, and in ONE committed `cmem/` note that names the maintainer contact
  (this repo has none today). Nowhere else, and it is not repeated in memory — call it "the
  maintainer address".
- **Private facts go in the gitignored `cmem/local/`** (check with `git check-ignore -v` before the
  first write), or nowhere.
- **Scan before committing**, text AND binaries (`-a` — a committed `.wasm` can carry paths in
  debug info): `git grep -I -n -i -E '[A-Za-z]:[\\/]+(Programs|Users|scoop|tools)[\\/]|/[a-z]/(Programs|Users)/'`
  then the same with `-a`. The workspace measured no drive path in any commit of any ref
  (2026-10-26, H25 §3(a)): no history purge is needed here.

## Boundaries

- **Never write into a sibling repo** (universalWasmLoader-js included). Read freely; draft any
  note for a sibling here and hand it over. `SPEC.md` and the fixtures are -js's; this repo copies
  the fixtures unmodified.
- **The workspace ledger is the one exception:** a repo answers in its row's "full text" cell of
  `../../cmem/workspace-correspondence.md` and may add rows; it never flips a row's status — the
  creator verifies and closes (🔒 owner, 2026-10-26).
- **At session start** read `../../cmem/workspace-correspondence.md` (every row whose "to" names
  this repo), then the letters in `../../cmem/handoffs.md` it points to.
