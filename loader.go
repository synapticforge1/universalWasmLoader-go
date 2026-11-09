package wasmloader

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// Module is a loaded WebAssembly library with its WIT interface applied. Call exports by
// their camelCase name via [Module.Call] or [Module.Bind]. Close it with [Module.Close]
// when done to release the underlying wazero runtime and linear memory.
type Module struct {
	ctx     context.Context
	runtime wazero.Runtime
	mod     api.Module
	memory  api.Memory
	realloc func(ctx context.Context, n uint32) (uint32, error)
	exports map[string]witFunc // camelName -> signature; nil for a raw (no-WIT) module
	raw     bool
}

// DefaultTimeout is the time limit for each http(s) fetch when [LoadOptions.Timeout] is zero
// (SPEC 4.0.0 §11).
const DefaultTimeout = 30 * time.Second

// NoTimeout, as [LoadOptions.Timeout], disables the per-fetch time limit.
const NoTimeout time.Duration = math.MaxInt64

// LoadOptions configures [ImportWithOptions] (SPEC 4.0.1 §1, §11). The zero value is the
// default — Go's convention, which SPEC 4.0.1 §11.1 allows a zero-value options type: a zero
// Timeout means [DefaultTimeout], a negative one is an error, and [NoTimeout] (never zero) means
// no limit. Cancellation is the context passed to the load.
type LoadOptions struct {
	// Timeout is the time limit for EACH http(s) fetch — the `.wit`, then the `.wasm` —
	// from the request to the last byte of the body. Zero means [DefaultTimeout] (30 s);
	// [NoTimeout] disables the limit; a negative value is an error. Local files are read
	// without a limit.
	Timeout time.Duration
}

func (o LoadOptions) timeout() (time.Duration, error) {
	switch {
	case o.Timeout < 0:
		return 0, fmt.Errorf("wasmloader: LoadOptions.Timeout must be positive, zero (the 30 s default) or NoTimeout, got %v", o.Timeout)
	case o.Timeout == 0:
		return DefaultTimeout, nil
	}
	return o.Timeout, nil
}

var versionSuffixRe = regexp.MustCompile(`@(\d+)$`)

// parseVersionSuffix splits an optional `@N` version suffix from a path (SPEC §3).
func parseVersionSuffix(path string) (clean string, requested int, hasVersion bool) {
	if m := versionSuffixRe.FindStringSubmatch(path); m != nil {
		n, _ := strconv.Atoi(m[1])
		return path[:len(path)-len(m[0])], n, true
	}
	return path, 0, false
}

// Load reads and instantiates a `.wasm` library from a file path (synchronous — no
// goroutine/await ceremony). It auto-detects the companion `.wit` (replacing the `.wasm`
// suffix) and applies the Canonical ABI; only when that file does not exist (or the path
// does not end in `.wasm`) are raw exports used — a `.wit` that cannot be read or does not
// parse is an error (SPEC 4.0.0 §2). An optional `@N` suffix on the path pins the module's
// exported `version` global (SPEC §3). Pass a [Callbacks] with one callback for every WIT
// import (SPEC 4.0.0 §4).
func Load(path string, cbs ...*Callbacks) (*Module, error) {
	return load(context.Background(), path, false, firstCallbacks(cbs), 0)
}

// Import loads a `.wasm` library from either a file path or an `http://`/`https://` URL,
// with the default [LoadOptions] (a 30 s limit on each fetch). ctx cancels the load. Use
// this when the source may be a URL; for plain file paths, [Load] is simpler. Honors the
// same `@N` version-pin suffix.
func Import(ctx context.Context, source string, cbs ...*Callbacks) (*Module, error) {
	return ImportWithOptions(ctx, source, firstCallbacks(cbs), LoadOptions{})
}

// ImportWithOptions is [Import] with an explicit [LoadOptions] (SPEC 4.0.0 §11). cbs may be
// nil when the `.wit` declares no imports. A context already cancelled fails the load before
// any read or fetch; one cancelled during a fetch fails it with the context's cause.
func ImportWithOptions(ctx context.Context, source string, cbs *Callbacks, opts LoadOptions) (*Module, error) {
	limit, err := opts.timeout()
	if err != nil {
		return nil, err
	}
	return load(ctx, source, true, cbs, limit)
}

func isHTTP(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}

// load is the shared path. Order (SPEC 4.0.0): the `.wit` is read and parsed and the host
// callbacks are checked BEFORE the `.wasm` is read or fetched; then instantiate.
func load(ctx context.Context, source string, allowHTTP bool, cbs *Callbacks, limit time.Duration) (*Module, error) {
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("wasmloader: load of %q cancelled: %w", source, context.Cause(ctx))
	}
	clean, requested, hasVersion := parseVersionSuffix(source)
	remote := allowHTTP && isHTTP(clean)

	witLoc, err := witLocationFor(clean, remote)
	if err != nil {
		return nil, err
	}
	var parsed *parsedWit
	if witLoc != "" {
		src, found, err := readWit(ctx, witLoc, remote, limit)
		if err != nil {
			return nil, err
		}
		if found {
			p, err := parseWit(src)
			if err != nil {
				return nil, fmt.Errorf("wasmloader: invalid .wit %q: %w", witLoc, err)
			}
			if err := checkCallbacks(p.Imports, cbs); err != nil {
				return nil, err
			}
			parsed = &p
		}
	}

	var wasmBytes []byte
	if remote {
		wasmBytes, err = fetchOnce(ctx, clean, limit)
		if err != nil {
			return nil, err
		}
	} else if wasmBytes, err = os.ReadFile(clean); err != nil {
		return nil, fmt.Errorf("wasmloader: read %q: %w", clean, err)
	}
	return instantiate(ctx, wasmBytes, parsed, clean, requested, hasVersion, cbs)
}

// witLocationFor is the companion `.wit` of a `.wasm` path or URL (SPEC 4.0.0 §2): the
// `.wasm` suffix replaced; a URL's query and fragment are not carried over. "" when the
// path does not end in `.wasm` — there is no companion name, and the module loads raw.
func witLocationFor(wasmLoc string, remote bool) (string, error) {
	if !remote {
		if !strings.HasSuffix(strings.ToLower(wasmLoc), ".wasm") {
			return "", nil
		}
		return wasmLoc[:len(wasmLoc)-len(".wasm")] + ".wit", nil
	}
	u, err := url.Parse(wasmLoc)
	if err != nil {
		return "", fmt.Errorf("wasmloader: invalid URL %q: %w", wasmLoc, err)
	}
	if !strings.HasSuffix(strings.ToLower(u.Path), ".wasm") {
		return "", nil
	}
	u.Path = u.Path[:len(u.Path)-len(".wasm")] + ".wit"
	u.RawPath = ""
	u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = "", false, "", ""
	return u.String(), nil
}

// readWit reads the companion `.wit`. found is false ONLY when it is absent — the file does
// not exist, or HTTP 404 / 410 — which selects raw exports (SPEC 4.0.0 §2). Every other
// failure is an error naming the `.wit`.
func readWit(ctx context.Context, loc string, remote bool, limit time.Duration) (src string, found bool, err error) {
	var b []byte
	if remote {
		b, err = fetchOnceAllowAbsent(ctx, loc, limit, true)
		if errors.Is(err, errAbsent) {
			return "", false, nil
		}
	} else {
		b, err = os.ReadFile(loc)
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		if err != nil {
			err = fmt.Errorf("wasmloader: cannot read .wit %q: %w", loc, err)
		}
	}
	if err != nil {
		return "", false, err
	}
	if !utf8.Valid(b) {
		return "", false, fmt.Errorf("wasmloader: invalid .wit %q: not valid UTF-8", loc)
	}
	return string(b), true, nil
}

// errAbsent marks a `.wit` fetch answered 404 / 410.
var errAbsent = errors.New("absent")

// httpClient has no client-wide timeout: each fetch carries its own limit (SPEC §11).
var httpClient = &http.Client{}

// fetchOnce fetches url once (never retried), under ONE time limit from the request to the
// last byte of the body and the caller's ctx. A non-2xx status is an error naming the
// status and the URL (SPEC 4.0.0 §7.8, §11).
func fetchOnce(ctx context.Context, u string, limit time.Duration) ([]byte, error) {
	return fetchOnceAllowAbsent(ctx, u, limit, false)
}

func fetchOnceAllowAbsent(ctx context.Context, u string, limit time.Duration, absentOK bool) ([]byte, error) {
	fctx, cancel := ctx, context.CancelFunc(func() {})
	if limit != NoTimeout {
		fctx, cancel = context.WithTimeoutCause(ctx, limit, errFetchTimeout)
	}
	defer cancel()
	why := func(err error) error {
		if ctx.Err() != nil {
			return fmt.Errorf("wasmloader: fetch of %s cancelled: %w", u, context.Cause(ctx))
		}
		if errors.Is(context.Cause(fctx), errFetchTimeout) {
			return fmt.Errorf("wasmloader: timed out after %v fetching %s", limit, u)
		}
		return fmt.Errorf("wasmloader: could not fetch %s: %w", u, err)
	}
	req, err := http.NewRequestWithContext(fctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, fmt.Errorf("wasmloader: invalid URL %q: %w", u, err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, why(err)
	}
	defer resp.Body.Close()
	if absentOK && (resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone) {
		return nil, errAbsent
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, fmt.Errorf("wasmloader: HTTP %s for %s", resp.Status, u)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, why(err)
	}
	return b, nil
}

var errFetchTimeout = errors.New("fetch time limit reached")

// instantiate builds a runtime, provides the WASI-P1 shim (SPEC §10), wires host imports,
// instantiates, checks the WIT exports exist, calls `_initialize`, and verifies the version.
func instantiate(ctx context.Context, wasmBytes []byte, parsed *parsedWit, path string, requested int, hasVersion bool, cbs *Callbacks) (*Module, error) {
	r := wazero.NewRuntime(ctx)
	ok := false
	defer func() {
		if !ok {
			_ = r.Close(ctx)
		}
	}()

	// SPEC §10: always provide the built-in WASI Preview 1 shim so an I/O-using library
	// (e.g. a modc library that calls console.log → fd_write) instantiates. Unused import
	// namespaces are ignored, so pure-compute modules are unaffected.
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, r); err != nil {
		return nil, fmt.Errorf("wasmloader: instantiate WASI shim: %w", err)
	}
	if parsed != nil && len(parsed.Imports) > 0 {
		if err := registerEnvImports(ctx, r, parsed.Imports, cbs); err != nil {
			return nil, fmt.Errorf("wasmloader: register host imports: %w", err)
		}
	}

	// Do not auto-run _start; we control initialization via _initialize (SPEC §10).
	cfg := wazero.NewModuleConfig().
		WithName("").
		WithStdout(os.Stdout).
		WithStderr(os.Stderr).
		WithStartFunctions()
	mod, err := r.InstantiateWithConfig(ctx, wasmBytes, cfg)
	if err != nil {
		return nil, fmt.Errorf("wasmloader: instantiate %q: %w", path, err)
	}

	m := &Module{ctx: context.WithoutCancel(ctx), runtime: r, mod: mod, memory: mod.Memory()}
	if cabi := mod.ExportedFunction("cabi_realloc"); cabi != nil {
		m.realloc = func(ctx context.Context, n uint32) (uint32, error) {
			res, err := cabi.Call(ctx, 0, 0, 1, uint64(n))
			if err != nil {
				return 0, err
			}
			return uint32(res[0]), nil
		}
	}

	// SPEC 4.0.0 §2: a WIT export the module does not export fails the load, naming it.
	if parsed != nil {
		var absent []string
		for _, e := range parsed.Exports {
			if mod.ExportedFunction(e.TsName) == nil {
				absent = append(absent, fmt.Sprintf("%s (WIT %q)", e.TsName, e.Name))
			}
		}
		if len(absent) > 0 {
			s := ""
			if len(absent) > 1 {
				s = "s"
			}
			return nil, fmt.Errorf("wasmloader: the .wit declares export%s the module %q does not export: %s", s, path, strings.Join(absent, ", "))
		}
	}

	// SPEC §10: run the reactor initializer once before any other export.
	if init := mod.ExportedFunction("_initialize"); init != nil {
		if _, err := init.Call(ctx); err != nil {
			return nil, fmt.Errorf("wasmloader: _initialize failed: %w", err)
		}
	}

	if hasVersion {
		if err := assertVersion(m, requested, path); err != nil {
			return nil, err
		}
	}

	if parsed != nil {
		m.exports = make(map[string]witFunc, len(parsed.Exports))
		for _, e := range parsed.Exports {
			m.exports[e.TsName] = e
		}
	} else {
		m.raw = true
	}

	ok = true
	return m, nil
}

// assertVersion enforces an `@N` version pin against the module's exported `version` global.
func assertVersion(m *Module, requested int, path string) error {
	g := m.mod.ExportedGlobal("version")
	if g == nil {
		return fmt.Errorf("wasmloader: version @%d requested for %q but the module exports no \"version\" global", requested, path)
	}
	actual := int32(uint32(g.Get()))
	if int(actual) != requested {
		return fmt.Errorf("wasmloader: version mismatch for %q — requested @%d, module exports version %d", path, requested, actual)
	}
	return nil
}

// Call invokes an export by its camelCase name, marshalling native Go arguments to/from the
// WASM Canonical ABI. Arguments are checked against the WIT signature and never coerced
// (SPEC 4.0.0 §4): s32 / s64 take any Go integer within range, f32 / f64 a float32 or
// float64, bool a bool, string a string. Returns the decoded result (int32, int64,
// float32, float64, bool or string), or nil for a void export.
//
// For a raw module (no `.wit`), arguments are encoded by the export's own WASM signature
// and the results decoded by it: one result is returned as it is, several as []any.
func (m *Module) Call(name string, args ...any) (any, error) {
	if m.raw {
		return m.callRaw(name, args...)
	}
	fn, ok := m.exports[name]
	if !ok {
		return nil, fmt.Errorf("wasmloader: export %q not found in WIT interface", name)
	}
	if err := checkArgs(fn, args); err != nil {
		return nil, err
	}
	wasmArgs := make([]uint64, 0, len(fn.Params))
	for i, p := range fn.Params {
		vals, err := encodeParam(m.ctx, m, p.Type, args[i])
		if err != nil {
			return nil, fmt.Errorf("wasmloader: %s: parameter %s: %w", signature(fn), p.Name, err)
		}
		wasmArgs = append(wasmArgs, vals...)
	}
	raw, err := m.mod.ExportedFunction(fn.TsName).Call(m.ctx, wasmArgs...)
	if err != nil {
		return nil, fmt.Errorf("wasmloader: calling %q: %w", name, err)
	}
	return m.decodeResult(m.ctx, fn, raw)
}

// callRaw calls an export of a module with no companion `.wit`, encoding each argument and
// decoding each result by the export's WASM value types (never by the Go argument's type,
// and never returning a float's bit pattern). Strings need a `.wit`.
func (m *Module) callRaw(name string, args ...any) (any, error) {
	wasmFn := m.mod.ExportedFunction(name)
	if wasmFn == nil {
		return nil, fmt.Errorf("wasmloader: raw export %q not found", name)
	}
	def := wasmFn.Definition()
	pts := def.ParamTypes()
	if len(args) != len(pts) {
		return nil, fmt.Errorf("wasmloader: raw export %q takes %d argument(s), got %d", name, len(pts), len(args))
	}
	wasmArgs := make([]uint64, len(args))
	for i, a := range args {
		w, ok := encodeRaw(pts[i], a)
		if !ok {
			return nil, fmt.Errorf("wasmloader: raw export %q: argument %d must fit WASM %s, got %s (a string needs a .wit)",
				name, i+1, api.ValueTypeName(pts[i]), showValue(a))
		}
		wasmArgs[i] = w
	}
	raw, err := wasmFn.Call(m.ctx, wasmArgs...)
	if err != nil {
		return nil, fmt.Errorf("wasmloader: calling raw %q: %w", name, err)
	}
	rts := def.ResultTypes()
	switch len(rts) {
	case 0:
		return nil, nil
	case 1:
		return decodeRaw(rts[0], raw[0]), nil
	}
	out := make([]any, len(rts))
	for i, t := range rts {
		out[i] = decodeRaw(t, raw[i])
	}
	return out, nil
}

// Bind returns a standalone callable for a named export, approximating JS destructuring:
//
//	add := m.Bind("add")
//	sum, _ := add(3, 4)
func (m *Module) Bind(name string) func(args ...any) (any, error) {
	return func(args ...any) (any, error) {
		return m.Call(name, args...)
	}
}

// Exports returns the camelCase names of the module's WIT exports (empty for a raw module).
func (m *Module) Exports() []string {
	names := make([]string, 0, len(m.exports))
	for n := range m.exports {
		names = append(names, n)
	}
	return names
}

// Close releases the module's wazero runtime and linear memory.
func (m *Module) Close() error {
	return m.runtime.Close(m.ctx)
}

func firstCallbacks(cbs []*Callbacks) *Callbacks {
	if len(cbs) > 0 {
		return cbs[0]
	}
	return nil
}
