# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-10.

## Owner actions

1. **"Re-run failed jobs" on run 42892298910** (GitHub web UI: Actions → that run) once
   proxy.golang.org serves `@v/v0.3.4.info` (it answered a cached "unknown revision" 404 —
   [release.md](release.md) § v0.3.4). Only `publish` re-runs; the tag and the page are done.
   Record its result in release.md.
2. **The fix `3045f67` is on the branch `fix-proxy-guard`, not on `main`** (the guard reads the
   proxy's `@v/list`, never `.info`). It must land ("push") before the NEXT release, so no guard
   poisons the proxy again; not during this one.

## Waiting on others

- The workspace re-reads H33 and H34 for this repo (and binaryang closes C44). Each row's creator
  closes it; this repo never flips another's status.
