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

## Current state — SPEC 4.0.0, RELEASED as v0.3.0 (2026-11-08); v0.3.1 (2026-11-09) changes only the release workflow

Re-aligned from SPEC 3.0.0 to **4.0.0** (loader-js's C29 letter; owner decision 2026-11-07) in
`1ee9771`; the gate (H6) in `928d1df`. **Version decision: v0.3.0** — the gate's floor vs v0.2.0 is
major (SPEC 3.0.0 → 4.0.0), and Rule 6 lets a pre-1.0 minor stand with README's Breaking Changes row
(present). Released 2026-11-08 (§ Release history). Detail of the
behaviour before and after: [handoffs.md](handoffs.md) § "Answers, 2026-11-08".

Source files (package `wasmloader`):

- `wit.go` — strict WIT parser, a port of loader-js `wit-parser.js` 2.0.0 (SPEC §2 grammar, the
  reference's messages; an unsupported type is an error — the 3.0.0-era `s32` fallback is gone).
- `abi.go` — Canonical-ABI marshalling: argument domains (checked, never coerced), export param
  encode / result decode (string params via `cabi_realloc`; the **callee-allocated string-return**
  convention — read the `[ptr,len]` pair, decode, then call `cabi_post_<camel>`), the callback
  checks at load (`checkCallbacks`), the `env` host-import module (callback results checked by
  value; a bad one panics with an error, which wazero returns from the export call), and raw-mode
  encode/decode by the WASM value type.
- `loader.go` — `Module` handle; `Load` (sync, file) / `Import` / `ImportWithOptions` (file or
  `http(s)` URL; `LoadOptions{Timeout}`, ctx = cancellation); the `.wit` read and callbacks checked
  BEFORE the `.wasm`; absent-vs-failed `.wit`; one fetch per file under one time limit; `Call` /
  `Bind`; `@N` version pinning; WASI-P1 shim + `_initialize` (SPEC §10); missing WIT exports refused.
- `callbacks.go` — `Callbacks` builder (`NewCallbacks().On(camelName, fn)`).
- `singleton.go` — `CreateSingleton` (load-once via `sync.Once`; identity-stable `*Module`).
- `pool.go` — `InstancePool` (buffered-channel semaphore over N independent runtimes; `Acquire` /
  `Release` / `Run` / `Close`).

### Public API

The committed, generated list is `api-surface.txt` (25 lines incl. `module:` and `spec:`, re-counted
2026-11-08 — an earlier note said 26). In short:
`Load(path, cbs...) (*Module, error)` · `Import(ctx, src, cbs...) (*Module, error)` ·
`ImportWithOptions(ctx, src, cbs, LoadOptions) (*Module, error)` · `LoadOptions{Timeout}` ·
`DefaultTimeout` (30 s) · `NoTimeout` ·
`(*Module).Call(name, args...) (any, error)` · `(*Module).Bind(name) func(...any)(any,error)` ·
`(*Module).Exports()` · `(*Module).Close()` · `CreateSingleton(path, cbs...) func()(*Module,error)` ·
`NewInstancePool(path, size, cbs...) *InstancePool` (+`Acquire`/`AcquireContext`/`Release`/`Run`/`Close`)
· `NewCallbacks().On(name, fn)`.

Exports are looked up by **camelCase** name (the WASM binary symbol; SPEC name-form rule). The typed
codegen interface (PORT_PROMPT item 4) is NOT implemented — `Bind` covers the destructure pattern;
codegen is a future add (not required for SPEC §7 conformance).

## Canonical ABI / SPEC conformance

- **SPEC 4.0.0 (2026-11-08), the port's choices where Go differs from JS:**
  - Typed-call domains: `s32` / `s64` take ANY Go integer kind, range-checked (an untyped constant
    is an `int`, so `Call("add", 3, 4)` stays natural); `f32` / `f64` take `float32` / `float64`
    only (an integer is refused, as -dotnet refuses `3` for `f64`); `bool` and `string` only their
    own kind. Named types with those kinds are accepted. No kind-specific result accessors exist,
    so S8's accessor half is n/a.
  - Callbacks: Go's static types stand in for JS's `undefined` / `"17"` / `17n` rows — a
    callback's signature is checked AT LOAD (param types = the decoded Go types or an interface;
    one result of the WIT kind, or an interface). A callback returning `any` is checked BY VALUE
    when WASM calls it. Go has no Promise; a CHANNEL result is the analogue and is refused.
  - Cancellation is the `ctx` (§11.2). 🔒 **`LoadOptions.Timeout` zero = the 30 s default** —
    owner, 2026-11-08, on the divergence from SPEC §11.1 ("zero … is an error"): *"adjust for
    go"*. Go's zero-value convention wins in this port: `LoadOptions{}` is the default,
    `NoTimeout` = no limit, a negative value is the error. Do not "fix" it to match the JS letter.
  - `CreateSingleton` / `NewInstancePool` load files only, so they take no options (§11.4 n/a — as
    -c and -dotnet).
  - Raw mode encodes / decodes by the export's WASM signature (`int32`/`int64`/`float32`/
    `float64`; several results as `[]any`) — outside §4's rule, but H29 (3) asks for `10.0`.
- Built **directly against SPEC v3.0.0** in 2026-06 (callee-allocated string returns + `cabi_post_<name>`); the
  deprecated 2.x caller-allocated out-param convention was skipped entirely.
- Component ABI only (matches the JS reference `abi.js`, which has no separate "wasic ABI" branch —
  numeric/bool handling is profile-independent; strings use `cabi_realloc`/`cabi_post`).
- **One bug found + fixed during bring-up:** bool results were decoded as `raw64 != 0`; an f64-arg
  body can leave high-bit garbage in the i32 result register, so the **false** cases of `isPositive`/
  `inRange` read as true. Fixed by masking to the low 32 bits (`uint32(raw[0]) != 0`) — a bool is an
  i32 0/1.

## Tests

- **2026-11-08 (re-derived after the v0.3.0 release, at `09e227f`):** `go test ./...` — **root
  20/20 + `internal/apisurface` 1/1**, 0 failed; `go vet`, `gofmt` clean; CI run 42508941015 ran
  the same suite green on the tag. `refusal_test.go` (11) is SPEC 4.0.0 §8 "Refusals", row by row; the http rows run on an
  `httptest` server that counts requests per path and refuses a query on the `.wit`. Inverted: on
  v0.2.0's code all 10 compilable new tests are red; 8 single mutants on the new code each turn
  exactly their own test red (the query mutant first survived — best-practices L1). The gate:
  `bun scripts/compat.ts` (working-rules § The gate); inverted in a scratch clone, six cases.
- **2026-10-26 (before SPEC 4.0.0):** `go test ./...` — **9/9 pass** (`go vet` + `gofmt` clean). `loader_test.go`
  covers the SPEC §8 fixtures (`math_50`, `booleans_50`, `strings_50`, `imports_50`), SPEC §10
  (`init_check`: raw `getValue()` = `uint64(99)` — `int32(99)` since SPEC 4.0.0's raw decode — proves `_initialize` ran; `wasi_io_50`:
  `logAndDouble(21)` = 42 through wazero's WASI `fd_write`), plus `Bind`, the singleton identity, and
  a concurrent `InstancePool` (size 2, 8 concurrent `Run`s). The two §10 tests were inverted on a
  scratch copy (skip `_initialize` → only TestInitialize red; skip the WASI shim → only TestWasiIO red).
- **Fixtures (2026-10-26):** `tests/` = loader-js `36aa661`'s stamped set, copied unmodified (wasmtk
  `4a5c3cf668d`; 12/12 sha256 verified against `tests/fixtures.json`). COPY `fixtures.json` from -js
  on every re-stamp; never regenerate it (`generator.describe` depends on the clone). All six
  fixtures are tested (`init_check` and `wasi_io_50` since `d03da9c`, 2026-10-26). Unchanged by
  SPEC 4.0.0. Detail: [handoffs.md](handoffs.md).

## Build / release flow

- **Build:** `go build ./...`. **Test:** `go test ./...`. **Gate:** `bun scripts/compat.ts`.
- **Release (since 2026-11-08; first used for v0.3.0):** `bun scripts/bump.ts patch|minor|major`
  (gated; stamps CHANGELOG and README) → commit `release: vX.Y.Z` → annotated tag `vX.Y.Z`
  (`git tag -a -F <file>`) → push `main`, then the tag — tagging and pushing only on the owner's
  word → CI (below) → warm the proxy. Before tagging, run CI's own gate locally on the tagged
  commit: `bun scripts/compat.ts --release vX.Y.Z`. Installable via `go get`, indexed on
  pkg.go.dev. No registry upload / secrets needed (unlike the JSR/PyPI/Maven ports).
- **Proxy warm step:** after pushing the tag, run `GOPROXY=https://proxy.golang.org go list -m
  github.com/synapticforge1/universalWasmLoader-go@vX.Y.Z` (from a scratch dir) to make `go get`
  resolve immediately and queue pkg.go.dev indexing. (v0.1.0 was warmed at the old `jrmarcum` path.)

## Release history

- **v0.3.0 — published 2026-11-08** (owner: "yes release 0.3.0"). SPEC 4.0.0. `bump.ts minor`
  (Rule 6) → `faf46bb` `release: v0.3.0`; annotated tag `v0.3.0` (object `b128bb4`) → `faf46bb`;
  `main` and the tag pushed, read back with `ls-remote`. CI run 42508941015, the first of the
  two-job workflow: `checks` and `release` all green (gate: floor major, Rule 6, v0.2.0's 7 tests
  green). GitHub Release `v0.3.0` with the CHANGELOG notes; `proxy.golang.org` serves v0.3.0 at
  `faf46bb` (warmed with `go list -m`).

- **v0.2.0 — published 2026-10-20.** Module path moved to `github.com/synapticforge1/...` after the
  repo transfer (breaking for importers, no API change). See "Repository location".
- **v0.1.0 — published 2026-06-24** (under the old `github.com/jrmarcum/...` module path) (first public release; annotated tag pushed to `origin`). Proxy
  warmed (`proxy.golang.org` serves it); pkg.go.dev indexes within minutes. `CHANGELOG.md` (Keep a
  Changelog format) added at repo root.
- **GitHub Releases are automated via `.github/workflows/release.yml`** (added 2026-06-24; fires
  on any `v*` tag push; `workflow_dispatch` backfills an old tag, idempotently). The GitHub CLI is
  not used anywhere, CI included (owner, 2026-11-08; working-rules Tooling 6). Its history:
  - 2026-06-24: one job — build, then the Release from the tag's `CHANGELOG.md` section.
  - 2026-10-26: `go vet` + `go test` gate added (a backfill of a tag that predates `tests/` skips
    them with a `::warning::`; a tag push never does).
  - 2026-11-08 (`928d1df`): the compatibility gate `bun scripts/compat.ts --release $TAG`.
  - **2026-11-08 (`2ff71ef`, owner, workspace C30): two jobs, no `uses:`.** `checks`
    (`contents: read`, tokenless clone) runs build / vet / test / gate; `release`
    (`contents: write`) runs only git, awk and `gh`, after checking the tag is still the commit
    `checks` passed. Go and Bun are installed from official downloads pinned by version + sha256
    (`GO_VERSION` must equal `go.mod`'s `go` line). `12e3fb4`: the notes heading is matched
    literally (`index`), since gawk reads the old dynamic regex as a bracket expression.
    First run: v0.3.0's, 42508941015, green.
  - **2026-11-09 (workspace H30, no GitHub CLI): the `release` job runs `scripts/github-release.ts`**
    (Bun pinned by sha256, downloads retried; GitHub's REST API with `GITHUB_TOKEN`) in place of
    the `awk` notes step and the CLI's view / edit / create. The tag must exist and peel to the
    commit `checks` passed; an existing Release gets its notes updated (as the CLI's edit did); a
    write is read back. A backfilled tag that predates the script uses the default branch's copy.
    Proven read-only against the real GitHub: v0.1.0 / v0.2.0 / v0.3.0 → "exists with these
    notes" (the new notes equal the bodies the old step wrote), a wrong commit and an absent tag
    refused. A mock API covered the write paths (8 cases; a mutant with the commit check skipped
    turned exactly "tag moved" red). **UNMEASURED on GitHub until the next tag run.**

## Repo publishing decisions (2026-06-24)

- **`CLAUDE.md` is gitignored and untracked** (owner request, 2026-06-24). **`tests/` was too
  (2026-06-24 → 2026-10-26); it is TRACKED since 2026-10-26** (owner) — the stamped fixtures, kept
  byte-exact by `.gitattributes` (`tests/** -text`). They ship in the module zip; consumers ignore them.
- **`cmem/` is TRACKED again since 2026-10-26** (workspace letter H7 / drift L1; owner, 2026-10-22:
  fine as long as it displays no secrets or personal information). It was gitignored 2026-06-24 →
  2026-10-26. Scanned before tracking (drive paths, emails, tokens): 0 hits. Private, per-machine
  facts go in the gitignored `cmem/local/`. `.claude/settings.local.json` is gitignored (tool
  settings are never tracked).
- **Consequence (2026-06-24 → 2026-10-26) — tests didn't run on a fresh clone**: `loader_test.go`
  loads fixtures from `tests/`, which was untracked. Resolved by tracking `tests/` and gating the
  release workflow on `go vet` + `go test` (2026-10-26).
- **README license note corrected** to `MIT` (was `MIT OR Apache-2.0`) to match the single MIT
  `LICENSE` file — there is no Apache-2.0 text. Switch to true dual-licensing only by adding a
  `LICENSE-APACHE` file.
