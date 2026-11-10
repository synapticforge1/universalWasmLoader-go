# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-10.

## Owner actions

1. **The fix `3045f67` and its records are on the branch `fix-proxy-guard`, not on `main`** (the
   release guard reads the proxy's `@v/list`, never `.info` — [release.md](release.md) § v0.3.4,
   best-practices L3). It must land (the owner's "push") before the NEXT release.

## Waiting on others

- The workspace re-reads H33 and H34 for this repo (and binaryang closes C44). Each row's creator
  closes it; this repo never flips another's status.
