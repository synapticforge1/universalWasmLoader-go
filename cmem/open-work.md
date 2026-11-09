# open-work.md — the one list of what is outstanding

Only open items; each points at its record. Status as of 2026-11-09.

## Owner actions

1. **Push the H30 change** (`release.yml` + `scripts/github-release.ts`, no GitHub CLI) — on local
   `main` only; the push is the owner's. Then the workspace re-greps `origin/main`.
2. **Its first real measurement is the next tag run** (no release is planned for it alone). The
   read-only dry-run and the mock prove the script; only a tag run proves the job on GitHub.
   Recorded here so the next release reads its `release` job's log first.

## Waiting on others

- The workspace / loader-js verify and close H6, H15, H22, H25, H28, H29, C29, C35, and now H30 and
  H31, for this repo; S3D closes C30 ([handoffs.md](handoffs.md)). Each row's creator closes it;
  this repo never flips a status.
- loader-js: the owner's ruling on SPEC §11.1 for Go (zero = the default) is reported in C35;
  whether the SPEC text records a port allowance is -js's to write.
