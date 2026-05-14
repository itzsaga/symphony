// Strict Liquid renderer for the per-issue prompt template (spec §5.4 / §12).
// Exposes `renderPrompt`, the `TemplateError` union, and the engine instance.
import { Data, Effect } from "effect";
import {
  Liquid,
  LiquidError,
  ParseError,
  RenderError,
  TokenizationError,
  UndefinedVariableError,
} from "liquidjs";
import type { Issue } from "../linear/schemas.ts";

/* -------------------------------------------------------------------------- */
/* Tagged errors — spec §5.5.                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Template did not parse (malformed `{% ... %}` / `{{ ... }}` syntax). Block
 * the affected run; the orchestrator treats this as a worker failure.
 */
export class TemplateParseError extends Data.TaggedError(
  "TemplateParseError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Template parsed but rendering failed. Covers strict-variable misses
 * (`UndefinedVariableError`), strict-filter misses (liquidjs surfaces these as
 * a `ParseError` whose message starts with `undefined filter:`), and any other
 * per-render failure (`RenderError`, type mismatches in filter arguments).
 */
export class TemplateRenderError extends Data.TaggedError(
  "TemplateRenderError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Discriminated union of every renderer failure surfaced by `renderPrompt`. */
export type TemplateError = TemplateParseError | TemplateRenderError;

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Single shared `Liquid` instance. Strict modes are mandatory per §5.4 — any
 * unknown variable or filter MUST fail the render rather than silently
 * collapsing to an empty string. The engine is stateless across renders so a
 * module-scoped singleton is safe.
 */
export const engine: Liquid = new Liquid({
  strictVariables: true,
  strictFilters: true,
});

/** §5.4 fallback prompt for an empty template body. */
const EMPTY_TEMPLATE_FALLBACK = "You are working on an issue from Linear.";

/**
 * Map a thrown liquidjs error onto our tagged error union. The class hierarchy
 * we observe in liquidjs 10.25.7:
 *
 *   - `TokenizationError`           — unterminated `{{` / `{%` etc.
 *   - `UndefinedVariableError`      — strict-variable miss at render time.
 *   - `RenderError` / `LiquidErrors`— other render-time failures.
 *   - `ParseError`                  — most parse-phase failures, BUT also the
 *                                     bucket strict filter checks throw into,
 *                                     with a message of `undefined filter: X`.
 *
 * Strict-filter misses are conceptually a render-time failure (the spec lists
 * them under `template_render_error`), so we route any `ParseError` whose
 * message starts with `undefined filter:` to `TemplateRenderError` and treat
 * every other parse-class failure as `TemplateParseError`.
 */
const toTemplateError = (cause: unknown): TemplateError => {
  const message =
    cause instanceof Error ? cause.message : String(cause);

  if (cause instanceof TokenizationError) {
    return new TemplateParseError({ message, cause });
  }

  if (cause instanceof ParseError) {
    if (message.startsWith("undefined filter:")) {
      return new TemplateRenderError({ message, cause });
    }
    return new TemplateParseError({ message, cause });
  }

  if (
    cause instanceof UndefinedVariableError ||
    cause instanceof RenderError ||
    cause instanceof LiquidError
  ) {
    return new TemplateRenderError({ message, cause });
  }

  return new TemplateRenderError({ message, cause });
};

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Render the workflow prompt for a single dispatch.
 *
 * `issue` is exposed verbatim — its keys are already plain strings (per the
 * normalized `Issue` schema in `src/linear/schemas.ts`) so liquidjs can
 * navigate `issue.identifier`, `issue.labels`, `issue.blocked_by`, etc. with
 * no further conversion (§12.2).
 *
 * `attempt` is `null` on the first run and the integer attempt number on a
 * retry/continuation run. liquidjs evaluates `null` as falsy in `{% if %}`
 * (§5.4 + §12.3).
 *
 * The §5.4 fallback fires only when the input template is empty/whitespace —
 * a non-empty template that legitimately renders to `""` is returned as-is.
 */
export const renderPrompt = (
  template: string,
  vars: { issue: Issue; attempt: number | null },
): Effect.Effect<string, TemplateError> =>
  Effect.gen(function* () {
    if (template.trim() === "") {
      return EMPTY_TEMPLATE_FALLBACK;
    }
    return yield* Effect.tryPromise({
      try: () => engine.parseAndRender(template, vars),
      catch: toTemplateError,
    });
  });
