# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-10.

## Owner actions

1. **The release path of the H33 order is measured at the next "release"** (owner, 2026-11-10:
   "push then release"; the level is the owner's): `bun scripts/bump.ts <level>`, then
   `bun scripts/release.ts`; CI checks, tags, makes the page and reads the proxy. Record the run's
   four jobs in [release.md](release.md) § Release History.

## Waiting on others

- The workspace re-reads H33 and H34 for this repo (and binaryang closes C44). Each row's creator
  closes it; this repo never flips another's status.
