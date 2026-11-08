package wasmloader

// Callbacks holds host import functions the WASM module calls into Go. Register one under
// the camelCase WIT import name (e.g. "envMul" for the WIT import `env-mul`) for EVERY WIT
// import — a missing one fails the load (SPEC 4.0.0 §4). The callback receives decoded
// native Go values (int32, int64, float32, float64, bool, string) and its return value is
// checked against the WIT result and encoded back — never coerced.
//
//	cbs := wasmloader.NewCallbacks().
//		On("envMul", func(a, b float64) float64 { return a * b }).
//		On("envAdd", func(a, b int32) int32 { return a + b })
//	m, _ := wasmloader.Load("imports.wasm", cbs)
type Callbacks struct {
	fns map[string]any
}

// NewCallbacks returns an empty Callbacks builder.
func NewCallbacks() *Callbacks {
	return &Callbacks{fns: make(map[string]any)}
}

// On registers a host callback under its camelCase WIT import name. fn must be a function
// with one parameter per WIT parameter, each of the decoded Go type (or an interface such as
// any), and — for an import with a result — exactly one result of the WIT type's kind (or
// any). The load checks the signature. On returns the receiver for chaining.
func (c *Callbacks) On(name string, fn any) *Callbacks {
	c.fns[name] = fn
	return c
}
