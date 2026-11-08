// Package wasmloader is the Go port of the Universal WASM Loader — a WIT-aware
// WebAssembly loader. It loads a `.wasm` library (the reactor/library shape that
// `wasmtk modc` produces), reads its companion `.wit` interface, and exposes each
// export as an idiomatic Go call with Canonical-ABI marshalling handled internally
// (numbers direct, strings encoded/decoded through linear memory, booleans
// normalized). When no `.wit` exists, raw exports are used.
//
// Failures are loud (SPEC 4.0.0): only an ABSENT `.wit` selects raw exports; a `.wit`
// that cannot be read or does not parse, a WIT import with no host callback, and a
// typed call with a wrong argument are errors, never a silent default.
//
// Runtime: built on pure-Go [wazero] — no CGO, no native library to ship. WASI
// Preview 1 is provided by wazero's built-in shim (SPEC §10), so I/O-using
// libraries instantiate with zero configuration; pure-compute modules need nothing.
//
// Conforms to the cross-language SPEC.md v4.0.0 (Canonical ABI, callee-allocated
// string returns + cabi_post_<name>).
//
// [wazero]: https://github.com/tetratelabs/wazero
package wasmloader

import (
	"fmt"
	"regexp"
	"strings"
)

// witType is one of the loader's supported WIT primitive types.
type witType string

const (
	typeS32    witType = "s32"
	typeS64    witType = "s64"
	typeF32    witType = "f32"
	typeF64    witType = "f64"
	typeBool   witType = "bool"
	typeString witType = "string"
)

// witTypes lists the supported types in SPEC §2's order, for error messages.
var witTypes = []witType{typeS32, typeS64, typeF32, typeF64, typeBool, typeString}

// witParam is a single function parameter: its camelCase name and WIT type.
type witParam struct {
	Name string
	Type witType
}

// witFunc is one WIT import or export. A WIT name has three forms (see SPEC / PORT_PROMPT):
// kebab-case (source), camelCase (the WASM binary export/import name — used for lookups),
// and a lang-idiomatic API name. The camelCase form is authoritative for runtime lookups.
type witFunc struct {
	Name   string // kebab-case source name (WIT identity)
	TsName string // camelCase — the actual WASM export/import symbol
	Params []witParam
	Result witType // "" means no result (void)
}

// parsedWit is the result of parsing a `.wit` source produced by wasmtk.
type parsedWit struct {
	PackageName string
	WorldName   string
	Imports     []witFunc
	Exports     []witFunc
}

// kebabToCamel converts a kebab-case WIT name to camelCase (e.g. is-positive → isPositive).
// Like the reference, only a letter or digit after a hyphen is joined.
func kebabToCamel(name string) string {
	return camelRe.ReplaceAllStringFunc(name, func(s string) string { return strings.ToUpper(s[1:]) })
}

// kebabToWasmImportKey converts a kebab-case WIT import name to the underscore WASM
// import key (e.g. env-mul → env_mul).
func kebabToWasmImportKey(name string) string {
	return strings.ReplaceAll(name, "-", "_")
}

var (
	camelRe   = regexp.MustCompile(`-[a-z0-9]`)
	identRe   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$`)
	commentRe = regexp.MustCompile(`//[^\n]*`)
	pkgRe     = regexp.MustCompile(`^package\s+([^\s;]+)\s*;`)
	worldRe   = regexp.MustCompile(`^world\s+([^\s{]+)\s*\{([^{}]*)\}$`)
	paramRe   = regexp.MustCompile(`^([^:\s]+)\s*:\s*(\S+)$`)
	funcRe    = regexp.MustCompile(`^(import|export)\s+([^\s:]+)\s*:\s*func\s*\(([^()]*)\)\s*(?:->\s*(\S+))?$`)
	spaceRe   = regexp.MustCompile(`\s+`)
)

// parseWitType maps a WIT type token to a witType. Any type outside SPEC §2's table is an
// error — never read as another type (SPEC 4.0.0; 3.0.0 read it as s32).
func parseWitType(raw, where string) (witType, error) {
	t := strings.TrimSpace(raw)
	for _, k := range witTypes {
		if string(k) == t {
			return k, nil
		}
	}
	names := make([]string, len(witTypes))
	for i, k := range witTypes {
		names[i] = string(k)
	}
	return "", fmt.Errorf("unsupported WIT type %q in %s (supported: %s)", t, where, strings.Join(names, ", "))
}

// parseWitParams parses the text between the parentheses of `func(...)`.
func parseWitParams(raw, fnLabel string) ([]witParam, error) {
	parts := strings.Split(raw, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	// A trailing comma is valid WIT: `func(a: s32,)`; so is `func()`.
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	params := make([]witParam, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		m := paramRe.FindStringSubmatch(part)
		if m == nil || !identRe.MatchString(m[1]) {
			return nil, fmt.Errorf("malformed parameter %q in %s (expected \"name: type\")", part, fnLabel)
		}
		if seen[m[1]] {
			return nil, fmt.Errorf("duplicate parameter %q in %s", m[1], fnLabel)
		}
		seen[m[1]] = true
		t, err := parseWitType(m[2], fnLabel+", parameter "+m[1])
		if err != nil {
			return nil, err
		}
		params = append(params, witParam{Name: kebabToCamel(m[1]), Type: t})
	}
	return params, nil
}

// parseWit parses a `.wit` source in the subset wasmtk produces (SPEC 4.0.0 §2 "Parsing"):
// an optional `package` line and one `world` holding only `import` / `export` function
// statements, with `//` comments. Anything else — a malformed statement or parameter, an
// unsupported type, a duplicate name, text outside the world — is an error naming it. A port
// of the reference wit-parser.js; the messages are the reference's.
func parseWit(src string) (parsedWit, error) {
	var p parsedWit
	code := commentRe.ReplaceAllString(strings.TrimPrefix(src, string(rune(0xFEFF))), "") // a UTF-8 BOM
	rest := strings.TrimSpace(code)
	if m := pkgRe.FindStringSubmatch(rest); m != nil {
		p.PackageName = m[1]
		rest = strings.TrimSpace(rest[len(m[0]):])
	}
	w := worldRe.FindStringSubmatch(rest)
	if w == nil {
		what := "it is empty"
		if rest != "" {
			found := rest
			if r := []rune(found); len(r) > 60 {
				found = string(r[:60])
			}
			what = fmt.Sprintf("expected one \"world <name> { ... }\" block, found: %s", found)
		}
		return p, fmt.Errorf("not a WIT world: %s", what)
	}
	p.WorldName = w[1]
	if !identRe.MatchString(p.WorldName) {
		return p, fmt.Errorf("malformed world name %q", p.WorldName)
	}

	statements := strings.Split(w[2], ";")
	for i := range statements {
		statements[i] = strings.TrimSpace(statements[i])
	}
	if last := statements[len(statements)-1]; last != "" {
		return p, fmt.Errorf("unterminated WIT statement (missing \";\"): %s", last)
	}
	for _, stmt := range statements[:len(statements)-1] {
		m := funcRe.FindStringSubmatch(stmt)
		if m == nil {
			return p, fmt.Errorf("unsupported or malformed WIT statement: %s", spaceRe.ReplaceAllString(stmt, " "))
		}
		keyword, name := m[1], m[2]
		fnLabel := keyword + " " + name
		if !identRe.MatchString(name) {
			return p, fmt.Errorf("malformed function name in %s", fnLabel)
		}
		list := &p.Exports
		if keyword == "import" {
			list = &p.Imports
		}
		for _, f := range *list {
			if f.Name == name {
				return p, fmt.Errorf("duplicate %s", fnLabel)
			}
		}
		params, err := parseWitParams(m[3], fnLabel)
		if err != nil {
			return p, err
		}
		var result witType
		if m[4] != "" {
			if result, err = parseWitType(m[4], fnLabel+", result"); err != nil {
				return p, err
			}
		}
		*list = append(*list, witFunc{Name: name, TsName: kebabToCamel(name), Params: params, Result: result})
	}
	return p, nil
}
