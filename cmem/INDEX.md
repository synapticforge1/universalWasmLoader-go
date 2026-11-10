# cmem — Portable Project Memory for universalWasmLoader-go

This folder is the **authoritative project memory** for `universalWasmLoader-go`. It lives inside the
project tree and is **committed to git** (tracked again since 2026-10-26, workspace letter H7; it was
gitignored 2026-06-24 → 2026-10-26). **No secrets or personal information** in any committed file —
private, per-machine facts go in the gitignored `cmem/local/`. Keep files small and single-topic.

## Policy

- **`cmem/` is the single home for ALL project memory.** When the owner says "**update the project
  memory**," update the matching `cmem/` topic file with the latest decisions, found bugs, design
  changes, and current state — then add/refresh its one-line pointer in the table below. Convert
  relative dates to absolute; update existing entries rather than duplicating.
- **`README` and `SPEC.md` are NOT project memory.** They are the public, user-facing docs. Keep
  internal decision logs / bug post-mortems out of them — those live here in `cmem/`.

### The "update the project memory" trigger (binding on every agent)
When the owner says **"update the project memory"** (or a synonym — "update memory", "record this"),
do BOTH: (1) revise all relevant `cmem/` files and refresh the Files-table pointers (absolute dates;
update, don't duplicate); and (2) sync the user-facing README / SPEC.md only where the change is
user-relevant — never copy internal decision logs into them.

### The "look for code issues" trigger (binding on every agent)
When the owner says **"look for code issues"** (or "code audit" / "audit the code"), perform a
comprehensive audit across tested AND untested paths for: (1) workarounds / temporary hacks;
(2) dead code; (3) bugs (wrong ABI marshalling, off-by-one pointer/length math, endianness, missing
`cabi_post` calls); and (4) silent fall-throughs (returning a default instead of erroring). Report
`file:line` + severity, fix the safe ones, and keep the test suite green (`go test ./...`).

**Session start:** read `../../cmem/workspace-correspondence.md` (rows naming this repo), then the
letters it points to. Rules: [working-rules.md](working-rules.md).

## Files

| File | What it holds |
| --- | --- |
| [handoffs.md](handoffs.md) | This repo's answers to workspace letters and ledger rows (H6–H29, C29, C30 on 2026-11-08; H7, H16 on 2026-10-26) |
| [open-work.md](open-work.md) | The one list of what is outstanding: items waiting on the workspace / loader-js to verify and close (v0.3.0 and the C30 split are done) |
| [working-rules.md](working-rules.md) | The checklist: git, the compatibility gate, tooling (Bun scripts), privacy (path test, maintainer address), boundaries, session start |
| [best-practices.md](best-practices.md) | METHOD rules: this repo's own (§ L) + the workspace's 28 ★ rules, copied verbatim and stamped 2026-11-08 |
| `local/` (gitignored) | Private per-clone machine facts — `environment.md` (the H16 exFAT `.git` setting) |
| [release.md](release.md) | 🔒 The ONE release record (owner, 2026-11-10): how a release runs in the owner's order (U1–U12: bump → release.ts pushes `main` → CI checks → CI tags → page → Go proxy read-back) and "Release History", newest first, a summary each |
| [overview.md](overview.md) | What this loader port is, where it lives (`synapticforge1` org), runtime (wazero), API, SPEC 4.0.0 conformance and the port's choices, tests, the release flow and the two-job CI, release history (v0.1.0, v0.2.0, v0.3.0) |
