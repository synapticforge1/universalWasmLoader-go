# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

**No change to the library's behaviour.**

### Changed

- Conforms to SPEC **4.0.1**, a clarification: its §11.1 now allows what this loader has done since
  v0.3.0 — `LoadOptions{}` (a zero `Timeout`) means the 30 s default, a negative `Timeout` is an
  error, and `NoTimeout` turns the limit off. The README and the `LoadOptions` docs say so.

## [v0.3.2] - 2026-11-09

**No change to the library.**

### Changed

- The release workflow makes each new tag's GitHub Release page in a fixed order: the tag must
  exist and point at the checked commit, an existing page is left alone, and the new page is read
  back. Each request to GitHub has a 30 s limit. The page now opens with a pkg.go.dev link.

## [v0.3.1] - 2026-11-09

**No change to the library**: the API, behaviour and SPEC level (4.0.0) are those of v0.3.0, and
upgrading needs nothing. This release changes how releases are made.

### Changed

- The release workflow writes the GitHub Release through GitHub's REST API instead of the GitHub
  CLI. It refuses unless the tag already exists and points at the commit the checks passed, and it
  reads the Release back after writing it. The notes are still this file's section for the tag.

## [v0.3.0] - 2026-11-08

Re-aligned to the cross-language **SPEC 4.0.0** — loud failures. Each item below refuses
something v0.2.0 accepted, so this is a breaking release (a pre-1.0 minor). Fixtures unchanged.

### Changed

- **Breaking:** only an ABSENT `.wit` (no file; HTTP 404 / 410) loads raw exports. Any other
  `.wit` failure — another HTTP status, a network error, the time limit, an unreadable file —
  fails the load naming the `.wit`, before the `.wasm` is read. v0.2.0 silently fell back to raw.
- **Breaking:** the `.wit` is parsed strictly (SPEC §2 grammar). An unsupported type (`u32` is no
  longer read as `s32`), a malformed or duplicate parameter, a duplicate function, an empty file
  or text outside the one `world` fails the load naming the `.wit` and the fault. A WIT export the
  module does not export fails the load.
- **Breaking:** every WIT import needs a host callback; all missing ones are named at load
  (v0.2.0 returned 0 when WASM called the import). A callback's signature must fit its import
  (checked at load); its return value is checked against the WIT result and never coerced; a
  channel result (a value WASM cannot wait for) and an import returning `string` are refused.
- **Breaking:** typed calls check the argument count and each argument's kind and range, never
  coercing: `add(2.7, 1)` (was 3), `add(1, 2^31)` (wrapped), `add(true, 1)` (was 2) and
  `multiply(2, 4.0)` are errors naming the export and the parameter.
- **Breaking:** raw calls (no `.wit`) encode arguments and decode results by the export's WASM
  signature: `i32` → `int32`, `f64` → `float64` (v0.2.0 returned every result as a raw `uint64`,
  so an `f64` came back as its bit pattern), with an arity check.
- A path that does not end in `.wasm` loads raw; v0.2.0 looked for `<path>.wit`. A URL's query and
  fragment are no longer carried to the `.wit` URL (v0.2.0 fetched `x.wasm?v=1` a second time AS
  its `.wit`).
- A `Module` keeps working after the `ctx` it was loaded with is cancelled.

### Added

- Each http(s) fetch has a time limit, **30 s by default**, from the request to the last byte;
  `ctx` cancels the load (an already-cancelled one before any fetch). `ImportWithOptions`,
  `LoadOptions{Timeout}`, `DefaultTimeout` and `NoTimeout`. Each file is fetched once.
- A string argument on a module without `cabi_realloc` or memory is an error (v0.2.0 panicked).

## [v0.2.0] - 2026-10-20

### Changed

- **Breaking:** the module path is now `github.com/synapticforge1/universalWasmLoader-go`
  (was `github.com/jrmarcum/universalWasmLoader-go`), following the repository's move to the
  `synapticforge1` organization. Update your import path and `go get` the new module. No API
  changes; v0.1.0 remains available at the old path.

## [v0.1.0] - 2026-06-24

First public release.

### Added

- WIT-aware WebAssembly loader built on pure-Go [wazero](https://github.com/tetratelabs/wazero)
  (no CGO) — `go get` with trivial cross-compilation.
- `Load` (synchronous, file) and `Import` (file or `http(s)` URL) entry points.
- `Module.Call` / `Module.Bind` — call exports by camelCase name with Canonical-ABI
  marshalling: numbers direct, strings encoded/decoded through linear memory (including
  callee-allocated string returns + `cabi_post_<name>`), booleans normalized.
- Host import callbacks via `NewCallbacks().On(camelName, fn)`, dispatched by reflection.
- `@N` version pinning against a module's exported `version` global (C SONAME convention).
- `CreateSingleton` — load-once, identity-stable `*Module`.
- `NewInstancePool` — bounded pool of independent runtimes for servers/concurrency
  (`Acquire` / `Release` / `Run` / `Close`).
- WASI Preview 1 support (SPEC §10) via wazero's built-in `wasi_snapshot_preview1`;
  pure-compute modules need no configuration.
- Conforms to the cross-language SPEC v3.0.0.

[v0.3.2]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/v0.3.2
[v0.3.1]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/v0.3.1
[v0.3.0]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/v0.3.0
[v0.2.0]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/v0.2.0
[v0.1.0]: https://github.com/synapticforge1/universalWasmLoader-go/releases/tag/v0.1.0
