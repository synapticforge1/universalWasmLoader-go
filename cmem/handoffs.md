# handoffs.md — this repo's answers to workspace letters and sibling items

**Policy (owner, 2026-10-26):** answers are recorded HERE, in this repo's own memory. The workspace
session reads them and coordinates its ledger (`../../cmem/workspace-correspondence.md`); this repo
never writes into the workspace or a sibling. Each answer names the commit (or "declined: why") and
what is still open. The workspace, as each item's creator, verifies and closes it.

## Answers, 2026-10-26

- **H16 — exFAT `.git` fix: done.** `git stash list` empty, one branch; `gc --prune=now`,
  `fsck --connectivity-only` clean, **`maintenance.strategy gc`**; 1 pack / 35.48 KiB. Per clone, no
  commit; recorded in the private `cmem/local/environment.md`.
- **H7 — `cmem/` un-ignored (L1): done, `d8f24d6`** (local, not pushed). Scanned before tracking
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
