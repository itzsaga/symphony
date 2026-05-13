# Prompt renderer

## Objective

Implement a strict Liquid-templating wrapper using `liquidjs` that renders the per-issue prompt from `WORKFLOW.md`'s body, with `issue` and `attempt` variables. Strict mode is mandatory: unknown variables and unknown filters MUST fail rendering (§5.4).

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup.
- **Blocks**: orchestrator-state.md (which calls into the prompt renderer per dispatch), claude-event-mapping.md indirectly.

## Acceptance Criteria

- [ ] `renderPrompt(template: string, vars: { issue: Issue; attempt: number | null }): Effect<string, TemplateError>` is the entry point.
- [ ] `liquidjs.Liquid` is instantiated once at module-load time with `{ strictVariables: true, strictFilters: true }`.
- [ ] Render-time error types:
  - `TemplateParseError` — the template itself doesn't parse (§5.5).
  - `TemplateRenderError` — unknown variable, unknown filter, type mismatch during render (§5.5).
- [ ] `issue` is exposed with all spec §4.1.1 fields. Nested arrays/maps (labels, blocked_by) preserved so `{% for label in issue.labels %}` works (§12.2).
- [ ] `attempt` is exposed as `null` on first run (`attempt === null` works in Liquid) and as the integer N on retries (§5.4 + §12.3).
- [ ] Object keys are converted to strings (§12.2 — "Convert issue object keys to strings for template compatibility").
- [ ] Empty body uses the §5.4 fallback prompt `"You are working on an issue from Linear."` (handled at render layer, not at parse layer — fallback applies only on empty body, not on parse failure).

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/prompt/Render.ts` | Create | `renderPrompt` + error types + the liquidjs Liquid instance. |

### Technical Constraints

- `liquidjs` is pulled in via the bootstrap task's `package.json` dependency.
- Don't precompile templates; the same template is re-rendered every dispatch and re-loaded on workflow change. Cache the compiled template per (template-string, version) if profiling shows it matters; otherwise skip the cache.
- Don't extend Liquid with custom filters in v1. If a future workflow needs `slugify` or similar, add it under a new task.
- A render that produces an empty string MUST NOT be silently substituted with the fallback. Fallback only fires for empty input templates (`prompt_template.trim() === ""`).

### Relevant Code References

- Spec §5.4 (template contract), §12 (entire section), §5.5 (error classes).
- PRD §Discussion → "Prompt template engine".

### Code Examples

```ts
import { Liquid } from "liquidjs"

const engine = new Liquid({ strictVariables: true, strictFilters: true })

export const renderPrompt = (
  template: string,
  vars: { issue: Issue; attempt: number | null },
) =>
  Effect.gen(function*() {
    if (template.trim() === "") return "You are working on an issue from Linear."
    return yield* Effect.tryPromise({
      try: () => engine.parseAndRender(template, vars),
      catch: (e) =>
        e instanceof TokenizationError
          ? new TemplateParseError({ message: String(e) })
          : new TemplateRenderError({ message: String(e) }),
    })
  })
```

## Testing Requirements

- [ ] Renders `{{ issue.identifier }}: {{ issue.title }}` against a sample issue.
- [ ] `{% for l in issue.labels %}{{ l }} {% endfor %}` iterates and lowercases.
- [ ] `{{ issue.unknown }}` raises `TemplateRenderError` (strict variables).
- [ ] `{{ issue.title | unknown_filter }}` raises `TemplateRenderError` (strict filters).
- [ ] `{% if attempt %}retry{% else %}first{% endif %}` outputs `"first"` for `null`, `"retry"` for `1`.
- [ ] Empty template uses fallback prompt.
- [ ] Malformed template (`{{ unclosed`) raises `TemplateParseError`.

## Out of Scope

- Caching compiled templates.
- Custom Liquid filters.
- Auto-escaping for code blocks. The prompt is plain text to the model, not HTML.
- Sandboxing the template engine itself. liquidjs is well-behaved by default.
