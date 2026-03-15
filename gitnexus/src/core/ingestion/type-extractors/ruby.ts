import type { LanguageTypeConfig, ParameterExtractor, TypeBindingExtractor, InitializerExtractor, ClassNameLookup } from './types.js';
import { extractRubyConstructorAssignment } from './shared.js';

/**
 * Ruby type extractor — YARD annotation parsing.
 *
 * Ruby has no static type system, but the YARD documentation convention
 * provides de facto type annotations via comments:
 *
 *   # @param name [String] the user's name
 *   # @param repo [UserRepo] the repository
 *   # @return [User]
 *   def create(name, repo)
 *     repo.save
 *   end
 *
 * This extractor parses `@param name [Type]` patterns from comment nodes
 * preceding method definitions and binds parameter names to their types.
 *
 * Resolution tiers:
 * - Tier 0: YARD @param annotations (extractDeclaration pre-populates env)
 * - Tier 1: Constructor inference via `user = User.new` (handled by CONSTRUCTOR_BINDING_SCANNERS in type-env.ts)
 */

/** Regex to extract @param annotations: `@param name [Type]` */
const YARD_PARAM_RE = /@param\s+(\w+)\s+\[([^\]]+)\]/g;

/**
 * Extract the simple type name from a YARD type string.
 * Handles:
 * - Simple types: "String" → "String"
 * - Qualified types: "Models::User" → "User"
 * - Generic types: "Array<User>" → "Array"
 * - Nullable types: "String, nil" → "String"
 * - Union types: "String, Integer" → undefined (ambiguous)
 */
const extractYardTypeName = (yardType: string): string | undefined => {
  const trimmed = yardType.trim();

  // Handle nullable: "Type, nil" or "nil, Type"
  const parts = trimmed.split(',').map(p => p.trim()).filter(p => p !== 'nil');
  if (parts.length !== 1) return undefined; // ambiguous union

  const typePart = parts[0];

  // Handle qualified: "Models::User" → "User"
  const segments = typePart.split('::');
  const last = segments[segments.length - 1];

  // Handle generic: "Array<User>" → "Array"
  const genericMatch = last.match(/^(\w+)\s*[<{(]/);
  if (genericMatch) return genericMatch[1];

  // Simple identifier check
  if (/^\w+$/.test(last)) return last;

  return undefined;
};

/**
 * Collect YARD @param annotations from comment nodes preceding a method definition.
 * Returns a map of paramName → typeName.
 *
 * In tree-sitter-ruby, comments are sibling nodes that appear before the method node.
 * We walk backwards through preceding siblings collecting consecutive comment nodes.
 */
const collectYardParams = (methodNode: SyntaxNode): Map<string, string> => {
  const params = new Map<string, string>();

  // In tree-sitter-ruby, YARD comments preceding a method inside a class body
  // are placed as children of the `class` node, NOT as siblings of the `method`
  // inside `body_statement`. The AST structure is:
  //
  //   class
  //     constant = "ClassName"
  //     comment = "# @param ..."     ← sibling of body_statement
  //     comment = "# @param ..."     ← sibling of body_statement
  //     body_statement
  //       method                     ← method is here, no preceding siblings
  //
  // For top-level methods (outside classes), comments ARE direct siblings.
  // We handle both by checking: if method has no preceding comment siblings,
  // look at parent (body_statement) siblings instead.
  const commentTexts: string[] = [];

  const collectComments = (startNode: SyntaxNode): void => {
    let sibling = startNode.previousSibling;
    while (sibling) {
      if (sibling.type === 'comment') {
        commentTexts.unshift(sibling.text);
      } else if (sibling.isNamed) {
        break;
      }
      sibling = sibling.previousSibling;
    }
  };

  // Try method's own siblings first (top-level methods)
  collectComments(methodNode);

  // If no comments found and parent is body_statement, check parent's siblings
  if (commentTexts.length === 0 && methodNode.parent?.type === 'body_statement') {
    collectComments(methodNode.parent);
  }

  // Parse all comment lines for @param annotations
  const commentBlock = commentTexts.join('\n');
  let match: RegExpExecArray | null;

  // Reset regex state
  YARD_PARAM_RE.lastIndex = 0;
  while ((match = YARD_PARAM_RE.exec(commentBlock)) !== null) {
    const paramName = match[1];
    const rawType = match[2];
    const typeName = extractYardTypeName(rawType);
    if (typeName) {
      params.set(paramName, typeName);
    }
  }

  return params;
};

/**
 * Ruby node types that may carry type bindings.
 * - `method`/`singleton_method`: YARD @param annotations (via extractDeclaration)
 * - `assignment`: Constructor inference like `user = User.new` (via extractInitializer;
 *   extractDeclaration returns early for these nodes)
 */
const DECLARATION_NODE_TYPES: ReadonlySet<string> = new Set([
  'method',
  'singleton_method',
  'assignment',
]);

/**
 * Extract YARD annotations from method definitions.
 * Pre-populates the scope env with parameter types before the
 * standard parameter walk (which won't find types since Ruby has none).
 */
const extractDeclaration: TypeBindingExtractor = (node: SyntaxNode, env: Map<string, string>): void => {
  if (node.type !== 'method' && node.type !== 'singleton_method') return;

  const yardParams = collectYardParams(node);
  if (yardParams.size === 0) return;

  // Pre-populate env with YARD type bindings for each parameter
  for (const [paramName, typeName] of yardParams) {
    env.set(paramName, typeName);
  }
};

/**
 * Ruby parameter extraction.
 * Ruby parameters (identifiers inside method_parameters) have no inline
 * type annotations. YARD types are already populated by extractDeclaration,
 * so this is a no-op — the bindings are already in the env.
 *
 * We still register this to maintain the LanguageTypeConfig contract.
 */
const extractParameter: ParameterExtractor = (_node: SyntaxNode, _env: Map<string, string>): void => {
  // Ruby parameters have no type annotations.
  // YARD types are pre-populated by extractDeclaration.
};

/**
 * Ruby constructor inference: user = User.new or service = Models::User.new
 * Uses the shared extractRubyConstructorAssignment helper for AST matching,
 * then resolves against locally-known class names.
 */
const extractInitializer: InitializerExtractor = (node, env, classNames): void => {
  const result = extractRubyConstructorAssignment(node);
  if (!result) return;
  if (env.has(result.varName)) return;
  if (classNames.has(result.calleeName)) {
    env.set(result.varName, result.calleeName);
  }
};

export const typeConfig: LanguageTypeConfig = {
  declarationNodeTypes: DECLARATION_NODE_TYPES,
  extractDeclaration,
  extractParameter,
  extractInitializer,
  scanConstructorBinding: extractRubyConstructorAssignment,
};
