# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-08.

## Owner actions

1. **Merge, push and release SPEC 4.0.0 as v0.3.0.** Branch `spec-4.0.0` (`1ee9771` behaviour,
   `928d1df` gate, then the memory commit) is merged `--no-ff` into local `main` and NOT pushed.
   To release: `bun scripts/bump.ts minor` (Rule 6; stamps CHANGELOG / README) → commit
   `release: v0.3.0` → tag `v0.3.0` → push `main` and the tag → warm the proxy
   ([overview.md](overview.md) § Build / release flow). A pushed tag is immutable in Go's checksum
   database.
2. **C30 (S3D's release-workflow findings), the same hazard in this repo's form — decide:**
   `release.yml` has no `id-token: write` and no `concurrency:`, so (1) and (2) do not apply as
   written, and (3) does not apply (no `bun fmt`). But its ONE job holds a `contents: write`
   `GITHUB_TOKEN` (and `actions/checkout` persists it in `.git/config` by default) while it runs
   third-party code — `go test` executes wazero and `golang.org/x/sys`, and since 2026-11-08
   `bun scripts/compat.ts`. The fix loader-dart took (owner go-ahead, `cb7bc26`): a token-less
   `checks` job for build / vet / test / gate, then a `release` job that only runs `gh`, asserting
   the tag is still at `github.sha`; plus `persist-credentials: false` and actions pinned by
   commit hash. Reasoned, not measured here.
3. **The pull line.** The gitignored local `CLAUDE.md` was cut to a pointer on 2026-11-08 (drift
   L2): it now reads the ledger first. Being gitignored, it is per clone.

## Waiting on others

- The workspace / loader-js verify and close H6, H15, H22, H25, H28, H29 and C29 for this repo
  ([handoffs.md](handoffs.md) § "Answers, 2026-11-08").
- **SPEC §11.1 vs Go's zero value** — `LoadOptions{}` means the 30 s default here, where SPEC says
  a zero limit is an error; raised with -js as a port divergence (handoffs.md, same section).
