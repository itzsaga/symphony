# WORKFLOW.md schema and parser

## Objective

Implement a pure module that parses a `WORKFLOW.md` file path into a `WorkflowDefinition` ({ config: TypedConfig, prompt_template: string }) with all of spec §5 / §6 enforced: YAML front-matter + Markdown-body split, defaults from §6.4, `$VAR` indirection, `~` expansion, path normalization, strict typing, and the renamed `agent_runner.*` namespace.

## Context

### Parent PRD

- **PRD**: Symphony v1 (Effect.ts + Claude Code)
- **PRD Path**: `.claude/prds/symphony-v1/PRD.md`

### Related Tasks

- **Depends on**: Bun + TypeScript + Effect setup.
- **Blocks**: WorkflowLoader service with file watch (which wraps this parser in a watch loop).

## Acceptance Criteria

- [ ] `parseWorkflow(content: string, workflowFilePath: string): Effect<WorkflowDefinition, WorkflowParseError>` is the entry point. Failure types: `MissingWorkflowFile | WorkflowParseError | WorkflowFrontMatterNotAMap` (matches spec §5.5).
- [ ] Front-matter detection (§5.2): leading `---` opens, next `---` closes; if absent, entire file is body and config defaults apply.
- [ ] Body is trimmed.
- [ ] Top-level keys recognized: `tracker`, `polling`, `workspace`, `hooks`, `agent_runner`, `server` (extension). Unknown keys are ignored (forward-compat per §5.3).
- [ ] Field schema matches spec §6.4 cheat-sheet, with two divergences declared in TRUST.md:
  - The `codex.*` namespace is renamed to `agent_runner.*`:
    - `agent_runner.kind` (default `"claude_code"`)
    - `agent_runner.command` (default `"claude"`)
    - `agent_runner.permission_mode` (default `"bypassPermissions"`)
    - `agent_runner.max_turns` (default 20)
    - `agent_runner.turn_timeout_ms` (default 3,600,000)
    - `agent_runner.read_timeout_ms` (default 5,000)
    - `agent_runner.stall_timeout_ms` (default 300,000)
    - `agent_runner.network_profile` (default `"claude-code"`)
    - `agent_runner.bare` (default `false`) — when `true`, pass `--bare` to the `claude` CLI and inject `ANTHROPIC_API_KEY` via `nono --credential anthropic`. When `false`, omit `--bare` so Claude reads `~/.claude/` OAuth tokens (operator runs `claude /login` once, daemon reuses the session). See `nono-sandbox-service.md` and `claude-subprocess-lifecycle.md` for how this flag flows into argv and sandbox policy.
    - `agent_runner.extra_args` (default `[]`)
  - Reject unknown values for the `kind` enum.
- [ ] `$VAR` resolution: only applied to string fields that explicitly contain `$VAR`. Looked up from `process.env`. Empty resolution treated as missing (§6.4 for `tracker.api_key`).
- [ ] Path expansion: `~` to home, relative paths resolved against the directory containing the workflow file. Applied only to filesystem-path fields (`workspace.root`), not to URI fields or arbitrary commands (§6.1).
- [ ] Coercion: integers coerced from JSON numbers; non-integer values rejected. Lists coerced from YAML sequences; non-list values rejected.
- [ ] Validation classes used by §6.3 dispatch preflight are exposed as a separate function `validateForDispatch(workflow)`. Validates: workflow loads, `tracker.kind === "linear"`, `tracker.api_key` present after `$` resolution, `tracker.project_slug` present, `agent_runner.command` non-empty.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `src/config/WorkflowSchema.ts` | Create | `@effect/schema` schemas for the front matter + Issue model + error types. |
| `src/config/parseWorkflow.ts` | Create | `parseWorkflow` and `validateForDispatch` pure functions. |
| `src/config/envResolution.ts` | Create | `$VAR` expansion helper. |

### Technical Constraints

- Use `@effect/schema` for everything; do not hand-roll validators.
- YAML parsing: `yaml` npm package (or whatever is already vendored — pick one).
- Do not use `any`; if a field is intentionally polymorphic, model as a discriminated union or `Schema.Unknown` and refine.
- The renamed `agent_runner.*` namespace is final — do NOT accept `codex.*` as an alias (per Seth's decision in PRD Discussion → "Front matter namespace rename"). A WORKFLOW.md with `codex.*` keys fails validation, which is correct: it points the user at the divergence.

### Relevant Code References

- Spec §5.2 (parsing rules), §5.3 (front-matter schema), §5.5 (error classes), §6.1 (resolution pipeline), §6.3 (dispatch preflight), §6.4 (cheat-sheet).
- PRD §Architecture → "Front matter schema rename".
- PRD §Discussion → "Front matter namespace rename".

### Code Examples

```ts
// WorkflowDefinition shape
type WorkflowDefinition = {
  config: TypedConfig
  prompt_template: string
  source_path: string   // absolute path of the file parsed
}

type TypedConfig = {
  tracker: { kind: "linear"; endpoint: string; api_key: string; project_slug: string; active_states: ReadonlyArray<string>; terminal_states: ReadonlyArray<string> }
  polling: { interval_ms: number }
  workspace: { root: string }
  hooks: { after_create: string | null; before_run: string | null; after_run: string | null; before_remove: string | null; timeout_ms: number }
  agent_runner: { kind: "claude_code"; command: string; permission_mode: "default" | "bypassPermissions" | "acceptEdits"; max_turns: number; turn_timeout_ms: number; read_timeout_ms: number; stall_timeout_ms: number; network_profile: string; bare: boolean; extra_args: ReadonlyArray<string> }
  server: { port: number } | null
}
```

## Testing Requirements

- [ ] Round-trip: a known-good WORKFLOW.md parses to the expected TypedConfig.
- [ ] `$VAR` indirection works for `tracker.api_key` and `workspace.root`.
- [ ] `~` expansion works for `workspace.root`.
- [ ] Relative `workspace.root` resolves against the file's directory.
- [ ] Missing required fields (`tracker.kind`, `tracker.project_slug` for linear) cause `validateForDispatch` to fail.
- [ ] A `codex.*`-shaped workflow fails parse (intentional).
- [ ] Empty body → minimal-default prompt usable as-is (§5.4 fallback).
- [ ] Unknown top-level keys parse without error (forward-compat).

## Out of Scope

- File watching — that's the next task (workflow-loader-and-watch.md).
- Validating Codex-specific keys.
- Adapter-agnostic abstractions for non-Linear trackers (PRD constraint: Linear-only in v1).
