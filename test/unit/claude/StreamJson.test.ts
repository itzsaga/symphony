// Per-frame decode/encode tests for src/claude/StreamJson.ts.
// JSON fixtures are taken verbatim from research/claude-stream-json.md §2.
import { describe, expect, it } from "bun:test";
import { Either, Schema } from "effect";
import {
  AssistantMessage,
  ControlCancelRequest,
  ControlRequest,
  ControlResponse,
  OutboundControlCancelRequest,
  OutboundControlResponse,
  OutboundUserMessage,
  RateLimitEvent,
  ResultMessage,
  StreamEvent,
  StreamJsonMessage,
  SystemApiRetryMessage,
  SystemInitMessage,
  SystemMessage,
  SystemPluginInstallMessage,
  TranscriptMirror,
  UnknownFrame,
  UserMessage,
} from "../../../src/claude/StreamJson.ts";

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown): A =>
  Schema.decodeUnknownSync(schema)(input);

const tryDecode = <A, I>(
  schema: Schema.Schema<A, I>,
  input: unknown,
): Either.Either<A, unknown> =>
  Either.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (e) => e,
  });

describe("StreamJsonMessage — known frame types", () => {
  it("decodes a `user` frame with string content", () => {
    const frame = {
      type: "user",
      session_id: "sess-1",
      parent_tool_use_id: null,
      message: { role: "user", content: "the prompt text" },
    };
    const decoded = decode(UserMessage, frame);
    expect(decoded.type).toBe("user");
    expect(decoded.message.content).toBe("the prompt text");

    const viaUnion = decode(StreamJsonMessage, frame);
    expect(viaUnion.type).toBe("user");
  });

  it("decodes a `user` frame with multi-block content", () => {
    const frame = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "instructions" },
          {
            type: "tool_result",
            tool_use_id: "toolu_abc",
            content: "ok",
            is_error: false,
          },
        ],
      },
    };
    const decoded = decode(UserMessage, frame);
    expect(Array.isArray(decoded.message.content)).toBe(true);
  });

  it("decodes an `assistant` frame with text + thinking + tool_use blocks", () => {
    const frame = {
      type: "assistant",
      uuid: "msg-uuid-1",
      session_id: "sess-1",
      parent_tool_use_id: null,
      error: null,
      message: {
        id: "msg_01",
        model: "claude-opus-4-7",
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 34 },
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "ponder", signature: "sig" },
          {
            type: "tool_use",
            id: "toolu_xyz",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    };
    const decoded = decode(AssistantMessage, frame);
    expect(decoded.message.model).toBe("claude-opus-4-7");
    expect(decoded.message.content.length).toBe(3);
  });

  it("decodes a `system`/`init` frame with plugins AND plugin_errors present", () => {
    const frame = {
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      session_id: "sess-1",
      plugins: [{ name: "p1", path: "/tmp/p1" }],
      plugin_errors: [
        { plugin: "p2", type: "load_failed", message: "missing path" },
      ],
      cwd: "/tmp",
    };
    const decoded = decode(SystemInitMessage, frame);
    expect(decoded.plugins?.length).toBe(1);
    expect(decoded.plugin_errors?.length).toBe(1);
  });

  it("decodes a `system`/`init` frame WITHOUT plugin_errors (key omitted)", () => {
    const frame = {
      type: "system",
      subtype: "init",
      model: "claude-opus-4-7",
      session_id: "sess-1",
      plugins: [],
    };
    const decoded = decode(SystemInitMessage, frame);
    expect(decoded.plugin_errors).toBeUndefined();
    expect(decoded.plugins).toEqual([]);

    const viaUnion = decode(StreamJsonMessage, frame);
    expect(viaUnion.type).toBe("system");
  });

  it("decodes `system`/`task_started`, `task_progress`, `task_notification`", () => {
    const started = {
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      description: "Run subagent",
      session_id: "sess-1",
    };
    const progress = {
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      usage: { total_tokens: 100, tool_uses: 2, duration_ms: 500 },
      session_id: "sess-1",
    };
    const notif = {
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      session_id: "sess-1",
    };
    expect(decode(SystemMessage, started).subtype).toBe("task_started");
    expect(decode(SystemMessage, progress).subtype).toBe("task_progress");
    expect(decode(SystemMessage, notif).subtype).toBe("task_notification");
  });

  it("decodes `system`/`hook_started` and `hook_response`", () => {
    const started = {
      type: "system",
      subtype: "hook_started",
      hook_event: "PreToolUse",
      hook_name: "lint",
      session_id: "sess-1",
    };
    const response = {
      type: "system",
      subtype: "hook_response",
      hook_event: "PreToolUse",
      hook_name: "lint",
      output: { ok: true },
      exit_code: 0,
      outcome: "allow",
      session_id: "sess-1",
    };
    expect(decode(SystemMessage, started).subtype).toBe("hook_started");
    expect(decode(SystemMessage, response).subtype).toBe("hook_response");
  });

  it("decodes `system`/`mirror_error` and `session_state_changed`", () => {
    expect(
      decode(SystemMessage, {
        type: "system",
        subtype: "mirror_error",
        error: "store unavailable",
      }).subtype,
    ).toBe("mirror_error");

    expect(
      decode(SystemMessage, {
        type: "system",
        subtype: "session_state_changed",
        session_id: "sess-1",
      }).subtype,
    ).toBe("session_state_changed");
  });

  it("round-trips `system`/`api_retry` for every documented `error` value", () => {
    const errors = [
      "authentication_failed",
      "oauth_org_not_allowed",
      "billing_error",
      "rate_limit",
      "invalid_request",
      "server_error",
      "max_output_tokens",
      "unknown",
    ];
    for (const err of errors) {
      const frame = {
        type: "system" as const,
        subtype: "api_retry" as const,
        attempt: 1,
        max_retries: 5,
        retry_delay_ms: 2000,
        error_status: err === "rate_limit" ? 429 : null,
        error: err,
        uuid: "evt-uuid",
        session_id: "sess-1",
      };
      const decoded = decode(SystemApiRetryMessage, frame);
      expect(decoded.error).toBe(err);
      const encoded = Schema.encodeSync(SystemApiRetryMessage)(decoded);
      expect(encoded).toEqual(frame);
    }
  });

  it("decodes `system`/`plugin_install` without erroring (defensive)", () => {
    const frame = {
      type: "system",
      subtype: "plugin_install",
      status: "installed",
      name: "@org/plugin",
      uuid: "evt-uuid",
      session_id: "sess-1",
    };
    const decoded = decode(SystemPluginInstallMessage, frame);
    expect(decoded.status).toBe("installed");
    expect(decoded.name).toBe("@org/plugin");

    // Failed-status variant carries an `error`.
    const failed = {
      type: "system",
      subtype: "plugin_install",
      status: "failed",
      name: "@org/broken",
      error: "checksum mismatch",
      uuid: "evt-uuid-2",
      session_id: "sess-1",
    };
    expect(decode(SystemPluginInstallMessage, failed).error).toBe(
      "checksum mismatch",
    );
  });

  it("decodes a fully-populated `result` frame and tolerates an unknown subtype", () => {
    const frame = {
      type: "result",
      subtype: "success",
      duration_ms: 12345,
      duration_api_ms: 9876,
      is_error: false,
      num_turns: 1,
      session_id: "sess-1",
      stop_reason: "end_turn",
      total_cost_usd: 0.0123,
      usage: { input_tokens: 100, output_tokens: 50 },
      result: "final assistant text",
      modelUsage: {
        "claude-opus-4-7": { input_tokens: 100, output_tokens: 50 },
      },
    };
    const decoded = decode(ResultMessage, frame);
    expect(decoded.subtype).toBe("success");
    expect(decoded.modelUsage?.["claude-opus-4-7"]?.input_tokens).toBe(100);

    // An unknown subtype string still decodes — subtype is Schema.String.
    const futureSubtype = decode(ResultMessage, {
      ...frame,
      subtype: "error_some_future_variant",
    });
    expect(futureSubtype.subtype).toBe("error_some_future_variant");
  });

  it("decodes a `stream_event` frame with opaque event payload", () => {
    const frame = {
      type: "stream_event",
      uuid: "evt-uuid",
      session_id: "sess-1",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { text: "hi" } },
    };
    const decoded = decode(StreamEvent, frame);
    expect(decoded.event).toEqual({
      type: "content_block_delta",
      index: 0,
      delta: { text: "hi" },
    });
  });

  it("decodes `rate_limit_event` with camelCase wire fields renamed to snake_case", () => {
    const frame = {
      type: "rate_limit_event",
      uuid: "evt-uuid",
      session_id: "sess-1",
      rate_limit_info: {
        status: "allowed_warning",
        resetsAt: 1730000000,
        rateLimitType: "five_hour",
        utilization: 0.95,
        overageStatus: "disabled",
        overageResetsAt: 1730003600,
        overageDisabledReason: "operator opt-out",
      },
    };
    const decoded = decode(RateLimitEvent, frame);
    expect(decoded.rate_limit_info.resets_at).toBe(1730000000);
    expect(decoded.rate_limit_info.rate_limit_type).toBe("five_hour");
    expect(decoded.rate_limit_info.overage_status).toBe("disabled");
    expect(decoded.rate_limit_info.overage_resets_at).toBe(1730003600);
    expect(decoded.rate_limit_info.overage_disabled_reason).toBe(
      "operator opt-out",
    );

    // Round-trip back to the camelCase wire form.
    const encoded = Schema.encodeSync(RateLimitEvent)(decoded);
    expect(encoded.rate_limit_info).toEqual({
      status: "allowed_warning",
      resetsAt: 1730000000,
      rateLimitType: "five_hour",
      utilization: 0.95,
      overageStatus: "disabled",
      overageResetsAt: 1730003600,
      overageDisabledReason: "operator opt-out",
    });
  });

  it("decodes a `control_request` with subtype=can_use_tool", () => {
    const frame = {
      type: "control_request",
      request_id: "req_1_abcd",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /" },
        tool_use_id: "toolu_xyz",
        title: "Claude wants to run rm -rf /",
      },
    };
    const decoded = decode(ControlRequest, frame);
    expect(decoded.request.subtype).toBe("can_use_tool");
  });

  it("decodes a `control_request` with subtype=mcp_message", () => {
    const frame = {
      type: "control_request",
      request_id: "req_2_beef",
      request: {
        subtype: "mcp_message",
        server_name: "symphony",
        message: { jsonrpc: "2.0", method: "tools/list", id: 1 },
      },
    };
    expect(decode(ControlRequest, frame).request.subtype).toBe("mcp_message");
  });

  it("decodes a `control_request` with an unknown subtype", () => {
    const frame = {
      type: "control_request",
      request_id: "req_3_face",
      request: { subtype: "future_variant", payload: { x: 1 } },
    };
    expect(decode(ControlRequest, frame).request.subtype).toBe("future_variant");
  });

  it("decodes both success and error `control_response` bodies", () => {
    const success = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req_1",
        response: { behavior: "allow" },
      },
    };
    const error = {
      type: "control_response",
      response: {
        subtype: "error",
        request_id: "req_1",
        error: "tool denied",
      },
    };
    expect(decode(ControlResponse, success).response.subtype).toBe("success");
    expect(decode(ControlResponse, error).response.subtype).toBe("error");
  });

  it("decodes a `control_cancel_request`", () => {
    const decoded = decode(ControlCancelRequest, {
      type: "control_cancel_request",
      request_id: "req_4",
    });
    expect(decoded.request_id).toBe("req_4");
  });

  it("decodes `transcript_mirror` (opaque body)", () => {
    const decoded = decode(TranscriptMirror, {
      type: "transcript_mirror",
      anything: "is allowed here",
    });
    expect(decoded.type).toBe("transcript_mirror");
  });
});

describe("StreamJsonMessage — forward-compat", () => {
  it("decodes an unknown `type` to the UnknownFrame variant without throwing", () => {
    const frame = {
      type: "future_message_type",
      payload: { whatever: 1 },
    };
    const decoded = decode(StreamJsonMessage, frame);
    expect(decoded.type).toBe("future_message_type");
    // The catch-all only guarantees the discriminator, but the index
    // signature exposes the rest of the payload for debug logging.
    expect((decoded as UnknownFrame & Record<string, unknown>).payload).toEqual(
      { whatever: 1 },
    );
  });

  it("rejects a non-object input", () => {
    const result = tryDecode(StreamJsonMessage, "not a frame");
    expect(Either.isLeft(result)).toBe(true);
  });

  it("rejects a frame without a `type` field", () => {
    const result = tryDecode(StreamJsonMessage, { foo: "bar" });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("Outbound frame schemas — round-trip", () => {
  it("encodes an OutboundUserMessage to its wire form", () => {
    const msg: OutboundUserMessage = {
      type: "user",
      message: { role: "user", content: "go fix the bug" },
      parent_tool_use_id: null,
    };
    const encoded = Schema.encodeSync(OutboundUserMessage)(msg);
    expect(encoded).toEqual({
      type: "user",
      message: { role: "user", content: "go fix the bug" },
      parent_tool_use_id: null,
    });

    // Decode the encoded payload back and ensure equivalence.
    const redecoded = decode(OutboundUserMessage, encoded);
    expect(redecoded).toEqual(msg);
  });

  it("encodes an OutboundControlResponse (deny/interrupt) to its wire form", () => {
    const wire = {
      type: "control_response" as const,
      response: {
        subtype: "success" as const,
        request_id: "req_1",
        response: {
          behavior: "deny",
          message: "Symphony v1: no human in loop",
          interrupt: true,
        },
      },
    };
    const decoded = decode(OutboundControlResponse, wire);
    const encoded = Schema.encodeSync(OutboundControlResponse)(decoded);
    expect(encoded).toEqual(wire);
  });

  it("encodes an OutboundControlCancelRequest", () => {
    const wire = { type: "control_cancel_request" as const, request_id: "req_9" };
    const decoded = decode(OutboundControlCancelRequest, wire);
    const encoded = Schema.encodeSync(OutboundControlCancelRequest)(decoded);
    expect(encoded).toEqual(wire);
  });
});
