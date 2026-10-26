# Overview — universalWasmLoader-go

## What this is

`universalWasmLoader-go` is the **Go port** of the Universal WASM Loader — the cross-language family
of WIT-aware WebAssembly loaders. It loads a `.wasm` library (the reactor/library shape `wasmtk modc`
produces), reads its WIT-described interface, and exposes each export as an idiomatic Go call with
Canonical-ABI marshalling handled for the caller (numbers direct, strings encoded/decoded through
linear memory, booleans normalized). No `.wit` → raw exports.

- **Language / runtime:** Go, built on **pure-Go [wazero]** (no CGO). **Package:** `wasmloader`,
  module path `github.com/synapticforge1/universalWasmLoader-go` from v0.2.0 (v0.1.0 was
  `github.com/jrmarcum/universalWasmLoader-go` — see "Repository location").
- **Distribution:** **pkg.go.dev** via `go get` + a semver `vX.Y.Z` git tag (no registry upload step).

[wazero]: https://github.com/tetratelabs/wazero

## Repository location — moved to the `synapticforge1` org (recorded 2026-10-20)

- **Canonical home:** `https://github.com/synapticforge1/universalWasmLoader-go` (an organization
  under the owner's control). Formerly `https://github.com/jrmarcum/universalWasmLoader-go`; GitHub
  redirects the old path, but a redirect is not a contract — new references use the org path.
  Verified 2026-10-20: the org repo serves `main` at `8982256` (same as local). Siblings -c, -dart,
  -dotnet and the -js reference moved to the same org; the JSR scope `@jrmarcum/...` is a separate
  namespace and did not move.
- **⚠️ Go-specific: the module path IS the import path.** v0.1.0 was published as
  `github.com/jrmarcum/universalWasmLoader-go` and stays there (proxy-cached; GitHub redirect serves
  new fetches). Fetching the org path at the v0.1.0 tag fails with "module declares its path as …" —
  expected; v0.1.0 is not re-published under the new path.
- **Module path moved to the org — RELEASED as v0.2.0 on 2026-10-20** (commits `f419664` +
  `c1f602b`, annotated tag `v0.2.0` pushed to the org; proxy warmed — `proxy.golang.org` serves
  `github.com/synapticforge1/universalWasmLoader-go v0.2.0`; the release workflow ran under the org,
  so its Actions policy permits it). What it changed:
  `go.mod` → `github.com/synapticforge1/universalWasmLoader-go`; `README.md` install line, import
  example, -js reference link, and a moved-repo upgrade note; `CHANGELOG.md` `[Unreleased]` section
  marking the path change **Breaking** + link refs to the org. Local `origin` remote set to the org
  URL. `go build` / `go vet` / `go test ./...` green after the change. **Ships as v0.2.0** (breaking for
  importers, no API change). **Release steps:** rename `## [Unreleased]` → `## [v0.2.0] - <date>`
  (the release workflow extracts notes by `## [vX.Y.Z]` heading, so `[Unreleased]` would yield the
  default note) and add the `[v0.2.0]` link ref → commit → tag `v0.2.0` → push → warm the proxy at
  the new path. Optionally a final old-path tag with `// Deprecated:` in `go.mod` to point
  importers at the new path.
- **Post-transfer check:** the release workflow uses `GITHUB_TOKEN` + standard actions; confirm the
  `synapticforge1` org's Actions policy allows them before the next tag (the -dart port hit an
  owner-only-actions policy after its transfer).

## Runtime decision — wazero (REVERSED from wasmtime-go, 2026-06-17)

**Decided: wazero.** This **reverses** the 2026-06-15 "wasmtime-go (Cranelift + ecosystem
consistency)" note after a head-to-head benchmark on this machine (Go 1.26, Windows/amd64; same
`bench.wasm` with a trivial `add` for call overhead and a `sumto(100000)` compute loop):

| Metric | **wazero** (pure-Go) | **wasmtime-go** (CGO + Cranelift) |
| --- | --- | --- |
| Instantiate | ~0.5 ms | ~1–2.6 ms |
| `add()` per-call overhead | **~36 ns/call** | **~1370 ns/call** |
| `sumto(100k)` compute | ~28 µs/call | ~38 µs/call |

- **Call overhead: wazero ~38× faster.** The ~1.3 µs gap is the **CGO boundary** (every wasmtime-go
  call crosses Go→C→wasm). A loader's whole job is calling exports, so this dominates.
- **Compute: wazero also faster here** — its optimizing compiler is excellent on this loop and carries
  no per-call tax. (Cranelift may edge ahead on some long-running single-call workloads; not the
  loader's profile.)
- **Instantiate: wazero faster.**
- **Plus pure-Go**: no CGO, no per-platform `libwasmtime` to ship, trivial cross-compilation — a real
  `go get`-ergonomics win the earlier decision undervalued. (Owner confirmed the switch 2026-06-17:
  "purely positive.")
- **WASI:** wazero's built-in `imports/wasi_snapshot_preview1` satisfies SPEC §10 with no hand-rolled
  shim — the loader always instantiates it (unused namespaces are ignored, so pure-compute modules are
  unaffected). This was the one thing wasmtime-go offered "for free"; wazero matches it.

The `wasmtime-go` import path was also spiked and **does** build here (CGO + mingw gcc, `add(3,4)=7`),
so the reversal is on merits, not feasibility.

## Current state — IMPLEMENTED + SPEC-3.0.0 conformant (2026-06-17)

The loader is **fully implemented and passing the reference suite** (was a pre-implementation stub).
Source files (package `wasmloader`):

- `wit.go` — WIT parser (mirrors the JS `wit-parser.js`: kebab→camel, `s32` fallback, import/export
  regex).
- `abi.go` — Canonical-ABI marshalling: export param encode / result decode (incl. string params via
  `cabi_realloc`, and the **callee-allocated string-return** convention — read the `[ptr,len]` pair,
  decode, then call `cabi_post_<camel>`), plus the `env` host-import module (reflection-dispatched
  user callbacks). Mirrors `abi.js` exactly.
- `loader.go` — `Module` handle; `Load` (sync, file) / `Import` (file or `http(s)` URL); `Call` /
  `Bind`; `@N` version pinning; WASI-P1 shim + `_initialize` (SPEC §10); raw fallback when no `.wit`.
- `callbacks.go` — `Callbacks` builder (`NewCallbacks().On(camelName, fn)`).
- `singleton.go` — `CreateSingleton` (load-once via `sync.Once`; identity-stable `*Module`).
- `pool.go` — `InstancePool` (buffered-channel semaphore over N independent runtimes; `Acquire` /
  `Release` / `Run` / `Close`).

### Public API

`Load(path, cbs...) (*Module, error)` · `Import(ctx, src, cbs...) (*Module, error)` ·
`(*Module).Call(name, args...) (any, error)` · `(*Module).Bind(name) func(...any)(any,error)` ·
`(*Module).Exports()` · `(*Module).Close()` · `CreateSingleton(path, cbs...) func()(*Module,error)` ·
`NewInstancePool(path, size, cbs...) *InstancePool` (+`Acquire`/`AcquireContext`/`Release`/`Run`/`Close`)
· `NewCallbacks().On(name, fn)`.

Exports are looked up by **camelCase** name (the WASM binary symbol; SPEC name-form rule). The typed
codegen interface (PORT_PROMPT item 4) is NOT implemented — `Bind` covers the destructure pattern;
codegen is a future add (not required for SPEC §7 conformance).

## Canonical ABI / SPEC conformance

- Built **directly against SPEC v3.0.0** (callee-allocated string returns + `cabi_post_<name>`); the
  deprecated 2.x caller-allocated out-param convention was skipped entirely.
- Component ABI only (matches the JS reference `abi.js`, which has no separate "wasic ABI" branch —
  numeric/bool handling is profile-independent; strings use `cabi_realloc`/`cabi_post`).
- **One bug found + fixed during bring-up:** bool results were decoded as `raw64 != 0`; an f64-arg
  body can leave high-bit garbage in the i32 result register, so the **false** cases of `isPositive`/
  `inRange` read as true. Fixed by masking to the low 32 bits (`uint32(raw[0]) != 0`) — a bool is an
  i32 0/1.

## Tests

- **Command:** `go test ./...` — **7/7 pass** (`go vet` + `gofmt` clean). `loader_test.go` covers the
  SPEC §8 fixtures (`math_50`, `booleans_50`, `strings_50`, `imports_50` — copied into `tests/`) plus
  `Bind`, the singleton identity, and a concurrent `InstancePool` (size 2, 8 concurrent `Run`s).

## Build / release flow

- **Build:** `go build ./...`. **Test:** `go test ./...`.
- **Release:** tag a semver `git tag vX.Y.Z` + push; installable via `go get`, indexed on pkg.go.dev.
  No registry upload / secrets needed (unlike the JSR/PyPI/Maven ports).
- **Proxy warm step:** after pushing the tag, run `GOPROXY=https://proxy.golang.org go list -m
  github.com/synapticforge1/universalWasmLoader-go@vX.Y.Z` (from a scratch dir) to make `go get`
  resolve immediately and queue pkg.go.dev indexing. (v0.1.0 was warmed at the old `jrmarcum` path.)

## Release history

- **v0.2.0 — published 2026-10-20.** Module path moved to `github.com/synapticforge1/...` after the
  repo transfer (breaking for importers, no API change). See "Repository location".
- **v0.1.0 — published 2026-06-24** (under the old `github.com/jrmarcum/...` module path) (first public release; annotated tag pushed to `origin`). Proxy
  warmed (`proxy.golang.org` serves it); pkg.go.dev indexes within minutes. `CHANGELOG.md` (Keep a
  Changelog format) added at repo root.
- **GitHub Releases are automated via `.github/workflows/release.yml`** (added 2026-06-24). It fires
  on any `v*` tag push, builds the library as a sanity gate (NOT `go test` — fixtures are unpublished),
  extracts that version's notes from `CHANGELOG.md`, and creates/updates the Release using the
  built-in `GITHUB_TOKEN` (no PAT / no local `gh auth`). The local machine has no `gh` auth, which is
  why CI does this. The v0.1.0 tag predates the workflow, so its Release must be backfilled once via
  **workflow_dispatch** (Actions tab → release → Run workflow → tag `v0.1.0`); the job is idempotent.
  **Release-cutting flow going forward:** update `CHANGELOG.md` → `git tag vX.Y.Z` → push tag → CI
  publishes the Release.

## Repo publishing decisions (2026-06-24)

- **`tests/` and `CLAUDE.md` are gitignored and untracked** (owner request, 2026-06-24); they remain
  on disk locally but are NOT published with the module.
- **`cmem/` is TRACKED again since 2026-10-26** (workspace letter H7 / drift L1; owner, 2026-10-22:
  fine as long as it displays no secrets or personal information). It was gitignored 2026-06-24 →
  2026-10-26. Scanned before tracking (drive paths, emails, tokens): 0 hits. Private, per-machine
  facts go in the gitignored `cmem/local/`. `.claude/settings.local.json` is gitignored (tool
  settings are never tracked).
- **Consequence — tests don't run on a fresh clone.** `loader_test.go` loads fixtures from `tests/`
  at runtime; with `tests/` untracked, `go test ./...` fails (file-not-found) for anyone cloning,
  including CI. The library still builds and `go get` works fine (consumers don't need fixtures). Re-
  include fixtures or generate them in a test step if CI/contributor testing is wanted later.
- **README license note corrected** to `MIT` (was `MIT OR Apache-2.0`) to match the single MIT
  `LICENSE` file — there is no Apache-2.0 text. Switch to true dual-licensing only by adding a
  `LICENSE-APACHE` file.
