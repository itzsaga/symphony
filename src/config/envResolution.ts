// $VAR_NAME indirection helper for WORKFLOW.md config values.
// Pure: only resolves explicit `$VAR_NAME` references; does not globally read env into config.
import { Data, Effect } from "effect";

/**
 * Tagged failure when `$VAR_NAME` syntax appears but the variable is missing
 * or resolves to the empty string (per spec §5.3.1 and §6.4 — empty
 * resolution is treated as missing for `tracker.api_key`; the parser raises
 * this for any field that opts in to indirection so the caller can decide
 * how to react).
 */
export class EnvIndirectionUnresolved extends Data.TaggedError(
  "EnvIndirectionUnresolved",
)<{
  readonly varName: string;
  readonly fieldPath: string;
}> {}

/**
 * Test whether `value` looks like an explicit `$VAR_NAME` indirection.
 * Anchored: the entire value must match `$NAME` with letters/digits/underscore.
 * Anything else (including embedded `$VAR` substrings) is left as-is per
 * spec §6.1: indirection only kicks in when the value is itself the variable
 * reference. Liberal interpretation would silently expand shell-like
 * substitutions in arbitrary strings, which the spec does not authorize.
 */
const VAR_REFERENCE = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Resolve `value` against `process.env` if (and only if) the entire string is
 * a `$VAR_NAME` reference. Empty resolution is treated as missing per spec
 * §6.4 / §5.3.1.
 *
 * Pure-ish: reads `process.env` once. Wrapped in Effect so callers can
 * compose this with the rest of the parser pipeline.
 */
export const resolveEnvIndirection = (
  value: string,
  fieldPath: string,
): Effect.Effect<string, EnvIndirectionUnresolved> => {
  const match = VAR_REFERENCE.exec(value);
  if (match === null) {
    // Not an indirection — pass through verbatim.
    return Effect.succeed(value);
  }
  const varName = match[1] as string;
  const resolved = process.env[varName];
  if (resolved === undefined || resolved === "") {
    return Effect.fail(
      new EnvIndirectionUnresolved({ varName, fieldPath }),
    );
  }
  return Effect.succeed(resolved);
};

/**
 * Synchronous variant for use during schema-time decoding where Effect
 * composition would add noise. Returns `null` on unresolved.
 */
export const resolveEnvIndirectionSync = (value: string): string | null => {
  const match = VAR_REFERENCE.exec(value);
  if (match === null) return value;
  const varName = match[1] as string;
  const resolved = process.env[varName];
  if (resolved === undefined || resolved === "") return null;
  return resolved;
};
