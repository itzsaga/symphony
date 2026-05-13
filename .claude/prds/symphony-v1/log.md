# Implementation Log

Reverse-chronological. Newest entries at the top.

## 2026-05-13T23:25Z — AGENTS.md and CLAUDE.md

**Status**: Completed

**Summary**: Authored project-level memory files. `AGENTS.md` is 135 lines covering project overview, the two declared spec divergences, quickstart, commands, layout, coding conventions, spec conformance, where things live, and git/CI hygiene. `CLAUDE.md` is the canonical single-line `@AGENTS.md` import.

**Changes Made**:
- `AGENTS.md` — Created. 135 lines, well under the 200-line cap.
- `CLAUDE.md` — Created. Single line: `@AGENTS.md`.

**Notes**:
- Reiterated load-bearing global CLAUDE.md rules (no `any`/`!`/`@ts-nocheck`, no `--no-verify`, no Claude co-author trailers) so CI agents without `~/.claude/CLAUDE.md` still see them — without duplicating the full global rules file.
- Layout section references the actual `bun.lock` (text), not the spec's older `bun.lockb`.
- `TRUST.md` is referenced as a pointer; authoring it is its own task.

## 2026-05-13T23:25Z — Logger service

**Status**: Completed

**Summary**: Implemented the Effect Logger service with FiberRef-scoped context, JSONL stderr emission, in-memory ring buffer (default 500), and sink-failure isolation. 9 unit tests pass.

**Changes Made**:
- `src/observability/Logger.ts` — Created. `Logger` Tag, `LoggerLive` Layer + `layer({ sink, capacity })` test factory, `withContext` / `withIssue` / `withSession` helpers backed by a module-private FiberRef, `LogRecord` schema (Effect 3.21's built-in `Schema`), `recentEvents` accessor, `CircularBuffer` (FIFO), `safeStringify` (drops `undefined`, swaps cycles for `"<circular>"`).
- `test/unit/observability/Logger.test.ts` — Created. 9 tests covering JSONL emission, scoped context (`withIssue` + `withSession`), nested context merging, ring-buffer eviction, sink-failure isolation, snapshot semantics, default capacity, circular-ref serialization. Uses `bun:test` runner with `Effect.runPromise` (equivalent to `it.effect`, no extra binary).
- `src/observability/.gitkeep` — Deleted (replaced by real source file).

**Notes**:
- Used `Context.Tag` class form per the PRD's preference.
- `withContext`/`withIssue`/`withSession` are module-level helpers that depend only on the FiberRef (not on the service), so callers can establish context before the Logger Layer is provided. Helpers no-op cleanly when no Logger is installed.
- Field precedence in emitted records: `{ ...payload, ...ctx, timestamp, level }` — operator-set tracing context wins over caller-supplied keys; `timestamp`/`level` are always authoritative.
- Used Effect 3.21's bundled `Schema` rather than the deprecated `@effect/schema` package. `@effect/schema` is still in `package.json` deps for now — cleanup is a future task.

## 2026-05-13T23:14Z — Bun + TypeScript + Effect setup

**Status**: Completed

**Summary**: Stood up the TypeScript/Bun project skeleton. `bun install`, `bun run typecheck`, and `bun test` all exit 0. `src/main.ts` stub validates the WORKFLOW.md arg, logs startup to stderr, and exits 1 (missing file) / 2 (missing arg).

**Changes Made**:
- `package.json` — Created. Deps: effect ^3.21.2, @effect/platform ^0.96.1, @effect/platform-bun ^0.89.0, @effect/schema ^0.75.5, liquidjs ^10.25.7. Dev: @effect/vitest ^0.29.0, @types/bun ^1.3.14, typescript ^5.7.0. Scripts: dev/start/test/typecheck per spec.
- `tsconfig.json` — Created. Strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + bundler resolution + ESNext + verbatimModuleSyntax.
- `bun.lock` — Created via `bun install` (note: bun v1.2+ defaults to text `bun.lock` instead of binary `bun.lockb`).
- `.gitignore` — Created. Covers node_modules/, build artifacts, .direnv/, result*.
- `src/main.ts` — Created. CLI entry stub.
- `src/{config,linear,workspace,sandbox,claude,prompt,orchestrator,http,observability}/.gitkeep` — Created. Service-graph skeleton from PRD §Architecture.

**Notes**:
- Spec called for `bun.lockb`; actual artifact is `bun.lock` (text-based) — current bun default. Functionally equivalent for lockfile purposes.
- Subagent hit an internal API error after producing all files but before reporting back; verification was completed externally.

## 2026-05-13T23:08Z — Nix flake dev shell

**Status**: Completed

**Summary**: Authored `flake.nix` + `flake.lock` + `.envrc` providing a reproducible dev shell with `bun`, `nono`, `claude-code`, `git`, `jq`, `yq-go` for `aarch64-darwin` and `x86_64-linux`.

**Changes Made**:
- `flake.nix` — Created. Pins nixpkgs to `da5ad661ba4e5ef59ba743f0d112cbc30e474f32`, builds `devShells.default` via `flake-utils.lib.eachSystem`, gates unfree allowlist to `claude-code` only.
- `flake.lock` — Created via `nix flake lock`. Locks nixpkgs + flake-utils + flake-utils/systems.
- `.envrc` — Created with `use flake` for direnv users.

**Notes**:
- `pkgs.claude-code` exists in nixpkgs at the pinned commit (v2.1.137); did not need a custom derivation.
- Used `eachSystem ["aarch64-darwin" "x86_64-linux"]` rather than `eachDefaultSystem` so `nix flake check --all-systems` is honest about supported platforms.
- `nix flake check --all-systems` and all `nix develop --command <tool> --version` invocations exited 0.
