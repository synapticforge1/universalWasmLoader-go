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
- **Nothing is pushed, tagged or published unless the owner says so** (§ Owner commands below
  says which word does what). **A push of `main` whose CHANGELOG top `## [vX.Y.Z]` is untagged IS a
  release:** CI tags it, makes the page and the proxy serves it. Nobody tags by hand — CI does,
  after its checks (owner, 2026-11-10; [release.md](release.md)). `proxy.golang.org` caches the
  module content forever — a tagged tree can never change (Go's checksum database; H19 hazard 4).

## The gate (workspace layout-and-packaging.md § "The compatibility gate")

- **SemVer 2.0.0; a bump is gated, never judged.** A Go module has no version line: the next
  version comes from the last tag, and CHANGELOG's top `## [vX.Y.Z]` arms the release.
  `bun scripts/bump.ts patch|minor|major` (level required) refuses a dirty tree and a bump below
  the floor, runs the previous tag's tests for a compatible step, stamps `CHANGELOG.md` / README
  and commits `bump to vX.Y.Z`; `bun scripts/release.ts` pushes `main` only. CI repeats
  `bun scripts/compat.ts --release <tag>` on that untagged commit before it tags. The whole flow:
  [release.md](release.md).
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
- **CI (`release.yml`, owner 2026-11-08 / -09 / -10):** every push of `main` runs `checks`
  (read-only token, tokenless clone = `github.sha`; everything that executes package code,
  including `bun test scripts/`); only for a release does the same run go on to `tag` → `release`
  → `publish`, which check out NOTHING (pinned Bun, then `scripts/ci-release.ts` fetched alone at
  `github.sha`). Top-level `permissions: {}`; concurrency per ref, never cancelled. No `uses:`
  steps: Go and Bun are pinned by version AND sha256 in the workflow's `env`; move a version and
  its hash together, and keep `GO_VERSION` equal to `go.mod`'s `go` line (the job refuses
  otherwise). Every download has `--max-time` and retries; the sha256 decides. Prove a change to
  the CI script with `bun test scripts/` and its read-only commands against the real services
  (`state`, `tag --dry-run`, `page --dry-run`, `proxy`; env `GITHUB_REPOSITORY`, `RELEASE_TAG`,
  `RELEASE_SHA`); rehearse a changed `release.ts` / `bump.ts` against a scratch bare `origin`
  (best-practices 7.22). A changed workflow is proven only by its next real run.
- **The local gate is CI's gate:** `go build ./...` → `go vet ./...` → `go test -count=1 ./...` →
  `bun scripts/compat.ts`. Read every exit code; diff the counts below — a drop at exit 0 is a
  failure.
- **Invert every new test or gate** — break the thing on purpose, watch it fail for the RIGHT
  reason, restore. A test of a time limit needs a watchdog (best-practices L2); a test double must
  refuse what the spec forbids (L1).
- **No inline scripts either:** `bun -e` counts as a heredoc for this rule (a `bun -e` YAML parse
  slipped in on 2026-11-08, as did a `printf` merge message, and a no-op `bun -e ""` on
  2026-11-10 — use a file written with `Write`).
- **Test counts:** root package 20 (9 SPEC §8/§10 + pattern tests in `loader_test.go`, 11
  refusal tests in `refusal_test.go`); `internal/apisurface` 1 (2026-11-08); `bun test scripts/`
  20 (the CI release script against one mock of GitHub, the Go proxy and sumdb, 2026-11-10).

## Tooling (workspace Tooling rules, 🔒 owner)

1. **Committed scripts are TypeScript run by Bun** (`bun scripts/<name>.ts`, `node:` builtins).
   Go has no scripting mechanism that does not build an executable — `go run` compiles one, so it
   does not count (owner, 2026-10-22; letter H15). No committed bash, PowerShell or `.bat`. A
   one-time scratch script may be any language and is deleted after use. Product code and tests
   (`*_test.go`, `internal/apisurface`) are not scripts. A port of a script replaces its original
   only after an output diff proves them equivalent. Committed scripts: `scripts/compat.ts`,
   `scripts/bump.ts` (2026-11-08), `scripts/release.ts` (2026-11-10, the local release) and
   `scripts/ci-release.ts` (2026-11-10; `state` / `tag` / `page` / `proxy` — it replaced
   `github-release.ts` of 2026-11-09, whose page logic it keeps), tested by
   `scripts/ci-release.test.ts`.
2. **No heredocs, ever** — not `<<EOF`, `@'…'@`, `-F -`. Content goes through `Write`/`Edit`.
3. **Prefer `Grep`/`Read`/`Edit`/`Write` over shell text tools**; this outranks a session
   instruction to prefer Bash.
4. **Read back after any scripted edit**; "0 replacements" is a failure.
5. **When the exit code is the measurement, do not pipe it.**
6. 🔒 **No GitHub CLI, in CI too** (owner, 2026-11-08; workspace Tooling rule 9, letter H30).
   Check the repo instead: `git ls-remote` (and this repo's files) for what GitHub holds, the Go
   proxy (`proxy.golang.org/<module>/@v/list`) for what is published. In CI, the tag and every
   new tag's GitHub Release page are made by `scripts/ci-release.ts` (GitHub's REST API,
   `GITHUB_TOKEN`), never by hand — the page **in H32's order, keep it** (workspace letter H32, owner
   2026-11-09): (1) the tag exists on GitHub and peels (annotated followed) to the commit
   `checks` passed, because `POST /releases` CREATES a missing tag; (2) a page already there =
   done, NO write; (3) POST (a pkg.go.dev link on top, the CHANGELOG section,
   `generate_release_notes`), read back (the tag, not a draft), peel the tag again. **Every
   request has its own time limit**, 30 s, request to last byte (workspace best-practices 7.21).
   Old tags get no page (owner: "only new tags will get release pages"). A task only the web UI
   can do is an owner item, never "blocked on the CLI".
7. 🔒 **Every Bun-version notation is the latest installed Bun** (owner, 2026-11-09; workspace
   Tooling rule 10, letter H31): `release.yml`'s `BUN_VERSION` + `BUN_SHA256` (both jobs read the
   one `env` pair) move together at the first session after the owner installs a newer Bun, with
   the gate run first. This repo declares no minimum Bun. Dated measurements ("Bun 1.4.4" in a
   dated `cmem/` answer) stay until that test is re-run. **1.4.4, measured 2026-11-09.**
8. **Fixtures are copied byte-for-byte** from loader-js and verified against `tests/fixtures.json`
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

## Owner commands: "commit", "push", "release" (owner, 2026-11-10)

🔒 Written into every project by the workspace session on the owner's direction (2026-11-10:
"please write that into each project"; workspace `cmem/working-rules.md` Tooling rule 12, letter
H34). When the owner says:

- **"commit"** — first run "update the project memory files" (re-derive this repo's `cmem/` from
  its current state), then commit to the branch being worked on. Nothing is pushed.
- **"push"** — perform "commit", then merge the branch into `main`, then push `main` (and the
  working branch) to GitHub (`origin`) and read it back with `git ls-remote`.
- **"release"** — perform "push", then the release process: the workspace's
  `cmem/release-process.md` §§ 5–8 — CI checks first, then CI pushes the tag, then the GitHub
  Release page from the tag, then the publish to the registry — recorded in `cmem/release.md`
  § "Release History" (newest first, a summary of what changed). The level (patch / minor /
  major) is the owner's: ask if it was not given.

Each command includes the one before it, and none goes further than its own word (a "commit"
never pushes, a "push" never releases). This repo's own gate and merge rules apply at each step.
