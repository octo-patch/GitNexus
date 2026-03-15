import type { SyntaxNode } from './utils.js';
import { FUNCTION_NODE_TYPES, extractFunctionName, CLASS_CONTAINER_TYPES } from './utils.js';
import { SupportedLanguages } from '../../config/supported-languages.js';
import { typeConfigs, TYPED_PARAMETER_TYPES } from './type-extractors/index.js';
import type { ClassNameLookup } from './type-extractors/types.js';
import { extractSimpleTypeName, extractRubyConstructorAssignment } from './type-extractors/shared.js';
import type { SymbolTable } from './symbol-table.js';

/**
 * Per-file scoped type environment: maps (scope, variableName) → typeName.
 * Scope-aware: variables inside functions are keyed by function name,
 * file-level variables use the '' (empty string) scope.
 *
 * Design constraints:
 * - Explicit-only: only type annotations, never inferred types
 * - Scope-aware: function-local variables don't collide across functions
 * - Conservative: complex/generic types extract the base name only
 * - Per-file: built once, used for receiver resolution, then discarded
 */
export type TypeEnv = Map<string, Map<string, string>>;

/** File-level scope key */
const FILE_SCOPE = '';

/** Fallback for languages where class names aren't in a 'name' field (e.g. Kotlin uses type_identifier). */
const findTypeIdentifierChild = (node: SyntaxNode): SyntaxNode | null => {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'type_identifier') return child;
  }
  return null;
};

/**
 * Per-file type environment with receiver resolution.
 * Built once per file via `buildTypeEnv`, used for receiver-type filtering,
 * then discarded. Encapsulates scope-aware type lookup and self/this/super
 * AST resolution behind a single `.lookup()` method.
 */
export interface TypeEnvironment {
  /** Look up a variable's resolved type, with self/this/super AST resolution. */
  lookup(varName: string, callNode: SyntaxNode): string | undefined;
  /** Unverified cross-file constructor bindings for SymbolTable verification. */
  readonly constructorBindings: readonly ConstructorBinding[];
  /** Raw per-scope type bindings — for testing and debugging. */
  readonly env: TypeEnv;
}

/** Implementation of the lookup logic — shared between TypeEnvironment and the legacy export. */
const lookupInEnv = (
  env: TypeEnv,
  varName: string,
  callNode: SyntaxNode,
): string | undefined => {
  // Self/this receiver: resolve to enclosing class name via AST walk
  if (varName === 'self' || varName === 'this' || varName === '$this') {
    return findEnclosingClassName(callNode);
  }

  // Super/base/parent receiver: resolve to the parent class name via AST walk.
  // Walks up to the enclosing class, then extracts the superclass from its heritage node.
  if (varName === 'super' || varName === 'base' || varName === 'parent') {
    return findEnclosingParentClassName(callNode);
  }

  // Determine the enclosing function scope for the call
  const scopeKey = findEnclosingScopeKey(callNode);

  // Try function-local scope first
  if (scopeKey) {
    const scopeEnv = env.get(scopeKey);
    if (scopeEnv) {
      const result = scopeEnv.get(varName);
      if (result) return result;
    }
  }

  // Fall back to file-level scope
  const fileEnv = env.get(FILE_SCOPE);
  return fileEnv?.get(varName);
};


/**
 * Walk up the AST from a node to find the enclosing class/module name.
 * Used to resolve `self`/`this` receivers to their containing type.
 */
const findEnclosingClassName = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName('name')
        ?? findTypeIdentifierChild(current);
      if (nameNode) return nameNode.text;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Walk up the AST to find the enclosing class, then extract its parent class name
 * from the heritage/superclass AST node. Used to resolve `super`/`base`/`parent`.
 *
 * Supported patterns per tree-sitter grammar:
 * - Java/Ruby: `superclass` field → type_identifier/constant
 * - Python: `superclasses` field → argument_list → first identifier
 * - TypeScript/JS: unnamed `class_heritage` child → `extends_clause` → identifier
 * - C#: unnamed `base_list` child → first identifier
 * - PHP: unnamed `base_clause` child → name
 * - Kotlin: unnamed `delegation_specifier` child → constructor_invocation → user_type → type_identifier
 * - C++: unnamed `base_class_clause` child → type_identifier
 * - Swift: unnamed `inheritance_specifier` child → user_type → type_identifier
 */
const findEnclosingParentClassName = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (CLASS_CONTAINER_TYPES.has(current.type)) {
      return extractParentClassFromNode(current);
    }
    current = current.parent;
  }
  return undefined;
};

/** Extract the parent/superclass name from a class declaration AST node. */
const extractParentClassFromNode = (classNode: SyntaxNode): string | undefined => {
  // 1. Named fields: Java (superclass), Ruby (superclass), Python (superclasses)
  const superclassNode = classNode.childForFieldName('superclass');
  if (superclassNode) {
    // Java: superclass > type_identifier or generic_type, Ruby: superclass > constant
    const inner = superclassNode.childForFieldName('type')
      ?? superclassNode.firstNamedChild
      ?? superclassNode;
    return extractSimpleTypeName(inner) ?? inner.text;
  }

  const superclassesNode = classNode.childForFieldName('superclasses');
  if (superclassesNode) {
    // Python: argument_list with identifiers or attribute nodes (e.g. models.Model)
    const first = superclassesNode.firstNamedChild;
    if (first) return extractSimpleTypeName(first) ?? first.text;
  }

  // 2. Unnamed children: walk class node's children looking for heritage nodes
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (!child) continue;

    switch (child.type) {
      // TypeScript: class_heritage > extends_clause > type_identifier
      // JavaScript: class_heritage > identifier (no extends_clause wrapper)
      case 'class_heritage': {
        for (let j = 0; j < child.childCount; j++) {
          const clause = child.child(j);
          if (clause?.type === 'extends_clause') {
            const typeNode = clause.firstNamedChild;
            if (typeNode) return extractSimpleTypeName(typeNode) ?? typeNode.text;
          }
          // JS: direct identifier child (no extends_clause wrapper)
          if (clause?.type === 'identifier' || clause?.type === 'type_identifier') {
            return clause.text;
          }
        }
        break;
      }

      // C#: base_list > identifier or generic_name > identifier
      case 'base_list': {
        const first = child.firstNamedChild;
        if (first) {
          // generic_name wraps the identifier: BaseClass<T>
          if (first.type === 'generic_name') {
            const inner = first.childForFieldName('name') ?? first.firstNamedChild;
            if (inner) return inner.text;
          }
          return first.text;
        }
        break;
      }

      // PHP: base_clause > name
      case 'base_clause': {
        const name = child.firstNamedChild;
        if (name) return name.text;
        break;
      }

      // C++: base_class_clause > type_identifier (with optional access_specifier before it)
      case 'base_class_clause': {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner?.type === 'type_identifier') return inner.text;
        }
        break;
      }

      // Kotlin: delegation_specifier > constructor_invocation > user_type > type_identifier
      case 'delegation_specifier': {
        const delegate = child.firstNamedChild;
        if (delegate?.type === 'constructor_invocation') {
          const userType = delegate.firstNamedChild;
          if (userType?.type === 'user_type') {
            const typeId = userType.firstNamedChild;
            if (typeId) return typeId.text;
          }
        }
        // Also handle plain user_type (interface conformance without parentheses)
        if (delegate?.type === 'user_type') {
          const typeId = delegate.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }

      // Swift: inheritance_specifier > user_type > type_identifier
      case 'inheritance_specifier': {
        const userType = child.childForFieldName('inherits_from') ?? child.firstNamedChild;
        if (userType?.type === 'user_type') {
          const typeId = userType.firstNamedChild;
          if (typeId) return typeId.text;
        }
        break;
      }
    }
  }

  return undefined;
};

/** Find the enclosing function name for scope lookup. */
const findEnclosingScopeKey = (node: SyntaxNode): string | undefined => {
  let current = node.parent;
  while (current) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const { funcName } = extractFunctionName(current);
      if (funcName) return `${funcName}@${current.startIndex}`;
    }
    current = current.parent;
  }
  return undefined;
};

/**
 * Create a lookup that checks both local AST class names AND the SymbolTable's
 * global index. This allows extractInitializer functions to distinguish
 * constructor calls from function calls (e.g. Kotlin `User()` vs `getUser()`)
 * using cross-file type information when available.
 *
 * Only `.has()` is exposed — the SymbolTable doesn't support iteration.
 * Results are memoized to avoid redundant lookupFuzzy scans across declarations.
 */
const createClassNameLookup = (
  localNames: Set<string>,
  symbolTable?: SymbolTable,
): ClassNameLookup => {
  if (!symbolTable) return localNames;

  const memo = new Map<string, boolean>();
  return {
    has(name: string): boolean {
      if (localNames.has(name)) return true;
      const cached = memo.get(name);
      if (cached !== undefined) return cached;
      const result = symbolTable.lookupFuzzy(name).some(def => def.type === 'Class');
      memo.set(name, result);
      return result;
    },
  };
};

/**
 * Build a scoped TypeEnv from a tree-sitter AST for a given language.
 * Single-pass: collects class/struct names AND type bindings in one walk.
 * Class names are accumulated incrementally — this is safe because no
 * language allows constructing a class before its definition.
 *
 * When a symbolTable is provided (call-processor path), class names from across
 * the project are available for constructor inference in languages like Kotlin
 * where constructors are syntactically identical to function calls.
 */
/**
 * Build a TypeEnvironment from a tree-sitter AST for a given language.
 * Single-pass: collects class/struct names, type bindings, AND constructor
 * bindings that couldn't be resolved locally — all in one AST walk.
 */
export const buildTypeEnv = (
  tree: { rootNode: SyntaxNode },
  language: SupportedLanguages,
  symbolTable?: SymbolTable,
): TypeEnvironment => {
  const env: TypeEnv = new Map();
  const localClassNames = new Set<string>();
  const classNames = createClassNameLookup(localClassNames, symbolTable);
  const config = typeConfigs[language];
  const scanner = CONSTRUCTOR_BINDING_SCANNERS[language];
  const bindings: ConstructorBinding[] = [];

  /**
   * Try to extract a (variableName → typeName) binding from a single AST node.
   *
   * Resolution tiers (first match wins):
   * - Tier 0: explicit type annotations via extractDeclaration
   * - Tier 1: constructor-call inference via extractInitializer (fallback)
   */
  const extractTypeBinding = (node: SyntaxNode, scopeEnv: Map<string, string>): void => {
    // This guard eliminates 90%+ of calls before any language dispatch.
    if (TYPED_PARAMETER_TYPES.has(node.type)) {
      config.extractParameter(node, scopeEnv);
      return;
    }
    if (config.declarationNodeTypes.has(node.type)) {
      config.extractDeclaration(node, scopeEnv);
      // Tier 1: constructor-call inference as fallback.
      // Always called when available — each language's extractInitializer
      // internally skips declarators that already have explicit annotations,
      // so this handles mixed cases like `const a: A = x, b = new B()`.
      if (config.extractInitializer) {
        config.extractInitializer(node, scopeEnv, classNames);
      }
    }
  };

  const walk = (node: SyntaxNode, currentScope: string): void => {
    // Collect class/struct names as we encounter them (used by extractInitializer
    // to distinguish constructor calls from function calls, e.g. C++ `User()` vs `getUser()`)
    // Currently only C++ uses this locally; other languages rely on the SymbolTable path.
    if (CLASS_CONTAINER_TYPES.has(node.type)) {
      // Most languages use 'name' field; Kotlin uses a type_identifier child instead
      const nameNode = node.childForFieldName('name')
        ?? findTypeIdentifierChild(node);
      if (nameNode) localClassNames.add(nameNode.text);
    }

    // Detect scope boundaries (function/method definitions)
    let scope = currentScope;
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const { funcName } = extractFunctionName(node);
      if (funcName) scope = `${funcName}@${node.startIndex}`;
    }

    // Get or create the sub-map for this scope
    if (!env.has(scope)) env.set(scope, new Map());
    const scopeEnv = env.get(scope)!;

    extractTypeBinding(node, scopeEnv);

    // Scan for constructor bindings that couldn't be resolved locally.
    // Only collect if TypeEnv didn't already resolve this binding.
    if (scanner) {
      const result = scanner(node);
      if (result && !scopeEnv.has(result.varName)) {
        bindings.push({ scope, ...result });
      }
    }

    // Recurse into children
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, scope);
    }
  };

  walk(tree.rootNode, FILE_SCOPE);
  return {
    lookup: (varName, callNode) => lookupInEnv(env, varName, callNode),
    constructorBindings: bindings,
    env,
  };
};

/**
 * Unverified constructor binding: a `val x = Callee()` pattern where we
 * couldn't confirm the callee is a class (because it's defined in another file).
 * The caller must verify `calleeName` against the SymbolTable before trusting.
 */
export interface ConstructorBinding {
  /** Function scope key (matches TypeEnv scope keys) */
  scope: string;
  /** Variable name that received the constructor result */
  varName: string;
  /** Name of the callee (potential class constructor) */
  calleeName: string;
}

/** C/C++: auto x = User() where function is an identifier (not type_identifier) */
const extractCppConstructorBinding = (node: SyntaxNode): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'declaration') return undefined;
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return undefined;
  const typeText = typeNode.text;
  if (typeText !== 'auto' && typeText !== 'decltype(auto)' && typeNode.type !== 'placeholder_type_specifier') return undefined;
  const declarator = node.childForFieldName('declarator');
  if (!declarator || declarator.type !== 'init_declarator') return undefined;
  const value = declarator.childForFieldName('value');
  if (!value || value.type !== 'call_expression') return undefined;
  const func = value.childForFieldName('function');
  // Match plain identifiers (type_identifier is already resolved by extractInitializer)
  // and qualified/scoped identifiers for namespaced calls like ns::HttpClient()
  if (!func) return undefined;
  if (func.type === 'qualified_identifier' || func.type === 'scoped_identifier') {
    // ns::HttpClient → extract "HttpClient" (last segment)
    const last = func.lastNamedChild;
    if (!last) return undefined;
    const nameNode = declarator.childForFieldName('declarator');
    if (!nameNode) return undefined;
    const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
      ? nameNode.firstNamedChild : nameNode;
    if (!finalName) return undefined;
    return { varName: finalName.text, calleeName: last.text };
  }
  if (func.type !== 'identifier') return undefined;
  const nameNode = declarator.childForFieldName('declarator');
  if (!nameNode) return undefined;
  const finalName = nameNode.type === 'pointer_declarator' || nameNode.type === 'reference_declarator'
    ? nameNode.firstNamedChild : nameNode;
  if (!finalName) return undefined;
  const varName = finalName.text;
  if (!varName) return undefined;
  return { varName, calleeName: func.text };
};

/**
 * TypeScript/JavaScript: const user = getUser() — variable_declarator with call_expression value.
 * Only matches unannotated declarators; annotated ones are handled by extractDeclaration.
 * await is unwrapped: const user = await fetchUser() → callee = 'fetchUser'.
 */
const extractTsJsConstructorBinding = (node: SyntaxNode): { varName: string; calleeName: string } | undefined => {
  if (node.type !== 'variable_declarator') return undefined;
  // Skip if has an explicit type annotation — extractDeclaration handles those
  if (node.childForFieldName('type')) return undefined;
  for (const child of node.children) {
    if (child.type === 'type_annotation') return undefined;
  }
  const nameNode = node.childForFieldName('name');
  if (!nameNode || nameNode.type !== 'identifier') return undefined;
  let value = node.childForFieldName('value');
  if (!value) return undefined;
  // Unwrap await expressions: const user = await fetchUser()
  if (value.type === 'await_expression') {
    value = value.firstNamedChild;
    if (!value) return undefined;
  }
  if (value.type !== 'call_expression') return undefined;
  // Skip new_expression — extractInitializer handles constructor calls
  const func = value.childForFieldName('function');
  if (!func) return undefined;
  const calleeName = extractSimpleTypeName(func);
  if (!calleeName) return undefined;
  return { varName: nameNode.text, calleeName };
};

/** Language-specific constructor-binding scanners. */
const CONSTRUCTOR_BINDING_SCANNERS: Partial<Record<SupportedLanguages, (node: SyntaxNode) => { varName: string; calleeName: string } | undefined>> = {
  // TypeScript/JavaScript share the same variable_declarator scanner
  [SupportedLanguages.TypeScript]: extractTsJsConstructorBinding,
  [SupportedLanguages.JavaScript]: extractTsJsConstructorBinding,

  // Kotlin: val x = User(...) — property_declaration with call_expression
  [SupportedLanguages.Kotlin]: (node) => {
    if (node.type !== 'property_declaration') return undefined;
    const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
    if (!varDecl) return undefined;
    if (varDecl.namedChildren.some(c => c.type === 'user_type')) return undefined;
    const callExpr = node.namedChildren.find(c => c.type === 'call_expression');
    if (!callExpr) return undefined;
    const callee = callExpr.firstNamedChild;
    if (!callee || callee.type !== 'simple_identifier') return undefined;
    const nameNode = varDecl.namedChildren.find(c => c.type === 'simple_identifier');
    if (!nameNode) return undefined;
    return { varName: nameNode.text, calleeName: callee.text };
  },

  // Python: user = User("alice") — assignment with call
  // Also handles walrus operator: (user := User("alice"))
  [SupportedLanguages.Python]: (node) => {
    let left: SyntaxNode | null;
    let right: SyntaxNode | null;

    if (node.type === 'named_expression') {
      // Walrus operator: (user := User("alice"))
      left = node.childForFieldName('name');
      right = node.childForFieldName('value');
    } else if (node.type === 'assignment') {
      left = node.childForFieldName('left');
      right = node.childForFieldName('right');
      // Skip annotated assignments — extractDeclaration handles those
      if (node.childForFieldName('type')) return undefined;
    } else {
      return undefined;
    }

    if (!left || !right) return undefined;
    if (left.type !== 'identifier') return undefined;
    if (right.type !== 'call') return undefined;
    const func = right.childForFieldName('function');
    if (!func) return undefined;
    // Support both direct calls (User()) and qualified calls (models.User())
    const calleeName = extractSimpleTypeName(func);
    if (!calleeName) return undefined;
    return { varName: left.text, calleeName };
  },

  // Swift: let user = User(name: "alice") — property_declaration with call_expression
  [SupportedLanguages.Swift]: (node) => {
    if (node.type !== 'property_declaration') return undefined;
    // Skip if has type annotation
    if (node.childForFieldName('type')) return undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      if (node.namedChild(i)?.type === 'type_annotation') return undefined;
    }
    const pattern = node.childForFieldName('pattern');
    if (!pattern) return undefined;
    const varName = pattern.text;
    if (!varName) return undefined;
    // Find call_expression child
    let callExpr: SyntaxNode | null = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'call_expression') { callExpr = child; break; }
    }
    if (!callExpr) return undefined;
    const callee = callExpr.firstNamedChild;
    if (!callee) return undefined;
    // Direct call: User(name: "alice") — simple_identifier callee
    if (callee.type === 'simple_identifier') {
      return { varName, calleeName: callee.text };
    }
    // Explicit init: User.init(name: "alice") — navigation_expression with .init suffix
    if (callee.type === 'navigation_expression') {
      const receiver = callee.firstNamedChild;
      const suffix = callee.lastNamedChild;
      if (receiver?.type === 'simple_identifier' && suffix?.text === 'init') {
        return { varName, calleeName: receiver.text };
      }
    }
    return undefined;
  },

  // C++: auto x = User() where User is parsed as identifier (cross-file)
  // Note: C is excluded — C has no constructors and `auto` is a storage-class specifier, not type inference.
  [SupportedLanguages.CPlusPlus]: extractCppConstructorBinding,

  // Ruby: user = User.new — uses shared helper that also handles Models::User.new
  [SupportedLanguages.Ruby]: extractRubyConstructorAssignment,

  // Rust: let user = get_user("alice") — let_declaration with call_expression value, no type annotation.
  // Skips `let user: User = ...` (explicit type annotation — handled by extractDeclaration).
  // Skips `let user = User::new()` (scoped_identifier callee named "new" — handled by extractInitializer).
  // Unwraps `let mut user = get_user()` by looking inside mut_pattern for the inner identifier.
  [SupportedLanguages.Rust]: (node) => {
    if (node.type !== 'let_declaration') return undefined;
    // Skip if has explicit type annotation — extractDeclaration handles those
    if (node.childForFieldName('type')) return undefined;
    for (const child of node.children) {
      if (child.type === 'type_annotation') return undefined;
    }
    let patternNode = node.childForFieldName('pattern');
    if (!patternNode) return undefined;
    // Unwrap mut: `let mut user` → mut_pattern > identifier
    if (patternNode.type === 'mut_pattern') {
      patternNode = patternNode.firstNamedChild;
      if (!patternNode) return undefined;
    }
    if (patternNode.type !== 'identifier') return undefined;
    const value = node.childForFieldName('value');
    if (!value || value.type !== 'call_expression') return undefined;
    const func = value.childForFieldName('function');
    if (!func) return undefined;
    // Skip Struct::new() patterns — handled by extractInitializer in rust.ts
    if (func.type === 'scoped_identifier') {
      const methodName = func.lastNamedChild;
      if (methodName?.text === 'new') return undefined;
    }
    const calleeName = extractSimpleTypeName(func);
    if (!calleeName) return undefined;
    return { varName: patternNode.text, calleeName };
  },

  // PHP: $user = getUser() — assignment_expression with variable_name left and function_call_expression right
  // object_creation_expression ($user = new User()) is handled by extractInitializer.
  // Explicit typed properties (private UserRepo $repo) are handled by extractDeclaration.
  // PHP variable names include the $ sigil — kept as-is to match what extractVarName stores in the env.
  [SupportedLanguages.PHP]: (node) => {
    if (node.type !== 'assignment_expression') return undefined;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) return undefined;
    if (left.type !== 'variable_name') return undefined;
    // Skip object_creation_expression (new User()) — handled by extractInitializer
    if (right.type === 'object_creation_expression') return undefined;
    if (right.type !== 'function_call_expression') return undefined;
    const func = right.childForFieldName('function') ?? right.firstNamedChild;
    if (!func) return undefined;
    const calleeName = extractSimpleTypeName(func);
    if (!calleeName) return undefined;
    // Keep the $ sigil — PHP env keys are stored with $ (e.g. "$user") by extractVarName
    const varName = left.text;
    if (!varName) return undefined;
    return { varName, calleeName };
  },

  // Java: var user = getUser() — local_variable_declaration with `var` type and method_invocation value
  // Explicit types (User user = getUser()) are handled by extractDeclaration.
  // object_creation_expression (new User()) is handled by extractJavaInitializer.
  [SupportedLanguages.Java]: (node) => {
    if (node.type !== 'local_variable_declaration') return undefined;
    const typeNode = node.childForFieldName('type');
    if (!typeNode) return undefined;
    // Only handle `var` — explicit types are handled by extractDeclaration
    if (typeNode.text !== 'var') return undefined;
    const declarator = node.namedChildren.find((c: any) => c.type === 'variable_declarator');
    if (!declarator) return undefined;
    const nameNode = declarator.childForFieldName('name');
    const value = declarator.childForFieldName('value');
    if (!nameNode || !value) return undefined;
    // Skip object_creation_expression (new User()) — handled by extractInitializer
    if (value.type === 'object_creation_expression') return undefined;
    if (value.type !== 'method_invocation') return undefined;
    const methodName = value.childForFieldName('name');
    if (!methodName) return undefined;
    return { varName: nameNode.text, calleeName: methodName.text };
  },

  // C#: var user = GetUser() — variable_declaration with implicit_type and invocation_expression value.
  // Explicit types (User user = GetUser()) are handled by extractDeclaration.
  // object_creation_expression (new User()) is handled by extractInitializer.
  [SupportedLanguages.CSharp]: (node) => {
    if (node.type !== 'variable_declaration') return undefined;
    const typeNode = node.childForFieldName('type');
    // Only handle implicit_type (var) — explicit types handled by extractDeclaration
    if (!typeNode || typeNode.type !== 'implicit_type') return undefined;
    // Find first variable_declarator child
    let declarator: any = null;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'variable_declarator') { declarator = child; break; }
    }
    if (!declarator) return undefined;
    const nameNode = declarator.childForFieldName('name') ?? declarator.firstNamedChild;
    if (!nameNode || nameNode.type !== 'identifier') return undefined;
    // Find equals_value_clause
    let eqClause: any = null;
    for (let i = 0; i < declarator.namedChildCount; i++) {
      const child = declarator.namedChild(i);
      if (child?.type === 'equals_value_clause') { eqClause = child; break; }
    }
    if (!eqClause) return undefined;
    const value = eqClause.firstNamedChild;
    if (!value) return undefined;
    // Skip object_creation_expression (new User()) — handled by extractInitializer
    if (value.type === 'object_creation_expression') return undefined;
    if (value.type !== 'invocation_expression') return undefined;
    const func = value.firstNamedChild;
    if (!func) return undefined;
    const calleeName = extractSimpleTypeName(func);
    if (!calleeName) return undefined;
    return { varName: nameNode.text, calleeName };
  },

  // Go: user := GetUser("alice") — short_var_declaration with single call_expression on the right.
  // Multi-return (`user, err := GetUser()`) is intentionally skipped.
  // new() and make() are already handled by extractDeclaration in go.ts.
  [SupportedLanguages.Go]: (node) => {
    if (node.type !== 'short_var_declaration') return undefined;
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (!left || !right) return undefined;
    // Single assignment only — skip multi-return like `user, err := GetUser()`
    const leftIds = left.type === 'expression_list' ? left.namedChildren : [left];
    if (leftIds.length !== 1 || leftIds[0].type !== 'identifier') return undefined;
    const rightExprs = right.type === 'expression_list' ? right.namedChildren : [right];
    if (rightExprs.length !== 1 || rightExprs[0].type !== 'call_expression') return undefined;
    const func = rightExprs[0].childForFieldName('function');
    if (!func) return undefined;
    // Skip new() and make() — already handled by extractDeclaration
    if (func.text === 'new' || func.text === 'make') return undefined;
    const calleeName = extractSimpleTypeName(func);
    if (!calleeName) return undefined;
    return { varName: leftIds[0].text, calleeName };
  },
};

