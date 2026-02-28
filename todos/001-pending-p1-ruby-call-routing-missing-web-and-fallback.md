
---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, ruby, architecture, correctness]
dependencies: []
---

# Ruby Call Routing Missing from Web and CLI Sequential Fallback

## Problem Statement

Ruby's tree-sitter queries capture `require`, `include`, `extend`, `prepend`, and `attr_*` as generic `@call` nodes (not `@import` or `@heritage`). The parse-worker.ts has a ~110 line Ruby-specific routing block that intercepts these calls and routes them to the correct extraction pipelines (imports, heritage, properties). However, this routing logic exists **only** in the CLI worker thread.

The web version (`gitnexus-web/src/core/ingestion/call-processor.ts`) and the CLI sequential fallback path have **no Ruby call routing**. Ruby `require`/`require_relative` are in the built-ins filter and will be silently discarded. No Ruby imports, heritage (mixins), or properties will be extracted.

**Why it matters:** The web version will produce an incomplete knowledge graph for Ruby codebases - classes and methods will appear, but all import relationships, mixin relationships, and property definitions will be missing. Agent tools (query, impact, context) will return incomplete results.

## Findings

- **Pattern Recognition Specialist:** Confirmed the routing block exists only in `parse-worker.ts` (lines 647-749). Both call-processor.ts files (CLI and web) lack it entirely.
- **Agent-Native Reviewer:** Confirmed web import-processor only looks for `@import` captures (line 176), which Ruby queries never produce. Heritage-processor only looks for `@heritage.*` captures.
- **TypeScript Reviewer:** Confirmed the web call-processor has no `SupportedLanguages.Ruby` reference.
- **Learnings Researcher:** Confirmed this is a gap in the implementation, not an intentional design choice.

### Evidence

```bash
# No Ruby-specific routing in web call-processor
grep -c "SupportedLanguages.Ruby" gitnexus-web/src/core/ingestion/call-processor.ts
# Result: 0
```

## Proposed Solutions

### Solution A: Port routing to both call-processor.ts files (Recommended)

Copy the Ruby call routing block from `parse-worker.ts` into:
1. `gitnexus/src/core/ingestion/call-processor.ts` (CLI sequential fallback)
2. `gitnexus-web/src/core/ingestion/call-processor.ts` (web version)

Adapt the API (call-processor uses graph.addRelationship() directly vs the worker's result arrays).

- **Pros:** Complete parity, all paths produce identical graphs
- **Cons:** Adds to the triplication problem
- **Effort:** Medium
- **Risk:** Low

### Solution B: Add import/heritage processing to web import-processor and heritage-processor

Instead of routing in call-processor, add Ruby-specific `@call` handling to the web's import-processor.ts and heritage-processor.ts.

- **Pros:** Keeps call routing logic closer to where imports/heritage are handled
- **Cons:** More files to modify, different pattern from CLI worker
- **Effort:** Medium
- **Risk:** Medium (divergent architecture)

## Technical Details

**Affected files:**
- `gitnexus-web/src/core/ingestion/call-processor.ts` - needs Ruby routing
- `gitnexus/src/core/ingestion/call-processor.ts` - needs Ruby routing (sequential fallback)
- Reference: `gitnexus/src/core/ingestion/workers/parse-worker.ts` lines 643-749

## Acceptance Criteria

- [ ] Web version extracts Ruby `require`/`require_relative` as IMPORTS edges
- [ ] Web version extracts `include`/`extend`/`prepend` as heritage edges
- [ ] Web version extracts `attr_*` as Property nodes
- [ ] CLI sequential fallback produces same results as worker path
- [ ] Built-in filtering still works (no false CALLS edges for routed calls)

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-02-27 | Identified during code review | Found by 4/6 review agents |

## Resources

- PR branch: `add-support-ruby-rails`
- Reference implementation: `gitnexus/src/core/ingestion/workers/parse-worker.ts:643-749`
