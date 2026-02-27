# Ruby Language Support for GitNexus

**Date:** 2026-02-26
**Status:** Brainstorm
**Author:** Candido + Claude

## What We're Building

Adding Ruby as a fully supported language in GitNexus, covering both the CLI (`gitnexus/`) and the web version (`gitnexus-web/`). This brings GitNexus to 10 supported languages.

Ruby support will include:
- **Definitions:** `class`, `module`, `method`, `singleton_method` (def self.foo)
- **Imports:** `require` and `require_relative` with path resolution
- **Calls:** method calls, function calls (simple and receiver-based)
- **Heritage:** class inheritance (`<`), `include`/`extend`/`prepend` as mixin relationships
- **Properties:** `attr_accessor`, `attr_reader`, `attr_writer` as property definitions
- **Visibility:** public by default (matching Python's convention; `private`/`protected` detection deferred)
- **File types:** `.rb`, `.rake`, `.gemspec`, plus extensionless files (`Rakefile`, `Gemfile`, `Guardfile`)

## Why This Approach

We chose **Approach A (Minimal Viable)** over two alternatives:

| Approach | What it adds | Why not |
|----------|-------------|---------|
| **A: Minimal Viable** (chosen) | Covers 90%+ of Ruby code. Matches existing language patterns exactly. | — |
| B: Enhanced Metaprogramming | `define_method`, `send`/`public_send`, `scope`/`delegate` | Higher complexity, more false positives, harder to test. Can be added later. |
| C: Core Only | Bare minimum, no `include`/`extend`, no `attr_*` | Misses mixin relationships which are fundamental to Ruby. |

**Rationale:** Approach A mirrors how every other language is implemented in the codebase. It keeps the diff predictable, reviewable, and maintainable. Ruby's dynamic features (`method_missing`, `define_method`, `send`) are already partially handled by the fuzzy-global call resolution strategy (confidence 0.3-0.5), so the graph won't be blind to dynamic dispatch — it just won't explicitly model it.

## Key Decisions

1. **Scope: Ruby only, no Rails** — Rails-specific intelligence (ActiveRecord associations, route detection, controller patterns) is deferred to a follow-up effort. Pure Ruby is the deliverable.

2. **File types: All Ruby files** — Beyond `.rb`, include `.rake`, `.gemspec`, and extensionless files like `Rakefile`, `Gemfile`, `Guardfile`. Extensionless files need special handling in `getLanguageFromFilename()`.

3. **Metaprogramming: Track as relationships** — `include`/`extend`/`prepend` captured as heritage/mixin relationships. `attr_accessor`/`attr_reader`/`attr_writer` captured as property definitions. This gives the richest graph without overreaching.

4. **Both CLI and web** — Ruby support ships in both `gitnexus/` and `gitnexus-web/` simultaneously. The web version uses WASM tree-sitter bindings (`web-tree-sitter`) vs native bindings — grammar loading differs but queries are shared.

5. **No tree-sitter predicates** — The existing codebase does not use `#eq?` predicates in tree-sitter queries. Ruby import/mixin detection will filter in JavaScript post-processing, matching the established pattern.

6. **Visibility: Default public** — All methods treated as exported, matching Python's convention. Walking sibling nodes for `private`/`protected` toggles is a future enhancement, not v1.

## Scope of Changes

The codebase has no plugin architecture — each language is wired into multiple files. Ruby support requires changes across ~18 files:

### Core Configuration (2 files)
- `gitnexus/src/config/supported-languages.ts` — Uncomment `Ruby = 'ruby'` (already anticipated)
- `gitnexus-web/src/config/supported-languages.ts` — Same change

### Dependencies (1-2 files)
- `gitnexus/package.json` — Add `tree-sitter-ruby`
- `gitnexus-web/package.json` — Add `web-tree-sitter` Ruby WASM grammar

### File Extension Mapping (1-2 files)
- `gitnexus/src/core/ingestion/utils.ts` — Add `.rb`, `.rake`, `.gemspec`, extensionless file mappings
- `gitnexus-web/` equivalent if it has its own copy

### Tree-Sitter Grammar Loader (2-3 files)
- `gitnexus/src/core/tree-sitter/parser-loader.ts` — Import and register grammar
- `gitnexus/src/core/ingestion/workers/parse-worker.ts` — Duplicate registration (worker has its own copy)
- `gitnexus-web/` equivalent

### Tree-Sitter Queries (1-2 files) — **Largest effort**
- `gitnexus/src/core/ingestion/tree-sitter-queries.ts` — Write `RUBY_QUERIES`
- `gitnexus-web/` equivalent if separate

### Export Detection (2 files)
- `gitnexus/src/core/ingestion/parsing-processor.ts` — Add `case 'ruby'` to `isNodeExported`
- `gitnexus/src/core/ingestion/workers/parse-worker.ts` — Same in worker copy

### Import Resolution (1 file)
- `gitnexus/src/core/ingestion/import-processor.ts` — Add `.rb` to EXTENSIONS, add `require_relative` resolution

### Call Processing (2 files)
- `gitnexus/src/core/ingestion/call-processor.ts` — Add Ruby built-ins to noise filter, add `method` to FUNCTION_NODE_TYPES
- `gitnexus/src/core/ingestion/workers/parse-worker.ts` — Same in worker copy

### Framework & Entry Points (2 files)
- `gitnexus/src/core/ingestion/framework-detection.ts` — Basic Ruby project detection (not Rails-specific)
- `gitnexus/src/core/ingestion/entry-point-scoring.ts` — Ruby entry point patterns, test file patterns

### Documentation (1 file)
- `gitnexus/README.md` — Update supported languages list

## Ruby Tree-Sitter Query Template

```scheme
; ---- Classes ----
(class
  name: (constant) @name) @definition.class

; ---- Modules ----
(module
  name: (constant) @name) @definition.module

; ---- Methods (instance) ----
(method
  name: (identifier) @name) @definition.method

; ---- Singleton methods (def self.foo) ----
(singleton_method
  name: (identifier) @name) @definition.method

; ---- Imports (captured as calls, filtered in JS) ----
(call
  method: (identifier) @call.name
  arguments: (argument_list
    (string (string_content) @import.source))) @import

; ---- Calls ----
(call
  method: (identifier) @call.name) @call

; ---- Heritage: class inheritance ----
(class
  name: (constant) @heritage.class
  superclass: (superclass (constant) @heritage.extends)) @heritage

; ---- Heritage: mixins (include/extend/prepend, filtered in JS) ----
(call
  method: (identifier) @call.name
  arguments: (argument_list (constant) @heritage.trait)) @heritage
```

Note: Import, mixin, and call queries will produce overlapping matches for the same AST nodes. This is expected — the existing pipeline already handles multiple captures per node. The JavaScript post-processing layer classifies by checking `call.name`: `require`/`require_relative` → import, `include`/`extend`/`prepend` → heritage, everything else → call. The final query structure will be validated against `tree-sitter-ruby`'s actual AST during implementation.

## Ruby Built-ins to Filter

These should be added to the `BUILT_IN_NAMES` / `BUILT_INS` sets to reduce noise:

```
puts, print, p, pp, warn, raise, fail, require, require_relative,
attr_accessor, attr_reader, attr_writer, include, extend, prepend,
freeze, dup, clone, nil?, is_a?, kind_of?, respond_to?, send,
public_send, class, superclass, ancestors, new, initialize,
to_s, to_i, to_f, to_a, to_h, inspect, hash, equal?, eql?,
lambda, proc, block_given?, yield, catch, throw, loop,
sleep, exit, abort, at_exit, trap
```

## Resolved Questions

1. **Extensionless file detection strategy:** Use a hardcoded list of known Ruby filenames (`Rakefile`, `Gemfile`, `Guardfile`, `Vagrantfile`, `Brewfile`, `Capfile`, `Thorfile`, `Berksfile`). This is simple, fast, and matches the existing pure-filename-based pattern in `getLanguageFromFilename()`.

2. **Web WASM grammar availability:** Needs investigation during planning phase. Will determine whether `gitnexus-web` uses pre-built WASM grammars or compiles them. This is a planning concern, not a design decision.

## Out of Scope

- Rails framework detection and intelligence (ActiveRecord, routes, controllers)
- Dynamic metaprogramming (`define_method`, `method_missing`, `class_eval`)
- RBS/Sorbet type annotation parsing
- Bundler/Gemfile dependency graph analysis
- ERB/HAML template parsing
