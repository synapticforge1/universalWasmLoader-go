# universalWasmLoader-go

The **Go port** of the [Universal WASM Loader](https://github.com/synapticforge1/universalWasmLoader-js) —
a WIT-aware WebAssembly loader. Load a `.wasm` library, read its companion `.wit` interface, and call
each export as an idiomatic Go function with Canonical-ABI marshalling handled for you (numbers
direct, strings encoded/decoded through linear memory, booleans normalized).

- **Pure Go — no CGO.** Built on [wazero](https://github.com/tetratelabs/wazero), so `go get` just
  works: no C toolchain, no native `libwasmtime` to ship, trivial cross-compilation.
- **WASI Preview 1 built in** (SPEC §10) — I/O-using libraries (`console.log` → `fd_write`)
  instantiate with zero config; pure-compute modules need nothing.
- Conforms to the cross-language **SPEC.md v4.0.1** (Canonical ABI, callee-allocated string returns +
  `cabi_post_<name>`; loud failures — see below).

### ⚠️ Breaking Changes

| Version | What changed | How to migrate |
| --- | --- | --- |
| v0.3.0 (SPEC 4.0.0) | Only an **absent** `.wit` (no file, HTTP 404 / 410) loads raw; any other `.wit` failure, and a `.wit` that does not parse (e.g. `u32`, a malformed parameter, an empty file), fails the load. Every WIT import needs a host callback whose signature fits it (checked at load); its return value is checked, never coerced. Typed calls refuse a wrong count or kind (`add(2.7, 1)`, `isEven(true)`, `multiply(2, 4.0)`). A WIT export the module lacks fails the load. Raw calls encode and decode by the export's WASM signature: an `i32` result is now `int32` (was `uint64`), an `f64` result `float64` (was its bit pattern). Each http(s) fetch has a 30 s limit. A path that does not end in `.wasm` loads raw. | Ship a `.wit` that parses, or none. Register a callback for every WIT import, with the Go types of the table below. Pass integers for `s32`/`s64` and floats for `f32`/`f64`. Change raw-result type assertions (`.(uint64)` → `.(int32)` / `.(float64)` …). Use `ImportWithOptions` for another time limit. |
| v0.2.0 | Module path → `github.com/synapticforge1/universalWasmLoader-go` | Change the import path |

## Install

```sh
go get github.com/synapticforge1/universalWasmLoader-go
```

> The repository moved to the `synapticforge1` organization. v0.1.0 was published under the old
> module path `github.com/jrmarcum/universalWasmLoader-go`; releases from v0.2.0 on use the path
> above. To upgrade, change your import path and `go get` the new module.

## Usage

```go
package main

import (
	"fmt"

	wasmloader "github.com/synapticforge1/universalWasmLoader-go"
)

func main() {
	// Load a .wasm library. The companion .wit (math.wit) is auto-detected.
	m, err := wasmloader.Load("math.wasm")
	if err != nil {
		panic(err)
	}
	defer m.Close()

	// Namespace pattern — call exports by camelCase name.
	sum, _ := m.Call("add", 3, 4) // int32(7)
	fmt.Println(sum)

	// Destructure pattern — bind an export as a standalone callable.
	square := m.Bind("square")
	sq, _ := square(5) // int32(25)
	fmt.Println(sq)

	// Strings round-trip through the Canonical ABI automatically.
	greeting, _ := m.Call("greet", "World") // "Hello, World!"
	fmt.Println(greeting)
}
```

### Host import callbacks

Register host functions the module calls into, keyed by the **camelCase** WIT import name — one for
**every** WIT import, or the load fails naming the missing ones. Each callback takes one parameter
per WIT parameter, of the Go type in the table below (or `any`), and an import with a result returns
exactly one value of that kind; a value outside the WIT type's domain is an error from the export
call that reached the import, never coerced. An import whose WIT result is `string` is refused.

```go
cbs := wasmloader.NewCallbacks().
	On("envMul", func(a, b float64) float64 { return a * b }).
	On("envAdd", func(a, b int32) int32 { return a + b })

m, _ := wasmloader.Load("imports.wasm", cbs)
v, _ := m.Call("scale", 3.0, 4.0) // float64(12)
```

### Version pinning

Append `@N` to assert the module's exported `version` global (the C SONAME convention):

```go
m, err := wasmloader.Load("math.wasm@2") // errors if version != 2
```

### Singleton (load once, share)

```go
get := wasmloader.CreateSingleton("math.wasm")
m1, _ := get() // loads
m2, _ := get() // same instance (m1 == m2)
```

### Instance pool (servers / concurrency)

Each instance has its own linear memory; `Run` acquires, calls, and releases atomically:

```go
pool := wasmloader.NewInstancePool("math.wasm", 4)
defer pool.Close()

result, _ := pool.Run(func(m *wasmloader.Module) (any, error) {
	return m.Call("add", 20, 22) // int32(42)
})
```

### Loading from a URL

`Load` is synchronous and file-only. For `http://`/`https://` sources use `Import`; `ctx` cancels
the load, and each fetch (the `.wit`, then the `.wasm`, each fetched once) has a 30 s limit from the
request to the last byte:

```go
m, err := wasmloader.Import(ctx, "https://example.com/math.wasm")

// Another limit (or wasmloader.NoTimeout):
m, err = wasmloader.ImportWithOptions(ctx, "https://example.com/math.wasm", nil,
	wasmloader.LoadOptions{Timeout: 5 * time.Second})
```

`LoadOptions{}` (a zero `Timeout`) means the 30 s default, a negative `Timeout` is an error, and
`NoTimeout` turns the limit off — Go's zero-value convention, which SPEC 4.0.1 §11.1 allows.

An HTTP error is an error naming the status and URL. A `.wit` answering 404 or 410 means "no `.wit`"
(raw exports); any other status, a network error or the time limit fails the load. The `.wasm` URL's
query and fragment are not carried to the `.wit` URL. `CreateSingleton` and `NewInstancePool` load
files only, so they take no options.

## Type mapping

| WIT type | Go argument (checked, never coerced) | Go return / callback parameter |
| --- | --- | --- |
| `s32` | any Go integer in [-2³¹, 2³¹ − 1] | `int32` |
| `s64` | any Go integer in [-2⁶³, 2⁶³ − 1] | `int64` |
| `f32` | `float32` / `float64` | `float32` |
| `f64` | `float32` / `float64` | `float64` |
| `bool` | `bool` | `bool` |
| `string` | `string` | `string` |

A wrong argument count, or an argument outside its type's domain (a float for `s32`, an integer for
`f64`, an integer for `bool`), is an error naming the export and the parameter.

A module with no companion `.wit` is loaded with raw exports; `Call` then encodes each argument and
decodes each result by the export's own WASM types (`i32` → `int32`, `i64` → `int64`, `f32` →
`float32`, `f64` → `float64`; several results as `[]any`). Strings require a `.wit`.

## Test

```sh
go test ./...
```

The suite covers the cross-language SPEC §8 fixtures (`loader_test.go`) — numeric round-trip, bool
normalization, string params/returns (Canonical ABI), host import callbacks, the §10 `_initialize` and
WASI fixtures — plus `Bind`, the singleton and the concurrent instance pool; and every row of SPEC
4.0.0 §8 "Refusals" (`refusal_test.go`), the http rows against a local server that counts requests.

## License

MIT (see `LICENSE`).
