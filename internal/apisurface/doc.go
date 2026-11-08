// Package apisurface holds the API-surface snapshot test of the wasmloader package (workspace
// layout-and-packaging.md § "The compatibility gate", Rule 1). It has no code of its own:
// surface_test.go reads the package source with go/ast and compares it with the committed
// api-surface.txt. scripts/compat.ts runs it with -root / -out to read an older tag's surface.
package apisurface
