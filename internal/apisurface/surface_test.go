package apisurface

import (
	"bytes"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// The surface is what a consumer can depend on: the module path, the SPEC version the package
// documents, and every exported declaration with its type (parameter NAMES are not surface).
// One line per symbol, sorted, so the gate can diff it line by line.
//
//	go test ./internal/apisurface                 compare with ../../api-surface.txt
//	go test ./internal/apisurface -args -update   rewrite api-surface.txt (a re-baseline commit)
//	go test ./internal/apisurface -args -root=<dir> -out=<file>   write another tree's surface
var (
	root   = flag.String("root", filepath.Join("..", ".."), "the package directory to read")
	out    = flag.String("out", "", "write the surface here instead of comparing")
	update = flag.Bool("update", false, "rewrite <root>/api-surface.txt")
)

const snapshot = "api-surface.txt"

var specRe = regexp.MustCompile(`SPEC\.md v(\d+\.\d+\.\d+)`)
var moduleRe = regexp.MustCompile(`(?m)^module\s+(\S+)`)

func TestAPISurface(t *testing.T) {
	got, err := surface(*root)
	if err != nil {
		t.Fatal(err)
	}
	switch {
	case *out != "":
		if err := os.WriteFile(*out, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	case *update:
		if err := os.WriteFile(filepath.Join(*root, snapshot), []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(filepath.Join(*root, snapshot))
	if err != nil {
		t.Fatalf("%v (create it with: go test ./internal/apisurface -args -update)", err)
	}
	if string(want) != got {
		t.Errorf("%s is stale; the surface changed. Re-baseline in its OWN commit (Rule 5):\n"+
			"  go test ./internal/apisurface -args -update\n%s", snapshot, lineDiff(string(want), got))
	}
}

func lineDiff(a, b string) string {
	in := func(s string) map[string]bool {
		m := map[string]bool{}
		for _, l := range strings.Split(s, "\n") {
			m[l] = true
		}
		return m
	}
	ma, mb := in(a), in(b)
	var d []string
	for _, l := range strings.Split(a, "\n") {
		if !mb[l] {
			d = append(d, "- "+l)
		}
	}
	for _, l := range strings.Split(b, "\n") {
		if !ma[l] {
			d = append(d, "+ "+l)
		}
	}
	return strings.Join(d, "\n")
}

// surface reads the package in dir (non-test files only) and renders its surface.
func surface(dir string) (string, error) {
	fset := token.NewFileSet()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return "", err
	}
	var lines []string
	specs := map[string]bool{}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, parser.ParseComments)
		if err != nil {
			return "", err
		}
		if file.Doc != nil {
			for _, m := range specRe.FindAllStringSubmatch(file.Doc.Text(), -1) {
				specs[m[1]] = true
			}
		}
		for _, d := range file.Decls {
			lines = append(lines, declLines(fset, d)...)
		}
	}
	if len(specs) != 1 {
		return "", fmt.Errorf("the package doc must name exactly one \"SPEC.md vX.Y.Z\"; found %d", len(specs))
	}
	gomod, err := os.ReadFile(filepath.Join(dir, "go.mod"))
	if err != nil {
		return "", err
	}
	mod := moduleRe.FindSubmatch(gomod)
	if mod == nil {
		return "", fmt.Errorf("no module line in go.mod")
	}
	sort.Strings(lines)
	head := []string{"module: " + string(mod[1])}
	for s := range specs {
		head = append(head, "spec: "+s)
	}
	return strings.Join(append(head, lines...), "\n") + "\n", nil
}

func expr(fset *token.FileSet, e ast.Expr) string {
	var b bytes.Buffer
	_ = printer.Fprint(&b, fset, e)
	return strings.Join(strings.Fields(b.String()), " ")
}

// fields renders a parameter or result list by type only, one entry per name.
func fields(fset *token.FileSet, fl *ast.FieldList) []string {
	if fl == nil {
		return nil
	}
	var s []string
	for _, f := range fl.List {
		n := len(f.Names)
		if n == 0 {
			n = 1
		}
		for i := 0; i < n; i++ {
			s = append(s, expr(fset, f.Type))
		}
	}
	return s
}

func funcSig(fset *token.FileSet, ft *ast.FuncType) string {
	s := "(" + strings.Join(fields(fset, ft.Params), ", ") + ")"
	res := fields(fset, ft.Results)
	switch {
	case len(res) == 1:
		s += " " + res[0]
	case len(res) > 1:
		s += " (" + strings.Join(res, ", ") + ")"
	}
	return s
}

func declLines(fset *token.FileSet, d ast.Decl) []string {
	var lines []string
	switch d := d.(type) {
	case *ast.FuncDecl:
		if !d.Name.IsExported() {
			return nil
		}
		if d.Recv == nil {
			return []string{"func " + d.Name.Name + funcSig(fset, d.Type)}
		}
		recv := expr(fset, d.Recv.List[0].Type)
		if !ast.IsExported(strings.TrimLeft(recv, "*")) {
			return nil
		}
		return []string{"method (" + recv + ") " + d.Name.Name + funcSig(fset, d.Type)}
	case *ast.GenDecl:
		for _, sp := range d.Specs {
			switch sp := sp.(type) {
			case *ast.TypeSpec:
				if !sp.Name.IsExported() {
					continue
				}
				name := sp.Name.Name
				if sp.Assign.IsValid() {
					lines = append(lines, "type "+name+" = "+expr(fset, sp.Type))
					continue
				}
				switch t := sp.Type.(type) {
				case *ast.StructType:
					lines = append(lines, "type "+name+" struct")
					for _, f := range t.Fields.List {
						if len(f.Names) == 0 { // embedded
							e := expr(fset, f.Type)
							if ast.IsExported(strings.TrimLeft(e, "*")) {
								lines = append(lines, "field "+name+".(embedded) "+e)
							}
						}
						for _, n := range f.Names {
							if n.IsExported() {
								lines = append(lines, "field "+name+"."+n.Name+" "+expr(fset, f.Type))
							}
						}
					}
				case *ast.InterfaceType:
					lines = append(lines, "type "+name+" interface")
					for _, m := range t.Methods.List {
						for _, n := range m.Names {
							if ft, ok := m.Type.(*ast.FuncType); ok {
								lines = append(lines, "method "+name+"."+n.Name+funcSig(fset, ft))
							}
						}
						if len(m.Names) == 0 {
							lines = append(lines, "embed "+name+" "+expr(fset, m.Type))
						}
					}
				default:
					lines = append(lines, "type "+name+" "+expr(fset, sp.Type))
				}
			case *ast.ValueSpec:
				kind := "var"
				if d.Tok == token.CONST {
					kind = "const"
				}
				for i, n := range sp.Names {
					if !n.IsExported() {
						continue
					}
					l := kind + " " + n.Name
					if sp.Type != nil {
						l += " " + expr(fset, sp.Type)
					}
					if kind == "const" && i < len(sp.Values) {
						l += " = " + expr(fset, sp.Values[i])
					}
					lines = append(lines, l)
				}
			}
		}
	}
	return lines
}
