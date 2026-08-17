// Runtime resolution for tests: map every @deepseek-ai/* package to the
// local deepseek-harness checkout's source, so vitest exercises the harness
// code directly instead of a (partially unbuilt) vendored/package lib/.
// This mirrors the harness's own vite-tsconfig-paths setup, which the
// directory-up tsconfig discovery cannot reproduce here because dsh-ultra
// lives outside the harness tree. String aliases (not the harness's
// vite-tsconfig-paths plugin) are used because the harness tree is not an
// ancestor of these test files.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const harnessRoot = resolve(import.meta.dirname, '../deepseek-harness')

// Recursively collect every @deepseek-ai package directory under the harness.
function collectPackages(dir: string, depth: number, out: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (!entry.isDirectory()) continue
    const pkgJson = join(full, 'package.json')
    if (depth > 0 && existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name?: unknown }
      if (typeof pkg.name === 'string' && pkg.name.startsWith('@deepseek-ai/')) {
        out.set(pkg.name, full)
      }
    }
    if (depth < 3) collectPackages(full, depth + 1, out)
  }
}

const packages = new Map<string, string>()
collectPackages(harnessRoot, 0, packages)

// @deepseek-ai/<name> → <pkg>/src, keeping any subpath (e.g.
// @deepseek-ai/dsh-llm/types → <pkg>/src/types). Only packages actually
// imported at runtime are reached, so unused entries are harmless.
const alias = [...packages.entries()].map(([name, dir]) => ({
  find: name,
  replacement: `${dir}/src`,
}))

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
