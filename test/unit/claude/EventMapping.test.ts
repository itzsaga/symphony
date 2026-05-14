// Unit tests for src/claude/EventMapping.ts — pure-function reducer behavior.
// Covers spec §10.4 emitted-event mapping + §13.5 token-accounting semantics.
import { describe, expect, it } from "bun:test";
import { Schema } from "effect";
import {
  initialClaudeSessionState,
  Malformed,
  mapFrame,
  synthesizeSessionId,
  TurnCancelled,
  TurnInputRequired,
  UnsupportedToolCall,
  type Notification,
  type RuntimeEvent,
  type TextDelta,
  type ToolCallCompleted,
} from "../../../src/claude/EventMapping.ts";
import {
  StreamJsonMessage,
  type StreamJsonMessage as StreamJsonMessageType,
} from "../../../src/claude/StreamJson.ts";

const decode = (input: unknown): StreamJsonMessageType =>
  Schema.decodeUnknownSync(StreamJsonMessage)(input);

/** Find the first event with the given `_tag` in a result list. */
const find = <T extends RuntimeEvent["_tag"]>(
  events: ReadonlyArray<RuntimeEvent>,
  tag: T,
): Extract<RuntimeEvent, { _tag: T }> | undefined =>
  events.find((e): e is Extract<RuntimeEvent, { _tag: T }> => e._tag === tag);

describe("synthesizeSessionId", () => {
  it("composes thread_id and turn_id with a hyphen separator", () => {
    expect(synthesizeSessionId("abc", 3)).toBe("abc-3");
  });

  it("works for zero turn_id", () => {
    expect(synthesizeSessionId("abc", 0)).toBe("abc-0");
  });
});

describe("mapFrame — system.init", () => {
  it("emits SessionStarted with session_id, model, plugins, plugin_errors extracted", () => {
    const frame = decode({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      session_id: "thread-uuid-1",
      plugins: [{ name: "p1", path: "/tmp/p1" }],
    });

    const { events, newState } = mapFrame(frame, initialClaudeSessionState);

    const started = find(events, "SessionStarted");
    expect(started).toBeDefined();
    expect(started?.session_id).toBe("thread-uuid-1");
    expect(started?.model).toBe("claude-opus-4-7");
    expect(started?.plugins).toEqual([{ name: "p1", path: "/tmp/p1" }]);
    expect(started?.plugin_errors).toEqual([]);

    expect(newState.thread_id).toBe("thread-uuid-1");
    expect(newState.model).toBe("claude-opus-4-7");
    expect(newState.last_event).toBe("SessionStarted");
    expect(newState.last_event_at).toBeInstanceOf(Date);
  });

  it("emits SessionStarted AND a warn-level Notification per plugin_errors entry", () => {
    const frame = decode({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      session_id: "thread-uuid-2",
      plugins: [{ name: "p1", path: "/tmp/p1" }],
      plugin_errors: [
        { plugin: "p2", type: "load_failed", message: "missing path" },
        { plugin: "p3", type: "version_mismatch", message: "needs >=2.0" },
      ],
    });

    const { events } = mapFrame(frame, initialClaudeSessionState);

    const started = find(events, "SessionStarted");
    expect(started).toBeDefined();
    expect(started?.plugin_errors.length).toBe(2);

    const notes = events.filter(
      (e): e is Notification => e._tag === "Notification",
    );
    expect(notes.length).toBe(2);
    expect(notes[0]?.level).toBe("warn");
    expect(notes[0]?.source).toBe("plugin_load");
    expect(notes[0]?.message).toContain("p2");
    expect(notes[0]?.message).toContain("missing path");
    expect(notes[1]?.message).toContain("p3");
  });

  it("treats plugin_errors as empty when the key is omitted", () => {
    const frame = decode({
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      session_id: "thread-uuid-3",
      plugins: [],
    });

    const { events } = mapFrame(frame, initialClaudeSessionState);

    const started = find(events, "SessionStarted");
    expect(started?.plugin_errors).toEqual([]);
    expect(events.some((e) => e._tag === "Notification")).toBe(false);
  });
});

describe("mapFrame — result", () => {
  const seedAfterInit = {
    ...initialClaudeSessionState,
    thread_id: "thread-1",
    model: "claude-opus-4-7",
  };

  it("emits TurnCompleted on subtype:'success' with num_turns/total_cost_usd/duration_ms", () => {
    const frame = decode({
      type: "result",
      subtype: "success",
      duration_ms: 12345,
      duration_api_ms: 9876,
      is_error: false,
      num_turns: 1,
      session_id: "thread-1",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    const { events, newState } = mapFrame(frame, seedAfterInit);

    const completed = find(events, "TurnCompleted");
    expect(completed).toBeDefined();
    expect(completed?.duration_ms).toBe(12345);
    expect(completed?.duration_api_ms).toBe(9876);
    expect(completed?.num_turns).toBe(1);
    expect(completed?.total_cost_usd).toBe(0.0123);
    expect(completed?.thread_id).toBe("thread-1");
    expect(completed?.turn_id).toBe(1);
    expect(completed?.session_id).toBe("thread-1-1");

    // UsageReport is a sibling event when usage is present.
    const usage = find(events, "UsageReport");
    expect(usage).toBeDefined();
    expect(usage?.usage.input_tokens).toBe(100);

    expect(newState.latest_turn_id).toBe(1);
    expect(newState.turn_count).toBe(1);
    expect(newState.last_event).toBe("TurnCompleted");
  });

  it("emits TurnFailed on is_error:true with subtype:'error_max_turns'", () => {
    const frame = decode({
      type: "result",
      subtype: "error_max_turns",
      duration_ms: 5000,
      duration_api_ms: 4000,
      is_error: true,
      num_turns: 5,
      session_id: "thread-1",
      errors: ["max turns reached"],
    });

    const { events, newState } = mapFrame(frame, seedAfterInit);

    const failed = find(events, "TurnFailed");
    expect(failed).toBeDefined();
    expect(failed?.subtype).toBe("error_max_turns");
    expect(failed?.errors).toEqual(["max turns reached"]);
    expect(failed?.turn_id).toBe(5);
    expect(failed?.session_id).toBe("thread-1-5");
    // No UsageReport on failed turns (defensive: spec wants TurnFailed alone).
    expect(events.some((e) => e._tag === "UsageReport")).toBe(false);

    expect(newState.last_event).toBe("TurnFailed");
    expect(newState.turn_count).toBe(1);
  });

  it("emits StartupFailed when an error result arrives before any system.init", () => {
    const frame = decode({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 100,
      duration_api_ms: 50,
      is_error: true,
      num_turns: 0,
      session_id: "thread-x",
      errors: ["init crashed"],
    });

    // No init seen yet → state.thread_id is null.
    const { events } = mapFrame(frame, initialClaudeSessionState);
    const failed = find(events, "StartupFailed");
    expect(failed).toBeDefined();
    expect(failed?.subtype).toBe("error_during_execution");
    expect(failed?.errors).toEqual(["init crashed"]);
    // No TurnFailed should be emitted in this branch.
    expect(events.some((e) => e._tag === "TurnFailed")).toBe(false);
  });
});

describe("mapFrame — assistant", () => {
  const seedAfterInit = {
    ...initialClaudeSessionState,
    thread_id: "thread-1",
    latest_turn_id: 1,
    model: "claude-opus-4-7",
  };

  it("emits TurnEndedWithError when assistant.error is set (e.g. 'rate_limit')", () => {
    const frame = decode({
      type: "assistant",
      session_id: "thread-1",
      error: "rate_limit",
      message: {
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "partial response" }],
      },
    });

    const { events } = mapFrame(frame, seedAfterInit);

    const errored = find(events, "TurnEndedWithError");
    expect(errored).toBeDefined();
    expect(errored?.error).toBe("rate_limit");
    expect(errored?.thread_id).toBe("thread-1");
    expect(errored?.turn_id).toBe(1);
  });

  it("emits ToolCallStarted per tool_use block; ApprovalAutoApproved when bypass_permissions is set", () => {
    const frame = decode({
      type: "assistant",
      session_id: "thread-1",
      message: {
        model: "claude-opus-4-7",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    });

    const without = mapFrame(frame, seedAfterInit);
    expect(find(without.events, "ToolCallStarted")).toBeDefined();
    expect(without.events.some((e) => e._tag === "ApprovalAutoApproved")).toBe(
      false,
    );

    const withBypass = mapFrame(frame, seedAfterInit, {
      bypass_permissions: true,
    });
    const auto = find(withBypass.events, "ApprovalAutoApproved");
    expect(auto).toBeDefined();
    expect(auto?.tool_name).toBe("Bash");
    expect(auto?.tool_use_id).toBe("toolu_1");
  });

  it("emits TextDelta for non-empty text blocks and updates last_message", () => {
    const frame = decode({
      type: "assistant",
      session_id: "thread-1",
      message: {
        model: "claude-opus-4-7",
        content: [
          { type: "text", text: "hello world" },
          { type: "text", text: "" }, // empty text — skipped
        ],
      },
    });

    const { events, newState } = mapFrame(frame, seedAfterInit);
    const deltas = events.filter(
      (e): e is TextDelta => e._tag === "TextDelta",
    );
    expect(deltas.length).toBe(1);
    expect(deltas[0]?.text).toBe("hello world");
    expect(newState.last_message).toBe("hello world");
  });
});

describe("mapFrame — user", () => {
  it("emits ToolCallCompleted per tool_result block", () => {
    const frame = decode({
      type: "user",
      session_id: "thread-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "ok",
            is_error: false,
          },
          {
            type: "tool_result",
            tool_use_id: "toolu_2",
            content: "boom",
            is_error: true,
          },
        ],
      },
    });

    const { events } = mapFrame(frame, initialClaudeSessionState);
    const completed = events.filter(
      (e): e is ToolCallCompleted => e._tag === "ToolCallCompleted",
    );
    expect(completed.length).toBe(2);
    expect(completed[0]?.tool_use_id).toBe("toolu_1");
    expect(completed[0]?.is_error).toBe(false);
    expect(completed[1]?.is_error).toBe(true);
  });

  it("emits no events for a string-content user prompt (the host's own message)", () => {
    const frame = decode({
      type: "user",
      message: { role: "user", content: "hi" },
    });
    const { events, newState } = mapFrame(frame, initialClaudeSessionState);
    expect(events).toEqual([]);
    expect(newState).toBe(initialClaudeSessionState);
  });
});

describe("mapFrame — system.api_retry", () => {
  it("emits ApiRetrying and updates last_event/last_event_at without failing the run", () => {
    const seedDuringTurn = {
      ...initialClaudeSessionState,
      thread_id: "thread-1",
      latest_turn_id: 1,
      turn_count: 0,
    };
    const frame = decode({
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 5,
      retry_delay_ms: 2000,
      error_status: 429,
      error: "rate_limit",
      uuid: "evt-1",
      session_id: "thread-1",
    });

    const { events, newState } = mapFrame(frame, seedDuringTurn);

    const retry = find(events, "ApiRetrying");
    expect(retry).toBeDefined();
    expect(retry?.attempt).toBe(1);
    expect(retry?.max_retries).toBe(5);
    expect(retry?.retry_delay_ms).toBe(2000);
    expect(retry?.error_status).toBe(429);
    expect(retry?.error).toBe("rate_limit");

    // No turn-failure side-effects (`turn_count` unchanged), but
    // last_event/last_event_at must update for dashboard visibility.
    expect(newState.turn_count).toBe(0);
    expect(newState.last_event).toBe("ApiRetrying");
    expect(newState.last_event_at).toBeInstanceOf(Date);
    // No TurnFailed emitted.
    expect(events.some((e) => e._tag === "TurnFailed")).toBe(false);
  });
});

describe("mapFrame — token accounting (§13.5)", () => {
  it("two consecutive result frames replace (not add) absolute totals; last_reported_* untouched", () => {
    const seed = {
      ...initialClaudeSessionState,
      thread_id: "thread-1",
    };

    const first = decode({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      session_id: "thread-1",
      usage: { input_tokens: 100, output_tokens: 40 },
    });
    const afterFirst = mapFrame(first, seed).newState;
    expect(afterFirst.claude_input_tokens).toBe(100);
    expect(afterFirst.claude_output_tokens).toBe(40);
    expect(afterFirst.claude_total_tokens).toBe(140);
    // last_reported_* must remain at zero — the orchestrator owns that flush.
    expect(afterFirst.last_reported_input_tokens).toBe(0);
    expect(afterFirst.last_reported_output_tokens).toBe(0);
    expect(afterFirst.last_reported_total_tokens).toBe(0);

    const second = decode({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 2,
      session_id: "thread-1",
      usage: { input_tokens: 250, output_tokens: 90 },
    });
    const afterSecond = mapFrame(second, afterFirst).newState;
    // Replace, not add: the absolute total at end of turn 2 is 250, not 350.
    expect(afterSecond.claude_input_tokens).toBe(250);
    expect(afterSecond.claude_output_tokens).toBe(90);
    expect(afterSecond.claude_total_tokens).toBe(340);
    // Still untouched by the reducer.
    expect(afterSecond.last_reported_input_tokens).toBe(0);
    expect(afterSecond.last_reported_output_tokens).toBe(0);
    expect(afterSecond.last_reported_total_tokens).toBe(0);
  });

  it("includes cache_creation_input_tokens + cache_read_input_tokens in claude_total_tokens", () => {
    const seed = { ...initialClaudeSessionState, thread_id: "thread-1" };
    const frame = decode({
      type: "result",
      subtype: "success",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      session_id: "thread-1",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 15,
      },
    });
    const { newState } = mapFrame(frame, seed);
    expect(newState.claude_input_tokens).toBe(10);
    expect(newState.claude_output_tokens).toBe(20);
    expect(newState.claude_total_tokens).toBe(50);
  });

  it("does not increment claude_*_tokens from per-assistant-message usage", () => {
    const seed = {
      ...initialClaudeSessionState,
      thread_id: "thread-1",
      claude_input_tokens: 100,
      claude_output_tokens: 40,
      claude_total_tokens: 140,
    };
    const frame = decode({
      type: "assistant",
      session_id: "thread-1",
      message: {
        model: "claude-opus-4-7",
        usage: { input_tokens: 999, output_tokens: 999 },
        content: [{ type: "text", text: "ack" }],
      },
    });
    const { newState } = mapFrame(frame, seed);
    expect(newState.claude_input_tokens).toBe(100);
    expect(newState.claude_output_tokens).toBe(40);
    expect(newState.claude_total_tokens).toBe(140);
  });
});

describe("mapFrame — rate_limit_event", () => {
  it("updates latest_rate_limit on the session state and emits RateLimit", () => {
    const frame = decode({
      type: "rate_limit_event",
      uuid: "evt-1",
      session_id: "thread-1",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1730000000,
        rateLimitType: "five_hour",
        utilization: 0.95,
      },
    });

    const { events, newState } = mapFrame(frame, initialClaudeSessionState);
    const evt = find(events, "RateLimit");
    expect(evt).toBeDefined();
    expect(evt?.info.status).toBe("allowed_warning");
    expect(evt?.info.rate_limit_type).toBe("five_hour");

    expect(newState.latest_rate_limit).toBeDefined();
    expect(newState.latest_rate_limit?.status).toBe("allowed_warning");
    expect(newState.last_event).toBe("RateLimit");
  });
});

describe("mapFrame — stream_event", () => {
  it("emits TextDelta for an Anthropic content_block_delta(text_delta) event", () => {
    const frame = decode({
      type: "stream_event",
      uuid: "evt-1",
      session_id: "thread-1",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "hi" },
      },
    });
    const seed = { ...initialClaudeSessionState, thread_id: "thread-1" };
    const { events, newState } = mapFrame(frame, seed);
    const delta = find(events, "TextDelta");
    expect(delta).toBeDefined();
    expect(delta?.text).toBe("hi");
    expect(delta?.thread_id).toBe("thread-1");
    expect(newState.last_event).toBe("TextDelta");
  });

  it("falls through to a Notification for non-text-delta stream events", () => {
    const frame = decode({
      type: "stream_event",
      uuid: "evt-2",
      session_id: "thread-1",
      event: { type: "message_start" },
    });
    const { events } = mapFrame(frame, initialClaudeSessionState);
    const notif = find(events, "Notification");
    expect(notif).toBeDefined();
    expect(notif?.source).toBe("stream_event");
  });
});

describe("mapFrame — unmapped / forward-compat frames", () => {
  it("emits OtherMessage for an unknown top-level frame type (UnknownFrame catch-all)", () => {
    const frame = decode({
      type: "future_message_kind_we_havent_seen_yet",
      data: { foo: "bar" },
    });
    const { events, newState } = mapFrame(frame, initialClaudeSessionState);
    const other = find(events, "OtherMessage");
    expect(other).toBeDefined();
    expect(other?.type).toBe("future_message_kind_we_havent_seen_yet");
    expect(newState.last_event).toBe("OtherMessage");
  });

  it("emits OtherMessage for SystemUnknownMessage subtypes (e.g. autocompact)", () => {
    const frame = decode({
      type: "system",
      subtype: "autocompact_started",
      session_id: "thread-1",
    });
    const { events } = mapFrame(frame, initialClaudeSessionState);
    const other = find(events, "OtherMessage");
    expect(other).toBeDefined();
    expect(other?.type).toBe("system");
    expect(other?.subtype).toBe("autocompact_started");
  });

  it("emits OtherMessage for control-protocol frames (ControlProtocol owns them)", () => {
    const frame = decode({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_1",
      },
    });
    const { events } = mapFrame(frame, initialClaudeSessionState);
    const other = find(events, "OtherMessage");
    expect(other).toBeDefined();
    expect(other?.type).toBe("control_response");
  });
});

describe("RuntimeEvent constructors (synthesized events)", () => {
  it("TurnCancelled, TurnInputRequired, UnsupportedToolCall, Malformed are constructible", () => {
    // These constructors are exported so ControlProtocol / orchestrator code
    // can synthesize events without owning the wire-mapping logic.
    const cancelled = new TurnCancelled({
      thread_id: "thread-1",
      turn_id: 2,
      request_id: "req_1",
      reason: "user requested",
    });
    expect(cancelled._tag).toBe("TurnCancelled");
    expect(cancelled.thread_id).toBe("thread-1");

    const inputReq = new TurnInputRequired({
      thread_id: "thread-1",
      turn_id: 2,
      request_id: "req_2",
      tool_name: "Bash",
      tool_use_id: "toolu_x",
      input: { command: "rm -rf /" },
      title: "Allow Bash?",
      description: null,
    });
    expect(inputReq._tag).toBe("TurnInputRequired");
    expect(inputReq.tool_name).toBe("Bash");

    const unsupported = new UnsupportedToolCall({
      tool_name: "mystery_tool",
      tool_use_id: "toolu_y",
      error_text: "not in advertised set",
    });
    expect(unsupported._tag).toBe("UnsupportedToolCall");

    const malformed = new Malformed({
      reason: "buffer overflow",
      raw: null,
    });
    expect(malformed._tag).toBe("Malformed");
  });
});
