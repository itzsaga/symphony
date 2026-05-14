// Bidirectional control-protocol dispatcher for the Claude CLI's stream-json pipe.
// Consumes inbound `control_request` / `control_cancel_request` frames and writes `control_response` frames back.
import {
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { Logger } from "../observability/Logger.ts";
import type { ClaudeSubprocess, OutboundFrame } from "./ClaudeSubprocess.ts";
import {
  CanUseToolRequest,
  ControlCancelRequest,
  ControlRequest,
  InitializeRequest,
  McpMessageRequest,
  type OutboundControlResponse,
  type RequestId,
} from "./StreamJson.ts";

/* -------------------------------------------------------------------------- */
/* Type guards                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Narrow a generic `StreamJsonMessage` (whose union ends in `UnknownFrame`,
 * matched only by `type: string`) to a strict `ControlRequest`. Required
 * because TypeScript's `frame.type === "control_request"` discriminator does
 * not exclude the catch-all `UnknownFrame` variant on its own.
 */
const isControlRequest = Schema.is(ControlRequest);

/** Same idea for `control_cancel_request`. */
const isControlCancelRequest = Schema.is(ControlCancelRequest);

/**
 * Per-subtype guards for the `control_request.request` body. The body union
 * ends in `UnknownControlRequestBody` (`subtype: string`), so a plain
 * `switch` on `request.subtype` cannot statically exclude it; these guards
 * give us back the exact narrowed type.
 */
const isCanUseTool = Schema.is(CanUseToolRequest);
const isMcpMessage = Schema.is(McpMessageRequest);
const isInitialize = Schema.is(InitializeRequest);

/* -------------------------------------------------------------------------- */
/* Handler result shapes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `can_use_tool` decision body, mirroring the wire shape documented in
 * `research/claude-stream-json.md` §6. Either an `allow` (with optional input
 * rewrite) or a `deny` (with a human-readable message and optional whole-turn
 * `interrupt` hint).
 */
export type CanUseToolDecision =
  | {
      readonly behavior: "allow";
      readonly updatedInput?: unknown;
      readonly updatedPermissions?: ReadonlyArray<unknown>;
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly interrupt: boolean;
    };

/**
 * Result returned by an `mcp_message` handler. The handler is expected to
 * return the JSON-RPC response body that should be tunneled back to the CLI
 * inside the `control_response.success.response` slot. We model it as
 * `unknown` so the in-process MCP server (separate task) can return whatever
 * shape the JSON-RPC method requires; this layer doesn't introspect it.
 */
export type McpMessageResult = unknown;

/* -------------------------------------------------------------------------- */
/* `turn_input_required` event seam                                           */
/* -------------------------------------------------------------------------- */

/**
 * Minimal local shape of the §10.4 `turn_input_required` event. The downstream
 * EventMapping module (sibling task) defines its own variant with this shape;
 * we keep the local form small so this module doesn't depend on EventMapping
 * at compile time. The handler emits these via the optional
 * {@link ControlHandlers.turnInputRequiredQueue} when `can_use_tool` fires.
 */
export interface TurnInputRequiredEvent {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly blocked_path: string | null;
  readonly request_id: RequestId;
}

/* -------------------------------------------------------------------------- */
/* Handler bundle                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Pluggable per-subtype handlers. The dispatcher consumes inbound control
 * frames and routes them to the appropriate field. Each handler runs as its
 * own forked fiber so that handlers can run concurrently and a
 * `control_cancel_request` can target one without disturbing siblings.
 *
 * `onCancelRequest` runs after the dispatcher has already interrupted the
 * matching in-flight fiber (if any). It exists as a hook for callers that
 * want to log or surface cancellations; the default no-op is fine for v1.
 *
 * `turnInputRequiredQueue`, when present, receives a §10.4
 * `turn_input_required` event whenever a `can_use_tool` request arrives.
 * The default `canUseTool` denies regardless; the queue is purely an
 * observability seam consumed by the orchestrator's runtime-event stream.
 */
export interface ControlHandlers {
  readonly canUseTool: (
    req: CanUseToolRequest,
  ) => Effect.Effect<CanUseToolDecision, Error>;
  readonly mcpMessage: (
    req: McpMessageRequest,
  ) => Effect.Effect<McpMessageResult, Error>;
  readonly onCancelRequest: (reqId: RequestId) => Effect.Effect<void>;
  readonly turnInputRequiredQueue?: Queue.Enqueue<TurnInputRequiredEvent>;
}

/* -------------------------------------------------------------------------- */
/* Default handlers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Default `can_use_tool` handler: denies with `interrupt: true`. Matches v1's
 * "no human in loop" posture documented in `research/claude-stream-json.md`
 * §6 / §10.5.
 *
 * The dispatcher (see {@link serve}) emits the §10.4 `turn_input_required`
 * event onto `ControlHandlers.turnInputRequiredQueue` *before* invoking the
 * handler — so this default does not need to touch the queue itself, and a
 * caller who replaces it with a custom handler still gets the event emitted.
 */
export const defaultCanUseTool = (
  _req: CanUseToolRequest,
): Effect.Effect<CanUseToolDecision, Error> =>
  Effect.succeed({
    behavior: "deny",
    message: "Symphony v1: no human in loop",
    interrupt: true,
  });

/**
 * Default `mcp_message` handler: returns a `control_response.error` body. The
 * dispatcher converts a thrown `Error` into the on-the-wire error shape, so
 * we throw rather than returning a synthesized success body — that matches
 * the spec's "no MCP server available" error frame.
 */
export const defaultMcpMessage = (
  _req: McpMessageRequest,
): Effect.Effect<McpMessageResult, Error> =>
  Effect.fail(new Error("no MCP server available"));

/** Default cancel handler: no-op. Override to log / surface cancellations. */
export const defaultOnCancelRequest = (
  _reqId: RequestId,
): Effect.Effect<void> => Effect.void;

/**
 * Build a fully-defaulted handler bundle. Useful in tests and for callers
 * who only want to override one slot. Pass a `turnInputRequiredQueue` to
 * receive §10.4 `turn_input_required` events when the CLI fires
 * `can_use_tool`; the dispatcher emits onto it before invoking
 * `canUseTool` so even callers who override the handler still get the
 * event.
 */
export const defaultHandlers = (
  turnInputRequiredQueue?: Queue.Enqueue<TurnInputRequiredEvent>,
): ControlHandlers => ({
  canUseTool: defaultCanUseTool,
  mcpMessage: defaultMcpMessage,
  onCancelRequest: defaultOnCancelRequest,
  ...(turnInputRequiredQueue !== undefined
    ? { turnInputRequiredQueue }
    : {}),
});

/* -------------------------------------------------------------------------- */
/* Outbound request id generator                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a request-id generator producing ids of the form `req_<counter>_<hex>`
 * per the Python SDK source (`_internal/query.py`). Symphony does not
 * currently initiate any control requests in v1 (the streaming-mode CLI
 * sends `initialize` transparently), so this exists for symmetry with the
 * SDK and as a building block for future host-initiated frames.
 */
export const makeRequestIdGenerator = (): Effect.Effect<
  Effect.Effect<RequestId>
> =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0);
    return Effect.gen(function* () {
      const next = yield* Ref.updateAndGet(counter, (n) => n + 1);
      // 4 hex chars ≈ 16 bits of entropy — matches the SDK source format.
      const hex = Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, "0");
      return `req_${next}_${hex}` as RequestId;
    });
  });

/* -------------------------------------------------------------------------- */
/* Frame builders                                                             */
/* -------------------------------------------------------------------------- */

/** Build a `control_response.success` frame echoing the incoming request id. */
const buildSuccessFrame = (
  requestId: string,
  response: unknown,
): OutboundControlResponse => ({
  type: "control_response",
  response: {
    subtype: "success",
    request_id: requestId,
    ...(response !== undefined ? { response } : {}),
  },
});

/** Build a `control_response.error` frame echoing the incoming request id. */
const buildErrorFrame = (
  requestId: string,
  error: string,
): OutboundControlResponse => ({
  type: "control_response",
  response: {
    subtype: "error",
    request_id: requestId,
    error,
  },
});

/* -------------------------------------------------------------------------- */
/* Per-request handler invocation                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run a single `control_request` to completion: dispatch on subtype, build a
 * `control_response` frame, and push it onto the outgoing queue. If the
 * fiber is interrupted (because a `control_cancel_request` arrived), the
 * outbound write is skipped — the spec calls for "no `control_response` for
 * that ID" in the cancel case.
 */
const handleOne = (
  frame: ControlRequest,
  handlers: ControlHandlers,
  outgoing: Queue.Enqueue<OutboundFrame>,
): Effect.Effect<void, never, Logger> =>
  Effect.gen(function* () {
    const log = yield* Logger;
    const requestId = frame.request_id;

    const writeResponse = (
      response: OutboundControlResponse,
    ): Effect.Effect<void> =>
      // `Queue.offer` returns boolean (capacity), and a shut-down queue
      // simply rejects the offer. We don't propagate that — the
      // subprocess shutdown finalizer is what owns queue lifecycle.
      Effect.asVoid(Queue.offer(outgoing, response));

    const body = frame.request;
    if (isCanUseTool(body)) {
      // Diagnostic logging per spec §6: log the tool name, input, and
      // any blocked_path so operators can audit denials.
      yield* log.info({
        msg: "can_use_tool request received",
        request_id: requestId,
        tool_name: body.tool_name,
        tool_input: body.input,
        blocked_path: body.blocked_path ?? null,
      });
      // Emit the §10.4 `turn_input_required` event with the real
      // request_id (the default handler can't see it from inside).
      if (handlers.turnInputRequiredQueue !== undefined) {
        yield* Queue.offer(handlers.turnInputRequiredQueue, {
          tool_name: body.tool_name,
          tool_input: body.input,
          blocked_path: body.blocked_path ?? null,
          request_id: requestId as RequestId,
        });
      }
      const exit = yield* Effect.exit(handlers.canUseTool(body));
      if (Exit.isSuccess(exit)) {
        yield* writeResponse(buildSuccessFrame(requestId, exit.value));
      } else {
        if (exit.cause._tag === "Interrupt") {
          // Interrupted by a cancel: skip the response write entirely.
          return;
        }
        yield* writeResponse(
          buildErrorFrame(requestId, formatCause(exit.cause)),
        );
      }
      return;
    }
    if (isMcpMessage(body)) {
      const exit = yield* Effect.exit(handlers.mcpMessage(body));
      if (Exit.isSuccess(exit)) {
        yield* writeResponse(buildSuccessFrame(requestId, exit.value));
      } else {
        if (exit.cause._tag === "Interrupt") {
          return;
        }
        yield* writeResponse(
          buildErrorFrame(requestId, formatCause(exit.cause)),
        );
      }
      return;
    }
    if (isInitialize(body)) {
      // The streaming-mode CLI sends `initialize` transparently — Symphony
      // does not need to respond. If we ever do see one (older CLI?),
      // ack with an empty success body so the CLI doesn't stall.
      yield* log.debug({
        msg: "initialize control_request received; acking with empty success",
        request_id: requestId,
      });
      yield* writeResponse(buildSuccessFrame(requestId, {}));
      return;
    }
    // Unknown / forward-compat subtype — surface as an error so the CLI
    // doesn't hang waiting for a response.
    yield* log.warn({
      msg: "unknown control_request subtype; responding with error",
      request_id: requestId,
      subtype: body.subtype,
    });
    yield* writeResponse(
      buildErrorFrame(
        requestId,
        `unsupported control_request subtype: ${body.subtype}`,
      ),
    );
  });

/**
 * Best-effort string rendering of a failure cause. `Cause` has structured
 * accessors but for the wire `error: string` field we just want a readable
 * one-liner — the `Error` object's message is the most useful single field.
 */
const formatCause = (cause: unknown): string => {
  // The cause for a typed failure is usually `{ _tag: "Fail", error: <E> }`.
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause as { _tag: unknown })._tag === "Fail" &&
    "error" in cause
  ) {
    const err = (cause as { error: unknown }).error;
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  if (cause instanceof Error) return cause.message;
  return String(cause);
};

/* -------------------------------------------------------------------------- */
/* Public dispatcher                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fork the control-protocol consumer fiber. Returns once the fiber has been
 * forked into the surrounding scope; the fiber itself runs until
 * `subprocess.incoming` EOFs (typically when the subprocess exits).
 *
 * The returned Effect requires only `Scope` as a context dependency at the
 * type level — `Logger` is provided implicitly via the `subprocess` shape's
 * own context expectations. Callers running inside an `Effect.scoped` block
 * with a `Logger` layer will get the right wiring automatically.
 */
export const serve = (
  subprocess: Pick<ClaudeSubprocess, "incoming" | "outgoing">,
  handlers: ControlHandlers,
): Effect.Effect<void, never, Logger | Scope.Scope> =>
  Effect.gen(function* () {
    const log = yield* Logger;
    // Map of in-flight handler fibers keyed by request_id. A
    // `control_cancel_request` looks up the entry and interrupts the fiber;
    // the fiber's own ensuring removes the entry on natural completion.
    const inflight = yield* Ref.make(
      new Map<string, Fiber.RuntimeFiber<void, never>>(),
    );

    // `subprocess.incoming` has error type `never` (see ClaudeSubprocess) —
    // failures are surfaced via the parser/decoder warnings inside the
    // subprocess module rather than as stream errors. So `runForEach` here
    // produces an Effect with `never` failure too, and no extra catchAll
    // is required.
    const consumer = subprocess.incoming.pipe(
      Stream.runForEach((frame) =>
        Effect.gen(function* () {
          if (isControlRequest(frame)) {
            const requestId = frame.request_id;
            // Build the per-request effect, ensuring it removes itself
            // from the inflight map on completion (success, failure, or
            // interrupt). The interrupt-skip-response logic lives in
            // handleOne so the map cleanup runs unconditionally here.
            const handlerEffect = handleOne(
              frame,
              handlers,
              subprocess.outgoing,
            ).pipe(
              Effect.ensuring(
                Ref.update(inflight, (m) => {
                  const next = new Map(m);
                  next.delete(requestId);
                  return next;
                }),
              ),
            );
            // `forkScoped` (not `fork`) so the handler's lifetime is tied
            // to the surrounding `Effect.scoped` block rather than to the
            // consumer fiber. Without this, when `subprocess.incoming` EOFs
            // the consumer fiber completes and its child fibers (the
            // handlers) get interrupted before they can write their
            // responses — manifests as missing outbound frames in tests
            // that feed a finite `Stream.fromIterable`.
            const fiber = yield* Effect.forkScoped(handlerEffect);
            yield* Ref.update(inflight, (m) =>
              new Map(m).set(requestId, fiber),
            );
          } else if (isControlCancelRequest(frame)) {
            const requestId = frame.request_id;
            const m = yield* Ref.get(inflight);
            const fiber = m.get(requestId);
            // Always invoke onCancelRequest, even if no fiber matches —
            // callers may want to surface a stale cancel for diagnostics.
            yield* handlers.onCancelRequest(requestId as RequestId);
            if (fiber !== undefined) {
              // Remove first so a concurrent natural completion doesn't
              // double-handle. Then interrupt; the handler's
              // interrupt-skip-response branch suppresses the outbound
              // frame, matching the spec's no-response-on-cancel rule.
              yield* Ref.update(inflight, (current) => {
                const next = new Map(current);
                next.delete(requestId);
                return next;
              });
              yield* Fiber.interrupt(fiber);
            } else {
              yield* log.debug({
                msg: "control_cancel_request for unknown request_id; ignoring",
                request_id: requestId,
              });
            }
          }
          // Non-control frames are ignored here — the EventMapping layer
          // (sibling task) consumes the same incoming stream for those.
        }),
      ),
    );

    yield* Effect.forkScoped(consumer);
  });
