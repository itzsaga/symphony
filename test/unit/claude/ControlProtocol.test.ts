// Unit tests for src/claude/ControlProtocol.ts.
// Drives the dispatcher with synthetic incoming streams and inspects the outgoing queue.
import { describe, expect, it } from "bun:test";
import {
  Chunk,
  Deferred,
  Effect,
  Queue,
  Stream,
} from "effect";
import {
  defaultHandlers,
  makeRequestIdGenerator,
  serve,
  type ControlHandlers,
  type TurnInputRequiredEvent,
} from "../../../src/claude/ControlProtocol.ts";
import type { OutboundFrame } from "../../../src/claude/ClaudeSubprocess.ts";
import type {
  CanUseToolRequest,
  ControlRequest,
  ControlCancelRequest,
  McpMessageRequest,
  RequestId,
  StreamJsonMessage,
} from "../../../src/claude/StreamJson.ts";
import { LoggerLive } from "../../../src/observability/Logger.ts";

/* -------------------------------------------------------------------------- */
/* Frame fixtures                                                             */
/* -------------------------------------------------------------------------- */

const canUseToolFrame = (
  requestId: string,
  patch: Partial<CanUseToolRequest> = {},
): ControlRequest => ({
  type: "control_request",
  request_id: requestId,
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "rm -rf /" },
    ...patch,
  },
});

const mcpMessageFrame = (
  requestId: string,
  message: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" },
): ControlRequest => ({
  type: "control_request",
  request_id: requestId,
  request: {
    subtype: "mcp_message",
    server_name: "symphony",
    message,
  },
});

const cancelFrame = (requestId: string): ControlCancelRequest => ({
  type: "control_cancel_request",
  request_id: requestId,
});

/* -------------------------------------------------------------------------- */
/* Test harness                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a fake subprocess shape: an `incoming` Stream of literal frames and
 * an `outgoing` Queue we can drain to assert what the dispatcher wrote back.
 *
 * Frames are passed through as-is — the spec says decoded frames arrive
 * already-narrowed via the StreamJson union, so no schema decoding here.
 */
const fakeSubprocess = (
  frames: ReadonlyArray<StreamJsonMessage>,
): Effect.Effect<{
  readonly incoming: Stream.Stream<StreamJsonMessage>;
  readonly outgoing: Queue.Queue<OutboundFrame>;
}> =>
  Effect.gen(function* () {
    const outgoing = yield* Queue.unbounded<OutboundFrame>();
    return {
      incoming: Stream.fromIterable(frames),
      outgoing,
    };
  });

/**
 * Build a fake subprocess whose incoming stream is fed from a queue we
 * control — useful for tests that need to interleave frames with assertions
 * (e.g. cancel-mid-handler scenarios).
 */
const queuedFakeSubprocess = (): Effect.Effect<{
  readonly incoming: Stream.Stream<StreamJsonMessage>;
  readonly outgoing: Queue.Queue<OutboundFrame>;
  readonly inbound: Queue.Queue<StreamJsonMessage>;
}> =>
  Effect.gen(function* () {
    const inbound = yield* Queue.unbounded<StreamJsonMessage>();
    const outgoing = yield* Queue.unbounded<OutboundFrame>();
    return {
      incoming: Stream.fromQueue(inbound),
      outgoing,
      inbound,
    };
  });

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe("ControlProtocol — can_use_tool", () => {
  it("default handler denies with interrupt:true and emits turn_input_required", async () => {
    const requestId = "req_1_aaaa";

    const program = Effect.scoped(
      Effect.gen(function* () {
        const turnQueue = yield* Queue.unbounded<TurnInputRequiredEvent>();
        const handlers = defaultHandlers(turnQueue);

        const sub = yield* fakeSubprocess([canUseToolFrame(requestId)]);
        yield* serve(sub, handlers);

        // Wait for the dispatcher to write its single response.
        const frame = yield* Queue.take(sub.outgoing);
        const event = yield* Queue.take(turnQueue);
        return { frame, event };
      }),
    ).pipe(Effect.provide(LoggerLive));

    const { frame, event } = await Effect.runPromise(program);

    expect(frame.type).toBe("control_response");
    if (frame.type !== "control_response") throw new Error("unreachable");
    expect(frame.response.subtype).toBe("success");
    if (frame.response.subtype !== "success") throw new Error("unreachable");
    expect(frame.response.request_id).toBe(requestId);
    const body = frame.response.response as {
      readonly behavior: string;
      readonly message: string;
      readonly interrupt: boolean;
    };
    expect(body.behavior).toBe("deny");
    expect(body.message).toBe("Symphony v1: no human in loop");
    expect(body.interrupt).toBe(true);

    expect(event.tool_name).toBe("Bash");
    expect(event.tool_input).toEqual({ command: "rm -rf /" });
    expect(event.blocked_path).toBeNull();
    expect(event.request_id).toBe(requestId as RequestId);
  });

  it("propagates blocked_path on the emitted turn_input_required event", async () => {
    const requestId = "req_2_bbbb";
    const program = Effect.scoped(
      Effect.gen(function* () {
        const turnQueue = yield* Queue.unbounded<TurnInputRequiredEvent>();
        const handlers = defaultHandlers(turnQueue);
        const sub = yield* fakeSubprocess([
          canUseToolFrame(requestId, {
            tool_name: "Read",
            input: { path: "/etc/passwd" },
            blocked_path: "/etc/passwd",
          }),
        ]);
        yield* serve(sub, handlers);
        yield* Queue.take(sub.outgoing);
        return yield* Queue.take(turnQueue);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const event = await Effect.runPromise(program);
    expect(event.blocked_path).toBe("/etc/passwd");
    expect(event.tool_name).toBe("Read");
  });
});

describe("ControlProtocol — mcp_message", () => {
  it("routes to the handler and returns success with the handler result", async () => {
    const requestId = "req_3_cccc";
    const handlerResult = {
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "linear_graphql" }] },
    };

    const handlers: ControlHandlers = {
      ...defaultHandlers(),
      mcpMessage: (req: McpMessageRequest) =>
        Effect.gen(function* () {
          // Sanity check the handler sees the inbound message verbatim.
          expect(req.subtype).toBe("mcp_message");
          return handlerResult;
        }),
    };

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* fakeSubprocess([mcpMessageFrame(requestId)]);
        yield* serve(sub, handlers);
        return yield* Queue.take(sub.outgoing);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const frame = await Effect.runPromise(program);
    expect(frame.type).toBe("control_response");
    if (frame.type !== "control_response") throw new Error("unreachable");
    expect(frame.response.subtype).toBe("success");
    if (frame.response.subtype !== "success") throw new Error("unreachable");
    expect(frame.response.request_id).toBe(requestId);
    expect(frame.response.response).toEqual(handlerResult);
  });

  it("default mcp handler returns a no-MCP-server-available error frame", async () => {
    const requestId = "req_4_dddd";
    const program = Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* fakeSubprocess([mcpMessageFrame(requestId)]);
        yield* serve(sub, defaultHandlers());
        return yield* Queue.take(sub.outgoing);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const frame = await Effect.runPromise(program);
    expect(frame.type).toBe("control_response");
    if (frame.type !== "control_response") throw new Error("unreachable");
    expect(frame.response.subtype).toBe("error");
    if (frame.response.subtype !== "error") throw new Error("unreachable");
    expect(frame.response.request_id).toBe(requestId);
    expect(frame.response.error).toBe("no MCP server available");
  });

  it("two parallel mcp_message handlers each produce their own response", async () => {
    const requestIdA = "req_5_eeee";
    const requestIdB = "req_6_ffff";

    // Handlers awaiting deferreds force them to interleave: A starts, B
    // starts, both complete. If the dispatcher serialized them, neither
    // could complete until we released the first deferred.
    const program = Effect.scoped(
      Effect.gen(function* () {
        const releaseA = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const startedA = yield* Deferred.make<void>();
        const startedB = yield* Deferred.make<void>();

        const handlers: ControlHandlers = {
          ...defaultHandlers(),
          mcpMessage: (req: McpMessageRequest) =>
            Effect.gen(function* () {
              const message = req.message as { readonly id: number };
              if (message.id === 1) {
                yield* Deferred.succeed(startedA, void 0);
                yield* Deferred.await(releaseA);
                return { id: 1, ok: "A" };
              }
              yield* Deferred.succeed(startedB, void 0);
              yield* Deferred.await(releaseB);
              return { id: 2, ok: "B" };
            }),
        };

        const sub = yield* fakeSubprocess([
          mcpMessageFrame(requestIdA, {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
          }),
          mcpMessageFrame(requestIdB, {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
          }),
        ]);
        yield* serve(sub, handlers);

        // Both handlers must have started before we release either —
        // proves the dispatcher forks rather than serializing.
        yield* Deferred.await(startedA);
        yield* Deferred.await(startedB);

        // Release in reverse order to make sure the responses land
        // independently of arrival order.
        yield* Deferred.succeed(releaseB, void 0);
        yield* Deferred.succeed(releaseA, void 0);

        const frame1 = yield* Queue.take(sub.outgoing);
        const frame2 = yield* Queue.take(sub.outgoing);
        return [frame1, frame2];
      }),
    ).pipe(Effect.provide(LoggerLive));

    const frames = await Effect.runPromise(program);
    expect(frames.length).toBe(2);
    const byId = new Map<string, OutboundFrame>();
    for (const f of frames) {
      if (f.type !== "control_response") throw new Error("unreachable");
      if (f.response.subtype !== "success") throw new Error("unreachable");
      byId.set(f.response.request_id, f);
    }
    expect(byId.size).toBe(2);
    const a = byId.get(requestIdA);
    const b = byId.get(requestIdB);
    if (!a || !b) throw new Error("missing response for one of the requests");
    if (a.type !== "control_response" || b.type !== "control_response") {
      throw new Error("unreachable");
    }
    if (a.response.subtype !== "success" || b.response.subtype !== "success") {
      throw new Error("unreachable");
    }
    expect(a.response.response).toEqual({ id: 1, ok: "A" });
    expect(b.response.response).toEqual({ id: 2, ok: "B" });
  });

  it("handler that fails returns control_response.error with the message", async () => {
    const requestId = "req_7_gggg";
    const handlers: ControlHandlers = {
      ...defaultHandlers(),
      mcpMessage: (_req) => Effect.fail(new Error("backend exploded")),
    };
    const program = Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* fakeSubprocess([mcpMessageFrame(requestId)]);
        yield* serve(sub, handlers);
        return yield* Queue.take(sub.outgoing);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const frame = await Effect.runPromise(program);
    expect(frame.type).toBe("control_response");
    if (frame.type !== "control_response") throw new Error("unreachable");
    expect(frame.response.subtype).toBe("error");
    if (frame.response.subtype !== "error") throw new Error("unreachable");
    expect(frame.response.request_id).toBe(requestId);
    expect(frame.response.error).toBe("backend exploded");
  });
});

describe("ControlProtocol — control_cancel_request", () => {
  it("interrupts the matching in-flight handler and emits no response for it", async () => {
    const requestId = "req_8_hhhh";

    const program = Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const handlers: ControlHandlers = {
          ...defaultHandlers(),
          mcpMessage: (_req) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0);
              // Sleep "forever" — only an interrupt should end this.
              yield* Effect.never;
              return { unreachable: true };
            }),
        };

        const sub = yield* queuedFakeSubprocess();
        yield* serve(sub, handlers);

        // Feed the request, wait until the handler has actually started.
        yield* Queue.offer(sub.inbound, mcpMessageFrame(requestId));
        yield* Deferred.await(started);

        // Cancel.
        yield* Queue.offer(sub.inbound, cancelFrame(requestId));

        // Give the dispatcher a moment to process the cancel and confirm
        // the outgoing queue stayed empty. We use a small Effect.sleep
        // rather than racing on a deferred so the test stays simple; the
        // assertion is "the queue is still empty after a yield".
        yield* Effect.sleep("50 millis");
        const size = yield* Queue.size(sub.outgoing);
        return size;
      }),
    ).pipe(Effect.provide(LoggerLive));

    const size = await Effect.runPromise(program);
    expect(size).toBe(0);
  });

  it("invokes onCancelRequest with the matching request_id", async () => {
    const requestId = "req_9_iiii";

    const program = Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const cancelled = yield* Deferred.make<RequestId>();

        const handlers: ControlHandlers = {
          ...defaultHandlers(),
          mcpMessage: (_req) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, void 0);
              yield* Effect.never;
              return { unreachable: true };
            }),
          onCancelRequest: (id) => Deferred.succeed(cancelled, id).pipe(Effect.asVoid),
        };

        const sub = yield* queuedFakeSubprocess();
        yield* serve(sub, handlers);
        yield* Queue.offer(sub.inbound, mcpMessageFrame(requestId));
        yield* Deferred.await(started);
        yield* Queue.offer(sub.inbound, cancelFrame(requestId));
        return yield* Deferred.await(cancelled);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const observed = await Effect.runPromise(program);
    expect(observed).toBe(requestId as RequestId);
  });
});

describe("ControlProtocol — non-control frames", () => {
  it("ignores non-control frames in the incoming stream", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* fakeSubprocess([
          {
            type: "system",
            subtype: "init",
            session_id: "sess-1",
            uuid: "u-1",
          } as StreamJsonMessage,
          {
            type: "result",
            subtype: "success",
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: false,
            num_turns: 1,
            session_id: "sess-1",
          } as StreamJsonMessage,
        ]);
        yield* serve(sub, defaultHandlers());
        // Drain anything that ended up on outgoing — should be nothing.
        yield* Effect.sleep("20 millis");
        return yield* Queue.takeAll(sub.outgoing);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const drained = await Effect.runPromise(program);
    expect(Chunk.size(drained)).toBe(0);
  });
});

describe("ControlProtocol — request id generator", () => {
  it("emits ids of the form req_<counter>_<4 hex>", async () => {
    const program = Effect.gen(function* () {
      const next = yield* makeRequestIdGenerator();
      const a = yield* next;
      const b = yield* next;
      return [a, b];
    });
    const [a, b] = await Effect.runPromise(program);
    expect(a).toMatch(/^req_1_[0-9a-f]{4}$/);
    expect(b).toMatch(/^req_2_[0-9a-f]{4}$/);
  });
});

describe("ControlProtocol — initialize ack", () => {
  it("acks initialize control_request with an empty success body", async () => {
    const requestId = "req_10_jjjj";
    const initFrame: ControlRequest = {
      type: "control_request",
      request_id: requestId,
      request: { subtype: "initialize" },
    };
    const program = Effect.scoped(
      Effect.gen(function* () {
        const sub = yield* fakeSubprocess([initFrame]);
        yield* serve(sub, defaultHandlers());
        return yield* Queue.take(sub.outgoing);
      }),
    ).pipe(Effect.provide(LoggerLive));

    const frame = await Effect.runPromise(program);
    expect(frame.type).toBe("control_response");
    if (frame.type !== "control_response") throw new Error("unreachable");
    expect(frame.response.subtype).toBe("success");
    if (frame.response.subtype !== "success") throw new Error("unreachable");
    expect(frame.response.request_id).toBe(requestId);
  });
});

