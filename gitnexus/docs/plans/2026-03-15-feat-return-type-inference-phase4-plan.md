---
title: "feat: Phase 4 — Complete Return Type Inference for All Languages"
type: feat
status: active
date: 2026-03-15
---

# Phase 4: Complete Return Type Inference for All Languages

## Overview

Phase 3 established the return type inference pipeline: when a function call result is assigned to a variable (`val user = getUser()`), and the called function has a known return type in the SymbolTable, subsequent member calls on that variable (`user.save()`) resolve to the return type's methods. This works via `CONSTRUCTOR_BINDING_SCANNERS` in `type-env.ts` which capture `var = callee()` assignments, and `processCallsFromExtracted` in `call-processor.ts` which looks up the callee's return type.

**Problem:** Only 5 of 12 languages have scanners (Kotlin, Python, Swift, C++, Ruby). The remaining 7 languages (TypeScript/JS, Go, Java, C#, Rust, PHP) can only resolve member calls when variables have explicit type annotations — they miss the common `var x = func()` pattern.

## Problem Statement

Without scanners, this code produces no CALLS edge for `user.save()`:

```typescript
// TypeScript — no scanner, so `user` type is unknown
const user = getUser("alice");  // ← not captured
user.save();                    // ← unresolved
```

But this works because extractDeclaration handles explicit types:
```typescript
const user: User = getUser("alice");  // ← extractDeclaration captures User
user.save();                          // ← resolves to User#save
```

## Proposed Solution

Add `CONSTRUCTOR_BINDING_SCANNERS` for all missing languages. Each scanner captures `var = callee()` patterns where the variable has no explicit type annotation, emitting a `{ varName, calleeName }` binding that `processCallsFromExtracted` resolves via the SymbolTable.

## Technical Approach

### Architecture

The pipeline is already built — we just need per-language AST pattern matchers:

```
AST walk (type-env.ts buildTypeEnv)
  ↓ scanner(node) → { varName, calleeName }
  ↓ collected in constructorBindings[]
  ↓ passed to processCallsFromExtracted
  ↓ ctx.resolve(calleeName) → SymbolDefinition
  ↓ if Class → bind varName to calleeName
  ↓ if Function/Method with returnType → extractReturnTypeName → bind varName to return type
  ↓ receiverMap[varName] = typeName
  ↓ resolveCallTarget uses receiverTypeName for member calls
```

### Phase 4.1: TypeScript/JavaScript Scanner

**AST pattern:** `lexical_declaration` → `variable_declarator` with no type_annotation and call_expression value

```typescript
// const user = getUser("alice")
// AST: lexical_declaration > variable_declarator[name=identifier, value=call_expression]
[SupportedLanguages.TypeScript]: (node) => {
  if (node.type !== 'variable_declarator') return undefined;
  // Skip if parent is not a lexical/variable declaration
  const parent = node.parent;
  if (!parent || (parent.type !== 'lexical_declaration' && parent.type !== 'variable_declaration')) return undefined;
  // Skip if has type annotation
  if (node.childForFieldName('type')) return undefined;
  for (const child of node.children) {
    if (child.type === 'type_annotation') return undefined;
  }
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  const value = node.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
},
// JavaScript shares the same config
[SupportedLanguages.JavaScript]: /* same as TypeScript */
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add to CONSTRUCTOR_BINDING_SCANNERS
- `test/unit/type-env.test.ts` — unit tests for the scanner
- `test/integration/resolvers/typescript.test.ts` — update existing return type tests

**Node types to handle:**
- `variable_declarator` inside `lexical_declaration` (const/let)
- `variable_declarator` inside `variable_declaration` (var)
- Must skip destructuring patterns (`array_pattern`, `object_pattern`)

### Phase 4.2: Go Scanner

**AST pattern:** `short_var_declaration` → left identifier, right call_expression

```go
// user := GetUser("alice")
// AST: short_var_declaration[left=expression_list>identifier, right=expression_list>call_expression]
[SupportedLanguages.Go]: (node) => {
  if (node.type !== 'short_var_declaration') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  // Single assignment only (skip multi-assign like `a, b := ...`)
  const leftIds = left.namedChildren.filter(c => c.type === 'identifier');
  if (leftIds.length !== 1) return undefined;
  // Right must be a single call_expression
  const rightExprs = right.namedChildren;
  if (rightExprs.length !== 1 || rightExprs[0].type !== 'call_expression') return undefined;
  const func = rightExprs[0].childForFieldName('function');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: leftIds[0].text, calleeName };
},
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add Go scanner
- `test/integration/resolvers/go.test.ts` — update return type tests

**Edge cases:**
- Multi-return: `user, err := GetUser()` — skip (multiple left identifiers)
- Composite literal: `user := User{Name: "alice"}` — already handled by extractInitializer
- Selector call: `user := models.GetUser()` — extractSimpleTypeName handles `selector_expression`

### Phase 4.3: Java Scanner

**AST pattern:** `local_variable_declaration` with `var` type → `variable_declarator` with call value

```java
// var user = getUser("alice");
// AST: local_variable_declaration[type=void_type("var"), declarator=variable_declarator[value=method_invocation]]
[SupportedLanguages.Java]: (node) => {
  if (node.type !== 'local_variable_declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  // Only handle `var` — explicitly typed declarations are handled by extractDeclaration
  if (typeNode.text !== 'var') return undefined;
  const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName('name');
  const value = declarator.childForFieldName('value');
  if (!nameNode || !value) return undefined;
  if (value.type !== 'method_invocation') return undefined;
  const methodName = value.childForFieldName('name');
  if (!methodName) return undefined;
  // For qualified calls (obj.getUser()), take the method name
  // For unqualified calls (getUser()), take the function name
  const calleeName = methodName.text;
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
},
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add Java scanner
- `test/integration/resolvers/java.test.ts` — update return type tests

**Edge cases:**
- Java 10+ `var` only — pre-10 declarations always have explicit types
- `var list = List.of(...)` — method_invocation with object reference
- `var user = new User()` — object_creation_expression (already handled by extractInitializer)

### Phase 4.4: C# Scanner

**AST pattern:** `local_declaration_statement` → `variable_declaration` with `implicit_type` (var)

```csharp
// var user = GetUser("alice");
// AST: local_declaration_statement > variable_declaration[type=implicit_type, declarator=variable_declarator[value=invocation_expression]]
[SupportedLanguages.CSharp]: (node) => {
  if (node.type !== 'variable_declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode || typeNode.type !== 'implicit_type') return undefined;
  const declarator = node.namedChildren.find(c => c.type === 'variable_declarator');
  if (!declarator) return undefined;
  const nameNode = declarator.childForFieldName('name') ?? declarator.firstNamedChild;
  if (!nameNode) return undefined;
  const eqClause = declarator.namedChildren.find(c => c.type === 'equals_value_clause');
  if (!eqClause) return undefined;
  const value = eqClause.firstNamedChild;
  if (!value || value.type !== 'invocation_expression') return undefined;
  const func = value.firstNamedChild;
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
},
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add C# scanner
- `test/integration/resolvers/csharp.test.ts` — add return type tests

### Phase 4.5: Rust Scanner

**AST pattern:** `let_declaration` with no type annotation and call_expression value

```rust
// let user = get_user("alice");
// AST: let_declaration[pattern=identifier, value=call_expression]
[SupportedLanguages.Rust]: (node) => {
  if (node.type !== 'let_declaration') return undefined;
  // Skip if has type annotation
  if (node.childForFieldName('type')) return undefined;
  for (const child of node.children) {
    if (child.type === 'type_annotation') return undefined;
  }
  const pattern = node.childForFieldName('pattern');
  if (!pattern || pattern.type !== 'identifier') return undefined;
  const value = node.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: pattern.text, calleeName };
},
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add Rust scanner
- `test/integration/resolvers/rust.test.ts` — add return type tests

### Phase 4.6: PHP Scanner

**AST pattern:** `expression_statement` → `assignment_expression` with function call

```php
// $user = getUser("alice");
// AST: expression_statement > assignment_expression[left=variable_name, right=function_call_expression]
[SupportedLanguages.PHP]: (node) => {
  if (node.type !== 'assignment_expression') return undefined;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return undefined;
  if (left.type !== 'variable_name') return undefined;
  if (right.type !== 'function_call_expression' && right.type !== 'member_call_expression') return undefined;
  const func = right.childForFieldName('function') ?? right.childForFieldName('name');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  // Strip leading $ from PHP variable names
  const varName = left.text.startsWith('$') ? left.text.slice(1) : left.text;
  return { varName, calleeName };
},
```

**Key files:**
- `src/core/ingestion/type-env.ts:424` — add PHP scanner
- `test/integration/resolvers/php.test.ts` — add return type tests (if exists)

### Phase 4.7: Ruby YARD @return Annotation

**Current gap:** Ruby's `extractMethodSignature` in `utils.ts:531-650` doesn't check YARD doc comments for `@return [Type]`. Python has a similar gap with `:rtype:` but Python type hints are more common.

**Approach:** Add a per-language `extractReturnTypeFromComment` hook called from `extractMethodSignature` when no AST return type is found.

```ruby
# @return [User] the found user
def get_user(name)
  User.find_by(name: name)
end
```

**Implementation:**
1. After the existing return type extraction in `extractMethodSignature` (line ~640), if `returnType` is still undefined, check preceding sibling comment nodes
2. Parse `@return [Type]` (Ruby YARD) and `:rtype: Type` (Python docstring in comment form)
3. This is a cross-cutting concern — add a `RETURN_TYPE_COMMENT_PATTERNS` map in `type-env.ts` keyed by language

**Key files:**
- `src/core/ingestion/utils.ts:531-650` — add comment-based return type extraction
- `src/core/ingestion/type-env.ts` — add RETURN_TYPE_COMMENT_PATTERNS

**Pattern per language:**
- Ruby YARD: `# @return [User]` or `# @return [Array<User>]`
- Python: `""":rtype: User"""` (in docstring) — may need special AST handling
- JSDoc: `/** @returns {User} */` — already works via TS type annotations mostly

## Acceptance Criteria

- [ ] TypeScript/JavaScript: `const user = getUser()` → `user.save()` resolves via return type
- [ ] Go: `user := GetUser()` → `user.Save()` resolves via return type
- [ ] Java: `var user = getUser()` → `user.save()` resolves via return type
- [ ] C#: `var user = GetUser()` → `user.Save()` resolves via return type
- [ ] Rust: `let user = get_user()` → `user.save()` resolves via return type
- [ ] PHP: `$user = getUser()` → `$user->save()` resolves via return type
- [ ] Ruby YARD: `@return [User]` populates returnType in SymbolDefinition
- [ ] All existing tests continue to pass (no regressions)
- [ ] Integration tests for each new scanner
- [ ] Unit tests for each scanner's AST pattern matching

## Dependencies & Risks

**Dependencies:**
- Phase 3 changes must be committed first (WRAPPER_GENERICS fix, Ruby `::` handling)
- `extractSimpleTypeName` in `shared.ts` must handle each language's AST node types

**Risks:**
- **Low:** Scanner false positives — a function call assigned to a variable where the function has no return type is harmless (no binding created)
- **Medium:** Go multi-return — `user, err := GetUser()` must be skipped (handled by leftIds.length check)
- **Medium:** PHP variable name collision — `$user` in different scopes could collide (scope-aware keying already handles this)
- **Low:** YARD parsing — regex on comment text is fragile but good enough for the common `@return [Type]` pattern

## Implementation Order

Recommended order (easiest → hardest, most impactful first):

1. **TypeScript/JavaScript** — largest user base, simplest AST pattern
2. **Go** — common `:=` pattern, straightforward
3. **Java** — `var` keyword, well-defined AST
4. **C#** — `var` keyword, similar to Java
5. **Rust** — `let` without annotation, clean AST
6. **PHP** — `$var = func()`, needs `$` stripping
7. **Ruby YARD** — different mechanism (comment parsing, not scanner)

## Sources

- `src/core/ingestion/type-env.ts:424-512` — existing CONSTRUCTOR_BINDING_SCANNERS
- `src/core/ingestion/call-processor.ts:462-485` — return type inference in processCallsFromExtracted
- `src/core/ingestion/call-processor.ts:381-425` — extractReturnTypeName
- `src/core/ingestion/utils.ts:531-650` — extractMethodSignature
- `src/core/ingestion/type-extractors/types.ts` — LanguageTypeConfig interface
- Phase 3 plan: `docs/plans/2026-03-14-feat-type-resolution-gap-closure-plan.md`
