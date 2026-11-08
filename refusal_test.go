package wasmloader

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// SPEC 4.0.0 §8 "Refusals": every row is a test here. Each refusal must fail with an error
// whose message names what the SPEC's right-hand column names.

// wantErr fails unless err is non-nil and its message contains every one of want.
func wantErr(t *testing.T, what string, err error, want ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: no error; want one naming %q", what, want)
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Errorf("%s: error %q does not name %q", what, err, w)
		}
	}
}

// fixtureDir copies a fixture `.wasm` into a temp dir, beside an optional `.wit` text, and
// returns the `.wasm` path. wit == "" leaves the `.wit` absent.
func fixtureDir(t *testing.T, fixture, wit string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("tests", fixture+".wasm"))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	p := filepath.Join(dir, fixture+".wasm")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	if wit != "" {
		if err := os.WriteFile(filepath.Join(dir, fixture+".wit"), []byte(wit), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func readFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("tests", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Row: imports_50 with no host callbacks → names both envMul and envAdd.
// Row: imports_50 with only envMul → names envAdd.
func TestRefuseMissingCallbacks(t *testing.T) {
	_, err := Load("tests/imports_50.wasm")
	wantErr(t, "no callbacks", err, "envMul", "envAdd", "env-mul", "env-add")
	_, err = Load("tests/imports_50.wasm", NewCallbacks().On("envMul", func(a, b float64) float64 { return a * b }))
	wantErr(t, "only envMul", err, "envAdd")
	if err != nil && strings.Contains(err.Error(), "envMul") {
		t.Errorf("only envMul: error %q names the callback that IS present", err)
	}
}

// Row: envAdd returns a value outside its s32 result → names the callback, its WIT import and
// result type, and the value. Go's static types stand in for JS's undefined / "17" / 17n: a
// callback whose declared result cannot carry an s32 is refused at load; one returning `any`
// is checked by value when WASM calls it, and the error reaches combine's caller.
func TestRefuseCallbackResult(t *testing.T) {
	mul := func(a, b float64) float64 { return a * b }
	atLoad := map[string]any{
		"float64 result": func(a, b int32) float64 { return 17 },
		"bool result":    func(a, b int32) bool { return true },
		"string result":  func(a, b int32) string { return "17" },
		"no result":      func(a, b int32) {},
		"two results":    func(a, b int32) (int32, error) { return 17, nil },
		"wrong params":   func(a, b float64) int32 { return 17 },
		"not a func":     17,
	}
	for name, cb := range atLoad {
		_, err := Load("tests/imports_50.wasm", NewCallbacks().On("envMul", mul).On("envAdd", cb))
		wantErr(t, name, err, "envAdd", "env-add")
	}
	atCall := map[string]any{
		"nil":       nil,
		"2.9":       2.9,
		"2^31":      int64(1) << 31,
		"true":      true,
		`"17"`:      "17",
		"a chan":    make(chan int32),
		"-2^31-1":   int64(-1)<<31 - 1,
		"uint 2^32": uint64(1) << 32,
	}
	for name, v := range atCall {
		v := v
		m := mustLoad(t, "tests/imports_50.wasm", NewCallbacks().On("envMul", mul).On("envAdd", func(a, b int32) any { return v }))
		_, err := m.Call("combine", 10, 7)
		wantErr(t, "envAdd returns "+name, err, "envAdd", "env-add", "s32")
	}
	// In range: an int (not int32) result is the same value, accepted.
	m := mustLoad(t, "tests/imports_50.wasm", NewCallbacks().On("envMul", mul).On("envAdd", func(a, b int32) int { return int(a + b) }))
	if got := call(t, m, "combine", 10, 7); got != int32(17) {
		t.Errorf("combine via an int result = %v; want 17", got)
	}
}

// Row: envMul is async (in Go: returns a channel, a value WASM cannot wait for) → names the
// callback and that it returned a channel.
func TestRefuseAsyncCallback(t *testing.T) {
	add := func(a, b int32) int32 { return a + b }
	_, err := Load("tests/imports_50.wasm", NewCallbacks().On("envMul", func(a, b float64) chan float64 { return nil }).On("envAdd", add))
	wantErr(t, "chan result at load", err, "envMul")
	m := mustLoad(t, "tests/imports_50.wasm", NewCallbacks().On("envMul", func(a, b float64) any { return make(chan float64) }).On("envAdd", add))
	_, err = m.Call("scale", 3.0, 4.0)
	wantErr(t, "chan result at call", err, "envMul", "channel")
}

// Row: a `.wit` whose import returns a string, beside imports_50.wasm → names the import; the
// load fails before the `.wasm` is read (the .wasm path here does not exist).
func TestRefuseStringResultImport(t *testing.T) {
	dir := t.TempDir()
	wit := "world w {\n  import env-mul: func(p0: f64, p1: f64) -> string;\n  export scale: func(a: f64, b: f64) -> f64;\n}\n"
	if err := os.WriteFile(filepath.Join(dir, "m.wit"), []byte(wit), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Load(filepath.Join(dir, "m.wasm"), NewCallbacks().On("envMul", func(a, b float64) string { return "" }))
	wantErr(t, "string-result import", err, "envMul", "env-mul", "string")
	if err != nil && strings.Contains(err.Error(), "read \"") {
		t.Errorf("the .wasm was read before the refusal: %v", err)
	}
}

// Rows: add("x", 1), add(2.7, 1), add(1, 2^31), add(1) on math_50; greet(42) on strings_50;
// isEven("4") on booleans_50 → names the export and the parameter (or the count).
func TestRefuseTypedArgs(t *testing.T) {
	m := mustLoad(t, "tests/math_50.wasm")
	for name, args := range map[string][]any{
		`add("x", 1)`:  {"x", 1},
		"add(2.7, 1)":  {2.7, 1},
		"add(true, 1)": {true, 1},
		"add(nil, 1)":  {nil, 1},
	} {
		_, err := m.Call("add", args...)
		wantErr(t, name, err, "add", "parameter a", "s32")
	}
	_, err := m.Call("add", 1, int64(1)<<31)
	wantErr(t, "add(1, 2^31)", err, "add", "parameter b", "s32")
	_, err = m.Call("add", 1)
	wantErr(t, "add(1)", err, "add", "expects 2 arguments, got 1")
	_, err = m.Call("multiply", 2, 4.0)
	wantErr(t, "multiply(2, 4.0)", err, "multiply", "parameter a", "f64")

	s := mustLoad(t, "tests/strings_50.wasm")
	_, err = s.Call("greet", 42)
	wantErr(t, "greet(42)", err, "greet", "string")
	b := mustLoad(t, "tests/booleans_50.wasm")
	_, err = b.Call("isEven", "4")
	wantErr(t, `isEven("4")`, err, "isEven", "s32")
	_, err = b.Call("isEven", 4.0)
	wantErr(t, "isEven(4.0)", err, "isEven", "s32")
	_, err = b.Call("isPositive", 1)
	wantErr(t, "isPositive(1)", err, "isPositive", "f64")
}

// Row: math_50.wasm beside a `.wit` that does not parse, or that uses u32 → names the `.wit`
// and the fault. Also: an empty `.wit` (3.0.0 read it as "no .wit"), a duplicate, and a WIT
// export the module lacks.
func TestRefuseBadWit(t *testing.T) {
	good := readFixture(t, "math_50.wit")
	cases := map[string]struct{ wit, fault string }{
		"missing comma":  {"world w { export add: func(a: s32 b: s32) -> s32; }", "malformed parameter"},
		"u32":            {strings.ReplaceAll(good, "s32", "u32"), `unsupported WIT type "u32"`},
		"list<u8>":       {"world w { export add: func(a: list<u8>) -> s32; }", "list<u8>"},
		"empty":          {"   \n// only a comment\n", "it is empty"},
		"two worlds":     {good + "\nworld x { }", "not a WIT world"},
		"no semicolon":   {"world w { export add: func(a: s32, b: s32) -> s32 }", "missing \";\""},
		"dup export":     {"world w { export add: func(a: s32, b: s32) -> s32; export add: func(a: s32, b: s32) -> s32; }", "duplicate export add"},
		"dup parameter":  {"world w { export add: func(a: s32, a: s32) -> s32; }", `duplicate parameter "a"`},
		"not a function": {"world w { use foo; }", "unsupported or malformed WIT statement"},
		"absent export":  {"world w { export subtract: func(a: s32, b: s32) -> s32; }", "subtract"},
	}
	for name, c := range cases {
		p := fixtureDir(t, "math_50", c.wit)
		_, err := Load(p)
		witName := "math_50.wit"
		if name == "absent export" {
			witName = "does not export"
		}
		wantErr(t, name, err, witName, c.fault)
	}
	// The strict parser still reads every fixture, comments and a trailing comma included.
	p := fixtureDir(t, "math_50", "// header\npackage a:b;\nworld w { // c\n export add: func(a: s32, b: s32,) -> s32; }")
	m, err := Load(p)
	if err != nil {
		t.Fatalf("a valid .wit with comments and a trailing comma: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
}

// H29 (3) / S8: math_50 with its `.wit` removed, raw multiply(2.5, 4.0) → 10.0 (0.2.0
// returned the f64's bit pattern as a uint64). Raw arguments fit the WASM type or fail.
func TestRawEncodesBySignature(t *testing.T) {
	m := mustLoad(t, fixtureDir(t, "math_50", ""))
	if !m.raw {
		t.Fatal("math_50 without a .wit should load raw")
	}
	if got := call(t, m, "multiply", 2.5, 4.0); got != float64(10) {
		t.Errorf("raw multiply(2.5, 4.0) = %v (%T); want float64(10)", got, got)
	}
	if got := call(t, m, "add", 3, 4); got != int32(7) {
		t.Errorf("raw add(3, 4) = %v (%T); want int32(7)", got, got)
	}
	_, err := m.Call("multiply", 2, 4.0)
	wantErr(t, "raw multiply(2, 4.0)", err, "multiply", "argument 1", "f64")
	_, err = m.Call("add", 3)
	wantErr(t, "raw add(3)", err, "add", "2 argument")
}

// SPEC §2: a path that does not end in `.wasm` has no companion `.wit` and loads raw — even
// when a `<path>.wit` exists (0.2.0 looked for it).
func TestNonWasmSuffixIsRaw(t *testing.T) {
	b, _ := os.ReadFile("tests/math_50.wasm")
	dir := t.TempDir()
	p := filepath.Join(dir, "math.bin")
	_ = os.WriteFile(p, b, 0o644)
	_ = os.WriteFile(p+".wit", []byte("not wit"), 0o644)
	m := mustLoad(t, p)
	if !m.raw {
		t.Error("a path not ending in .wasm should load raw")
	}
}

// A `.wit` that exists but cannot be read is an error, not raw (here: a directory).
func TestRefuseUnreadableWit(t *testing.T) {
	p := fixtureDir(t, "math_50", "")
	if err := os.Mkdir(strings.TrimSuffix(p, ".wasm")+".wit", 0o755); err != nil {
		t.Fatal(err)
	}
	_, err := Load(p)
	wantErr(t, "a directory as .wit", err, "cannot read .wit", "math_50.wit")
}

// --- over http ---

// server serves math_50 under several names and counts requests per path.
type server struct {
	*httptest.Server
	mu   sync.Mutex
	hits map[string]int
}

func newServer(t *testing.T, routes map[string]func(w http.ResponseWriter, r *http.Request)) *server {
	t.Helper()
	s := &server{hits: map[string]int{}}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		s.hits[r.URL.Path]++
		s.mu.Unlock()
		if h, ok := routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *server) count(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.hits[path]
}

func body(b string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(b)) }
}

// noQuery answers 400 when the request carries a query: SPEC §2 drops the `.wasm` URL's query
// and fragment from the companion `.wit` URL.
func noQuery(h func(http.ResponseWriter, *http.Request)) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RawQuery != "" || r.URL.ForceQuery {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		h(w, r)
	}
}

func status(code int) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(code) }
}

// Rows: the `.wit` answers 500; the `.wasm` answers 404 or 500 → the URL and the status, one
// request per file. And: a `.wit` answering 404 or 410 loads math_50 raw (add(3, 4) = 7).
func TestHTTPStatus(t *testing.T) {
	wasm := readFixture(t, "math_50.wasm")
	s := newServer(t, map[string]func(http.ResponseWriter, *http.Request){
		"/wit500.wasm": body(wasm), "/wit500.wit": status(500),
		"/wit404.wasm": body(wasm), "/wit404.wit": status(404),
		"/wit410.wasm": body(wasm), "/wit410.wit": status(410),
		"/wasm404.wasm": status(404), "/wasm404.wit": status(404),
		"/wasm500.wasm": status(500), "/wasm500.wit": status(404),
		"/typed.wasm": body(wasm), "/typed.wit": noQuery(body(readFixture(t, "math_50.wit"))),
	})
	ctx := context.Background()

	_, err := Import(ctx, s.URL+"/wit500.wasm")
	wantErr(t, ".wit 500", err, s.URL+"/wit500.wit", "500")
	if n := s.count("/wit500.wasm"); n != 0 {
		t.Errorf(".wit 500: the .wasm was fetched %d time(s) before the refusal; want 0", n)
	}
	for _, code := range []string{"404", "500"} {
		_, err := Import(ctx, s.URL+"/wasm"+code+".wasm")
		wantErr(t, ".wasm "+code, err, s.URL+"/wasm"+code+".wasm", code)
	}
	for _, code := range []string{"404", "410"} {
		m, err := Import(ctx, s.URL+"/wit"+code+".wasm")
		if err != nil {
			t.Fatalf(".wit %s: %v", code, err)
		}
		if got := call(t, m, "add", 3, 4); got != int32(7) || !m.raw {
			t.Errorf(".wit %s: raw add(3, 4) = %v, raw = %v; want 7, true", code, got, m.raw)
		}
		_ = m.Close()
	}
	// A query is not carried to the `.wit` (0.2.0 fetched the .wasm a second time AS the .wit).
	m, err := Import(ctx, s.URL+"/typed.wasm?v=1#frag")
	if err != nil {
		t.Fatalf("typed.wasm?v=1: %v", err)
	}
	if got := call(t, m, "add", 3, 4); got != int32(7) || m.raw {
		t.Errorf("typed.wasm?v=1: add = %v, raw = %v; want 7 typed", got, m.raw)
	}
	_ = m.Close()

	for p, want := range map[string]int{
		"/wit500.wit": 1, "/wasm404.wasm": 1, "/wasm404.wit": 1, "/wasm500.wasm": 1, "/wasm500.wit": 1,
		"/wit404.wit": 1, "/wit404.wasm": 1, "/wit410.wit": 1, "/typed.wasm": 1, "/typed.wit": 1,
	} {
		if n := s.count(p); n != want {
			t.Errorf("%s fetched %d time(s); want %d (one request per file)", p, n, want)
		}
	}
}

// Row: a server that never answers, with a short time limit → names the URL and the limit.
// Also: the zero LoadOptions is the 30 s default, a negative limit is an error, and a
// cancelled context fails the load (before any request when it is already cancelled).
func TestHTTPTimeoutAndCancel(t *testing.T) {
	release := make(chan struct{})
	hang := func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}
	s := newServer(t, map[string]func(http.ResponseWriter, *http.Request){"/hang.wit": hang, "/hang.wasm": hang})
	t.Cleanup(func() { close(release) }) // LIFO: runs before s.Close, so no handler is left blocked
	ctx := context.Background()

	// A watchdog: a loader with no limit must FAIL this test, not hang the suite.
	done := make(chan error, 1)
	go func() {
		_, err := ImportWithOptions(ctx, s.URL+"/hang.wasm", nil, LoadOptions{Timeout: 200 * time.Millisecond})
		done <- err
	}()
	var err error
	select {
	case err = <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a 200 ms limit did not end the load within 5 s: no time limit applied")
	}
	wantErr(t, "never answers", err, s.URL+"/hang.wit", "200ms", "timed out")

	_, err = ImportWithOptions(ctx, s.URL+"/hang.wasm", nil, LoadOptions{Timeout: -time.Second})
	wantErr(t, "negative limit", err, "Timeout", "-1s")
	if d, _ := (LoadOptions{}).timeout(); d != 30*time.Second {
		t.Errorf("default limit = %v; want 30s", d)
	}

	cctx, cancel := context.WithCancelCause(ctx)
	go func() { time.Sleep(150 * time.Millisecond); cancel(errors.New("caller gave up")) }()
	_, err = ImportWithOptions(cctx, s.URL+"/hang.wasm", nil, LoadOptions{Timeout: NoTimeout})
	wantErr(t, "cancelled during fetch", err, "cancelled", "caller gave up")

	before := s.count("/hang.wit")
	_, err = Import(cctx, s.URL+"/hang.wasm")
	wantErr(t, "already cancelled", err, "cancelled", "caller gave up")
	if n := s.count("/hang.wit"); n != before {
		t.Errorf("an already-cancelled load made %d request(s); want 0", n-before)
	}
}
