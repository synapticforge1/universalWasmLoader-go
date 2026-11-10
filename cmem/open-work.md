# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-10.

## Owner actions

1. **The H33 release order is on the working branch `h33-release-order`, not on `main`** — the
   owner's "push" merges and pushes it. That push is NOT a release (CHANGELOG's top version,
   v0.3.3, is tagged on `805401e`), so it runs only `checks` on GitHub: the first measurement of
   the new workflow's non-release path.
2. **The release path is measured at the next "release"** (`bun scripts/bump.ts <level>`, then
   `bun scripts/release.ts`; CI tags, makes the page, reads the proxy). Read that run's four jobs
   and record them in [release.md](release.md) § Release History.

## Waiting on others

- The workspace re-reads H33 and H34 for this repo (and binaryang closes C44). Each row's creator
  closes it; this repo never flips another's status.
