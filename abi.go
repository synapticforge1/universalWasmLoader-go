package wasmloader

import (
	"context"
	"encoding/binary"
	"fmt"
	"math"
	"reflect"
	"strings"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// --- argument domains (SPEC 4.0.0 §4 "Typed-call arguments"): checked, never coerced ---

// The Go kinds accepted for each WIT type. Integers accept every Go integer kind and are
// range-checked (an untyped constant such as 3 is an int); floats accept the floating kinds;
// bool and string accept only their own kind. A named type with that kind is accepted too.
func isIntKind(k reflect.Kind) bool {
	return k >= reflect.Int && k <= reflect.Uint64 || k == reflect.Uintptr
}

func isFloatKind(k reflect.Kind) bool { return k == reflect.Float32 || k == reflect.Float64 }

// expectedDomain describes a WIT type's accepted Go values, for error messages.
func expectedDomain(t witType) string {
	switch t {
	case typeS32:
		return "an integer in [-2147483648, 2147483647]"
	case typeS64:
		return "an integer in [-2^63, 2^63 - 1]"
	case typeF32, typeF64:
		return "a float32 or float64"
	case typeBool:
		return "a bool"
	default:
		return "a string"
	}
}

// showValue renders a value and its Go type for an error message.
func showValue(v any) string {
	if v == nil {
		return "nil"
	}
	if s, ok := v.(string); ok {
		return fmt.Sprintf("%q (string)", s)
	}
	return fmt.Sprintf("%v (%T)", v, v)
}

// checkedInt returns v as an int64 if it is a Go integer within [lo, hi]; ok is false
// otherwise (another kind, or out of range).
func checkedInt(v any, lo, hi int64) (int64, bool) {
	if v == nil {
		return 0, false
	}
	rv := reflect.ValueOf(v)
	k := rv.Kind()
	if !isIntKind(k) {
		return 0, false
	}
	if k >= reflect.Uint && k <= reflect.Uint64 || k == reflect.Uintptr {
		u := rv.Uint()
		if u > uint64(hi) {
			return 0, false
		}
		return int64(u), true
	}
	n := rv.Int()
	if n < lo || n > hi {
		return 0, false
	}
	return n, true
}

// encodeScalar encodes a non-string value of WIT type t into its one WASM value, or reports
// that v is outside t's domain (ok = false).
func encodeScalar(t witType, v any) (uint64, bool) {
	switch t {
	case typeS32:
		n, ok := checkedInt(v, math.MinInt32, math.MaxInt32)
		return api.EncodeI32(int32(n)), ok
	case typeS64:
		n, ok := checkedInt(v, math.MinInt64, math.MaxInt64)
		return api.EncodeI64(n), ok
	case typeF32, typeF64:
		if v == nil || !isFloatKind(reflect.TypeOf(v).Kind()) {
			return 0, false
		}
		f := reflect.ValueOf(v).Float()
		if t == typeF32 {
			return api.EncodeF32(float32(f)), true
		}
		return api.EncodeF64(f), true
	case typeBool:
		if v == nil || reflect.TypeOf(v).Kind() != reflect.Bool {
			return 0, false
		}
		if reflect.ValueOf(v).Bool() {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// signature renders a WIT function as `name(p: type, ...)` for error messages.
func signature(fn witFunc) string {
	ps := make([]string, len(fn.Params))
	for i, p := range fn.Params {
		ps[i] = p.Name + ": " + string(p.Type)
	}
	return fn.TsName + "(" + strings.Join(ps, ", ") + ")"
}

// --- export call path (Go -> WASM -> Go), Canonical ABI ---

// checkArgs validates a typed call's arguments against the WIT signature before anything is
// written to WASM memory (SPEC 4.0.0 §4): count, then each argument's domain.
func checkArgs(fn witFunc, args []any) error {
	if len(args) != len(fn.Params) {
		s := "s"
		if len(fn.Params) == 1 {
			s = ""
		}
		return fmt.Errorf("wasmloader: %s expects %d argument%s, got %d", signature(fn), len(fn.Params), s, len(args))
	}
	for i, p := range fn.Params {
		ok := false
		if p.Type == typeString {
			_, ok = args[i].(string)
			if !ok && args[i] != nil {
				ok = reflect.TypeOf(args[i]).Kind() == reflect.String
			}
		} else {
			_, ok = encodeScalar(p.Type, args[i])
		}
		if !ok {
			return fmt.Errorf("wasmloader: %s: parameter %s (%s) expects %s, got %s",
				signature(fn), p.Name, p.Type, expectedDomain(p.Type), showValue(args[i]))
		}
	}
	return nil
}

// encodeParam encodes one already-checked argument into its WASM value(s). A string param
// expands to two i32 values (ptr, len), allocating the bytes via cabi_realloc and writing
// them into linear memory.
func encodeParam(ctx context.Context, m *Module, t witType, v any) ([]uint64, error) {
	if t != typeString {
		w, _ := encodeScalar(t, v)
		return []uint64{w}, nil
	}
	bytes := []byte(reflect.ValueOf(v).String())
	if m.realloc == nil {
		return nil, fmt.Errorf("a string argument needs the module to export cabi_realloc, and it does not")
	}
	if m.memory == nil {
		return nil, fmt.Errorf("a string argument needs the module to export its memory, and it does not")
	}
	ptr, err := m.realloc(ctx, uint32(len(bytes)))
	if err != nil {
		return nil, err
	}
	if !m.memory.Write(ptr, bytes) {
		return nil, fmt.Errorf("string param write out of bounds (ptr=%d len=%d)", ptr, len(bytes))
	}
	return []uint64{api.EncodeI32(int32(ptr)), api.EncodeI32(int32(len(bytes)))}, nil
}

// decodeResult turns a WASM export's raw return into a native Go value per the function's
// result type. A string result follows the Canonical ABI callee-allocated convention: the
// export returns an i32 pointer to a callee-allocated [ptr, len] pair; we read it, decode,
// then call the paired cabi_post_<name> export to release the buffer (no-op under a bump
// allocator, but part of the contract — decoding copies the bytes, so the string survives).
func (m *Module) decodeResult(ctx context.Context, fn witFunc, raw []uint64) (any, error) {
	if fn.Result == "" {
		return nil, nil
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("export %q returned no value but WIT declares result %q", fn.TsName, fn.Result)
	}
	switch fn.Result {
	case typeS32:
		return api.DecodeI32(raw[0]), nil
	case typeS64:
		return int64(raw[0]), nil
	case typeF32:
		return api.DecodeF32(raw[0]), nil
	case typeF64:
		return api.DecodeF64(raw[0]), nil
	case typeBool:
		// bool is an i32 0/1 — mask to the low 32 bits (an f64-producing body can leave
		// high-bit garbage in the result register, which a raw 64-bit != 0 would misread).
		return uint32(raw[0]) != 0, nil
	default: // string; the parser admits no other type
		if m.memory == nil {
			return nil, fmt.Errorf("a string result needs the module to export its memory, and it does not")
		}
		retArea := uint32(raw[0])
		hdr, ok := m.memory.Read(retArea, 8)
		if !ok {
			return nil, fmt.Errorf("string return header read out of bounds (retArea=%d)", retArea)
		}
		strPtr := binary.LittleEndian.Uint32(hdr[0:4])
		strLen := binary.LittleEndian.Uint32(hdr[4:8])
		body, ok := m.memory.Read(strPtr, strLen)
		if !ok {
			return nil, fmt.Errorf("string return body read out of bounds (ptr=%d len=%d)", strPtr, strLen)
		}
		s := string(body) // copies the bytes — safe across cabi_post
		if post := m.mod.ExportedFunction("cabi_post_" + fn.TsName); post != nil {
			if _, err := post.Call(ctx, uint64(retArea)); err != nil {
				return nil, fmt.Errorf("cabi_post_%s failed: %w", fn.TsName, err)
			}
		}
		return s, nil
	}
}

// --- import side (WASM -> Go -> WASM): build the "env" host module ---

// goTypeOf is the Go type a WIT value is decoded to for a host callback's parameter.
func goTypeOf(t witType) reflect.Type {
	switch t {
	case typeS32:
		return reflect.TypeOf(int32(0))
	case typeS64:
		return reflect.TypeOf(int64(0))
	case typeF32:
		return reflect.TypeOf(float32(0))
	case typeF64:
		return reflect.TypeOf(float64(0))
	case typeBool:
		return reflect.TypeOf(false)
	default:
		return reflect.TypeOf("")
	}
}

// resultKindFits reports whether a callback's declared result type can carry WIT result t
// without coercion: the same kind family (checked again by value when it is called), or an
// interface (checked only by value).
func resultKindFits(t witType, rt reflect.Type) bool {
	k := rt.Kind()
	switch {
	case k == reflect.Interface:
		return true
	case t == typeS32 || t == typeS64:
		return isIntKind(k)
	case t == typeF32 || t == typeF64:
		return isFloatKind(k)
	default:
		return t == typeBool && k == reflect.Bool
	}
}

// checkCallbacks validates the host callbacks against the WIT imports before the `.wasm` is
// read (SPEC 4.0.0 §4): every import needs one (all missing ones named at once), an import
// returning a string is refused, and each callback's static signature must fit its import —
// one parameter per WIT parameter, each of the decoded Go type (or an interface it
// satisfies), and for an import with a result exactly one result of a fitting kind.
func checkCallbacks(imports []witFunc, cbs *Callbacks) error {
	var missing, stringResult []string
	for _, imp := range imports {
		label := fmt.Sprintf("%s (WIT %q)", imp.TsName, imp.Name)
		if cbs == nil || cbs.fns[imp.TsName] == nil {
			missing = append(missing, label)
		}
		if imp.Result == typeString {
			stringResult = append(stringResult, label)
		}
	}
	if len(missing) > 0 {
		s := ""
		if len(missing) > 1 {
			s = "s"
		}
		return fmt.Errorf("wasmloader: no host callback for WIT import%s: %s", s, strings.Join(missing, ", "))
	}
	if len(stringResult) > 0 {
		return fmt.Errorf("wasmloader: a WIT import returning a string is not supported: %s", strings.Join(stringResult, ", "))
	}
	for _, imp := range imports {
		ft := reflect.TypeOf(cbs.fns[imp.TsName])
		label := fmt.Sprintf("host callback %s (WIT import %q: %s)", imp.TsName, imp.Name, witSignature(imp))
		if ft.Kind() != reflect.Func {
			return fmt.Errorf("wasmloader: %s is a %s, not a function", label, ft)
		}
		if ft.IsVariadic() || ft.NumIn() != len(imp.Params) {
			return fmt.Errorf("wasmloader: %s has signature %s; it must take exactly %d parameter(s)", label, ft, len(imp.Params))
		}
		for i, p := range imp.Params {
			want := goTypeOf(p.Type)
			in := ft.In(i)
			if !(in.Kind() == want.Kind() && want.ConvertibleTo(in)) && !(in.Kind() == reflect.Interface && want.Implements(in)) {
				return fmt.Errorf("wasmloader: %s: parameter %d (%s: %s) must be a %s, not %s", label, i+1, p.Name, p.Type, want, in)
			}
		}
		if imp.Result == "" {
			continue // a void import ignores whatever the callback returns
		}
		if ft.NumOut() != 1 {
			return fmt.Errorf("wasmloader: %s has signature %s; it must return exactly one %s", label, ft, imp.Result)
		}
		if out := ft.Out(0); !resultKindFits(imp.Result, out) {
			return fmt.Errorf("wasmloader: %s returns %s; expected %s", label, out, expectedDomain(imp.Result))
		}
	}
	return nil
}

// witSignature renders a WIT import as `func(p: type, ...) -> result`.
func witSignature(fn witFunc) string {
	ps := make([]string, len(fn.Params))
	for i, p := range fn.Params {
		ps[i] = p.Name + ": " + string(p.Type)
	}
	s := "func(" + strings.Join(ps, ", ") + ")"
	if fn.Result != "" {
		s += " -> " + string(fn.Result)
	}
	return s
}

// registerEnvImports instantiates a wazero host module named "env" satisfying each WIT
// import, dispatching to the user's registered callback (already checked by checkCallbacks).
// Memory for string-param imports is read from the calling module's memory at call time.
func registerEnvImports(ctx context.Context, r wazero.Runtime, imports []witFunc, cbs *Callbacks) error {
	hb := r.NewHostModuleBuilder("env")
	for _, imp := range imports {
		var resultTypes []api.ValueType
		if imp.Result != "" {
			resultTypes = []api.ValueType{resultValueType(imp.Result)}
		}
		hb.NewFunctionBuilder().
			WithGoModuleFunction(api.GoModuleFunc(makeHostFunc(imp, cbs.fns[imp.TsName])), flattenParamValueTypes(imp.Params), resultTypes).
			Export(kebabToWasmImportKey(imp.Name))
	}
	_, err := hb.Instantiate(ctx)
	return err
}

// makeHostFunc builds the wazero host-function body for one WIT import. It decodes the raw
// stack per the import's params, calls the user callback, checks its return value against the
// WIT result (SPEC 4.0.0 §4: never coerced) and writes the encoded result to stack[0]. A bad
// value panics with an error, which wazero turns into the error of the export call that
// reached the import.
func makeHostFunc(imp witFunc, cb any) func(context.Context, api.Module, []uint64) {
	fnVal := reflect.ValueOf(cb)
	ft := fnVal.Type()
	label := fmt.Sprintf("host callback %s (WIT import %q -> %s)", imp.TsName, imp.Name, imp.Result)
	return func(ctx context.Context, mod api.Module, stack []uint64) {
		in := make([]reflect.Value, 0, len(imp.Params))
		si := 0
		for i, p := range imp.Params {
			var v any
			switch p.Type {
			case typeString:
				ptr, ln := uint32(stack[si]), uint32(stack[si+1])
				si += 2
				mem := mod.Memory()
				if mem == nil {
					panic(fmt.Errorf("wasmloader: import %q received a string but the module exports no memory", imp.Name))
				}
				b, ok := mem.Read(ptr, ln)
				if !ok {
					panic(fmt.Errorf("wasmloader: import %q: string argument out of bounds (ptr=%d len=%d)", imp.Name, ptr, ln))
				}
				v = string(b)
			case typeBool:
				v = uint32(stack[si]) != 0
				si++
			case typeF32:
				v = api.DecodeF32(stack[si])
				si++
			case typeF64:
				v = api.DecodeF64(stack[si])
				si++
			case typeS64:
				v = int64(stack[si])
				si++
			default: // s32
				v = api.DecodeI32(stack[si])
				si++
			}
			av := reflect.ValueOf(v)
			if t := ft.In(i); t.Kind() != reflect.Interface {
				av = av.Convert(t) // same kind (checked at load): a named type only
			}
			in = append(in, av)
		}
		out := fnVal.Call(in)
		if imp.Result == "" {
			return
		}
		ret := out[0].Interface()
		if out[0].Kind() == reflect.Interface && out[0].IsNil() {
			ret = nil
		}
		if ret != nil && reflect.TypeOf(ret).Kind() == reflect.Chan {
			panic(fmt.Errorf("wasmloader: %s returned a channel; host callbacks must return their value synchronously (WASM cannot wait)", label))
		}
		w, ok := encodeScalar(imp.Result, ret)
		if !ok {
			panic(fmt.Errorf("wasmloader: %s returned %s; expected %s", label, showValue(ret), expectedDomain(imp.Result)))
		}
		stack[0] = w
	}
}

// flattenParamValueTypes maps WIT params to wazero value types, expanding each string to
// two i32 values (ptr, len).
func flattenParamValueTypes(params []witParam) []api.ValueType {
	types := make([]api.ValueType, 0, len(params))
	for _, p := range params {
		switch p.Type {
		case typeString:
			types = append(types, api.ValueTypeI32, api.ValueTypeI32)
		case typeF32:
			types = append(types, api.ValueTypeF32)
		case typeF64:
			types = append(types, api.ValueTypeF64)
		case typeS64:
			types = append(types, api.ValueTypeI64)
		default: // s32, bool
			types = append(types, api.ValueTypeI32)
		}
	}
	return types
}

func resultValueType(t witType) api.ValueType {
	switch t {
	case typeF32:
		return api.ValueTypeF32
	case typeF64:
		return api.ValueTypeF64
	case typeS64:
		return api.ValueTypeI64
	default: // s32, bool (a string result is refused at load)
		return api.ValueTypeI32
	}
}

// --- raw exports (no `.wit`): encoded by the export's own WASM signature ---

// encodeRaw encodes a raw-call argument for a WASM value type: an integer kind (range-checked)
// or a bool for i32 / i64, a floating kind for f32 / f64. Raw exports are outside SPEC §4's
// typed-call rule, but a value is still never reinterpreted.
func encodeRaw(vt api.ValueType, v any) (uint64, bool) {
	if v != nil && reflect.TypeOf(v).Kind() == reflect.Bool && (vt == api.ValueTypeI32 || vt == api.ValueTypeI64) {
		if reflect.ValueOf(v).Bool() {
			return 1, true
		}
		return 0, true
	}
	switch vt {
	case api.ValueTypeI32:
		// i32 has no sign: accept [-2^31, 2^32 - 1] so an unsigned bit pattern passes too.
		n, ok := checkedInt(v, math.MinInt32, math.MaxUint32)
		return uint64(uint32(n)), ok
	case api.ValueTypeI64:
		if n, ok := checkedInt(v, math.MinInt64, math.MaxInt64); ok {
			return uint64(n), true
		}
		if v != nil && reflect.TypeOf(v).Kind() == reflect.Uint64 {
			return reflect.ValueOf(v).Uint(), true
		}
		return 0, false
	case api.ValueTypeF32:
		if v == nil || !isFloatKind(reflect.TypeOf(v).Kind()) {
			return 0, false
		}
		return api.EncodeF32(float32(reflect.ValueOf(v).Float())), true
	case api.ValueTypeF64:
		if v == nil || !isFloatKind(reflect.TypeOf(v).Kind()) {
			return 0, false
		}
		return api.EncodeF64(reflect.ValueOf(v).Float()), true
	}
	return 0, false
}

// decodeRaw decodes a raw WASM result by its value type: i32 → int32, i64 → int64,
// f32 → float32, f64 → float64 (never the bit pattern).
func decodeRaw(vt api.ValueType, w uint64) any {
	switch vt {
	case api.ValueTypeI32:
		return api.DecodeI32(w)
	case api.ValueTypeI64:
		return int64(w)
	case api.ValueTypeF32:
		return api.DecodeF32(w)
	case api.ValueTypeF64:
		return api.DecodeF64(w)
	}
	return w // externref / funcref / v128 low half: the engine's value as it is
}
