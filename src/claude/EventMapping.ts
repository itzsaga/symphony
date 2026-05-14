// EventMapping: pure transform from Claude `StreamJsonMessage` frames to Symphony §10.4 RuntimeEvents.
// Maintains the absolute token totals on ClaudeSessionState; per-frame deltas live in the orchestrator.
import { Data, Schema } from "effect";
import {
  AssistantMessage,
  RateLimitEvent,
  ResultMessage,
  StreamEvent,
  SystemApiRetryMessage,
  SystemInitMessage,
  SystemMessage,
  SystemTaskNotificationMessage,
  TranscriptMirror,
  UserMessage,
  type ContentBlock,
  type RateLimitInfo,
  type StreamJsonMessage,
  type Usage,
} from "./StreamJson.ts";
import {
  initialClaudeSessionState,
  type ClaudeSessionState,
} from "./sessionState.ts";

/* -------------------------------------------------------------------------- */
/* RuntimeEvent variants — one per spec §10.4 emitted-event kind plus the     */
/* useful non-§10.4 events from research/claude-stream-json.md §3.            */
/*                                                                            */
/* All variants are `Data.TaggedClass`es so consumers can pattern-match on    */
/* `_tag` and benefit from structural equality / nice constructors. The fields*/
/* on each variant carry the wire data the orchestrator needs to act, never   */
/* references to the original frame.                                          */
/* -------------------------------------------------------------------------- */

/** Plugin descriptor copied off `system.init.plugins`. */
export interface SessionStartedPlugin {
  readonly name: string;
  readonly path: string;
}

/** Plugin load-error descriptor copied off `system.init.plugin_errors`. */
export interface SessionStartedPluginError {
  readonly plugin: string;
  readonly type: string;
  readonly message: string;
}

/**
 * `system.init` observed — the session is up. `claude_pid` is left for the
 * subprocess layer to fill in via {@link mapFrame} callers; the reducer does
 * not have access to the OS pid, only to wire data, so this event surfaces
 * the *protocol-visible* startup signal rather than the OS-level one. The
 * §13.7 HTTP boundary translates `claude_pid` → `codex_app_server_pid`.
 */
export class SessionStarted extends Data.TaggedClass("SessionStarted")<{
  readonly session_id: string | null;
  readonly model: string | null;
  readonly plugins: ReadonlyArray<SessionStartedPlugin>;
  readonly plugin_errors: ReadonlyArray<SessionStartedPluginError>;
}> {}

/**
 * Pre-stream startup error, OR the first `result` frame with `is_error:true`
 * arriving before any `system.init`. The subprocess layer emits the pre-stream
 * variant directly (e.g. on `ClaudeNotFound`); this module emits the in-stream
 * variant when the reducer sees an error result before init.
 */
export class StartupFailed extends Data.TaggedClass("StartupFailed")<{
  readonly subtype: string;
  readonly errors: ReadonlyArray<string>;
  readonly api_error_status: number | null;
}> {}

/**
 * `result` with `subtype:"success"` — the turn completed cleanly. Carries the
 * post-turn aggregate usage and per-model breakdown, plus the synthesized
 * `session_id = "<thread_id>-<turn_id>"` per spec §4.2.
 */
export class TurnCompleted extends Data.TaggedClass("TurnCompleted")<{
  readonly thread_id: string;
  readonly turn_id: number;
  readonly session_id: string;
  readonly duration_ms: number;
  readonly duration_api_ms: number;
  readonly num_turns: number;
  readonly total_cost_usd: number | null;
  readonly usage: Usage | null;
  readonly model_usage: Readonly<Record<string, Usage>> | null;
}> {}

/**
 * `result` with `is_error:true` and a non-cancel subtype (`error_max_turns`,
 * `error_max_budget_usd`, `error_during_execution`, etc).
 */
export class TurnFailed extends Data.TaggedClass("TurnFailed")<{
  readonly thread_id: string;
  readonly turn_id: number;
  readonly session_id: string;
  readonly subtype: string;
  readonly errors: ReadonlyArray<string>;
  readonly api_error_status: number | null;
  readonly duration_ms: number;
}> {}

/**
 * Synthesized when ControlProtocol sent a `control_cancel_request` for the
 * current turn. The mapping module exports the constructor; the orchestrator
 * triggers the event itself once the cancel is acknowledged.
 */
export class TurnCancelled extends Data.TaggedClass("TurnCancelled")<{
  readonly thread_id: string | null;
  readonly turn_id: number | null;
  readonly request_id: string;
  readonly reason: string | null;
}> {}

/**
 * `assistant.error` was set on a continued run. The CLI did not abort — it
 * surfaced the error in-band and kept going. v1 forwards the signal upstream
 * so the dashboard reflects degraded state without marking the run failed.
 */
export class TurnEndedWithError extends Data.TaggedClass("TurnEndedWithError")<{
  readonly thread_id: string | null;
  readonly turn_id: number | null;
  readonly error: string;
  readonly model: string | null;
}> {}

/**
 * Synthesized by ControlProtocol's `can_use_tool` handler — the CLI is
 * blocking on a permission decision that v1 treats as a hard failure
 * (TRUST.md). The mapping module owns the constructor; ControlProtocol emits
 * via an injected Queue at runtime.
 */
export class TurnInputRequired extends Data.TaggedClass("TurnInputRequired")<{
  readonly thread_id: string | null;
  readonly turn_id: number | null;
  readonly request_id: string;
  readonly tool_name: string;
  readonly tool_use_id: string | null;
  readonly input: unknown;
  readonly title: string | null;
  readonly description: string | null;
}> {}

/**
 * Synthesized on every `tool_use` content block while `bypassPermissions` is
 * in effect. The reducer does not know the permission mode (it lives on the
 * subprocess spawn options), so callers pass `bypass_permissions` per call
 * via {@link MapFrameOptions}.
 */
export class ApprovalAutoApproved extends Data.TaggedClass("ApprovalAutoApproved")<{
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly input: unknown;
}> {}

/**
 * `tool_use` whose tool isn't in the advertised set + correlated
 * `tool_result.is_error:true`. The mapping module exports the constructor for
 * downstream code (e.g. the orchestrator's correlator) to populate; v1
 * `mapFrame` does not synthesize this event itself because it has no view of
 * the advertised tool set.
 */
export class UnsupportedToolCall extends Data.TaggedClass("UnsupportedToolCall")<{
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly error_text: string | null;
}> {}

/**
 * `system.task_notification`, informational `stream_event`s, or any other
 * non-actionable observation that should appear in the dashboard's recent-
 * events feed. `level` lets the orchestrator route plugin-error notes to
 * `warn` while leaving routine notifications at `info`.
 */
export class Notification extends Data.TaggedClass("Notification")<{
  readonly level: "info" | "warn";
  readonly source: string;
  readonly message: string;
  readonly detail: unknown;
}> {}

/**
 * `system.api_retry` — the CLI is internally retrying a failing API call.
 * The orchestrator MUST NOT treat this as a turn failure (research §3,
 * §2.g): Claude is alive and will retry on its own; surface to the dashboard's
 * recent-events feed only.
 */
export class ApiRetrying extends Data.TaggedClass("ApiRetrying")<{
  readonly attempt: number;
  readonly max_retries: number;
  readonly retry_delay_ms: number;
  readonly error: string;
  readonly error_status: number | null;
}> {}

/** Forward-compat catch-all — any frame the reducer does not specifically map. */
export class OtherMessage extends Data.TaggedClass("OtherMessage")<{
  readonly type: string;
  readonly subtype: string | null;
  readonly raw: unknown;
}> {}

/**
 * Decode failure marker. The reducer does not produce this from the wire
 * (the upstream parser layer never delivers undecodable frames), but the
 * constructor is exported so the subprocess layer can surface
 * `StreamDecodeError`s through the same RuntimeEvent channel.
 */
export class Malformed extends Data.TaggedClass("Malformed")<{
  readonly reason: string;
  readonly raw: string | null;
}> {}

/* -------------------------------------------------------------------------- */
/* Useful non-§10.4 events (research/claude-stream-json.md §3).               */
/* -------------------------------------------------------------------------- */

/** Streaming text delta — emitted from `stream_event` `content_block_delta`. */
export class TextDelta extends Data.TaggedClass("TextDelta")<{
  readonly thread_id: string | null;
  readonly text: string;
}> {}

/** A `tool_use` content block was observed inside an `assistant` frame. */
export class ToolCallStarted extends Data.TaggedClass("ToolCallStarted")<{
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly input: unknown;
}> {}

/** A `tool_result` content block was observed inside a `user` frame. */
export class ToolCallCompleted extends Data.TaggedClass("ToolCallCompleted")<{
  readonly tool_use_id: string;
  readonly is_error: boolean;
  readonly content: unknown;
}> {}

/** `rate_limit_event` observed — the latest payload is also stashed on state. */
export class RateLimit extends Data.TaggedClass("RateLimit")<{
  readonly info: RateLimitInfo;
}> {}

/** Subprocess exited (synthesized by the subprocess layer; constructor exported). */
export class ProcessExited extends Data.TaggedClass("ProcessExited")<{
  readonly code: number;
  readonly signal: string | null;
}> {}

/** Per-turn aggregate usage report — sibling of TurnCompleted for token UIs. */
export class UsageReport extends Data.TaggedClass("UsageReport")<{
  readonly thread_id: string;
  readonly turn_id: number;
  readonly usage: Usage;
  readonly total_cost_usd: number | null;
  readonly model_usage: Readonly<Record<string, Usage>> | null;
}> {}

/** Discriminated union of every RuntimeEvent the reducer (or its callers) can emit. */
export type RuntimeEvent =
  | SessionStarted
  | StartupFailed
  | TurnCompleted
  | TurnFailed
  | TurnCancelled
  | TurnEndedWithError
  | TurnInputRequired
  | ApprovalAutoApproved
  | UnsupportedToolCall
  | Notification
  | ApiRetrying
  | OtherMessage
  | Malformed
  | TextDelta
  | ToolCallStarted
  | ToolCallCompleted
  | RateLimit
  | ProcessExited
  | UsageReport;

/* -------------------------------------------------------------------------- */
/* Public API.                                                                */
/* -------------------------------------------------------------------------- */

/** Output shape of a single {@link mapFrame} call. */
export interface MapFrameResult {
  readonly events: ReadonlyArray<RuntimeEvent>;
  readonly newState: ClaudeSessionState;
}

/**
 * Optional per-call inputs the reducer cannot derive from the wire. Currently
 * just the permission-mode flag used to gate `ApprovalAutoApproved` synthesis;
 * the field is optional because some callers (e.g. the unit tests) don't need
 * it.
 */
export interface MapFrameOptions {
  /** True when the subprocess was spawned with `--permission-mode bypassPermissions`. */
  readonly bypass_permissions?: boolean;
}

/**
 * Synthesize Symphony's composite session_id per spec §4.2 / §10.2:
 * `<thread_id>-<turn_id>`. The mapping is total — neither input is validated
 * here; callers pass the values they read off `system.init` and `result`.
 */
export const synthesizeSessionId = (
  threadId: string,
  turnId: number,
): string => `${threadId}-${turnId}`;

/**
 * Re-export the initial state so callers can spin a fresh session without
 * importing two modules.
 */
export { initialClaudeSessionState };

/* -------------------------------------------------------------------------- */
/* Type guards.                                                               */
/*                                                                            */
/* The top-level `StreamJsonMessage` union ends in `UnknownFrame` (whose      */
/* `type` is just `string`), which means a plain `switch (frame.type)` does   */
/* NOT statically narrow away the catch-all variant. We use `Schema.is` to    */
/* do strict per-variant guarding — same trick as ControlProtocol.ts.         */
/* -------------------------------------------------------------------------- */

const isSystem = Schema.is(SystemMessage);
const isResult = Schema.is(ResultMessage);
const isAssistant = Schema.is(AssistantMessage);
const isUser = Schema.is(UserMessage);
const isRateLimitEvent = Schema.is(RateLimitEvent);
const isStreamEvent = Schema.is(StreamEvent);
const isTranscriptMirror = Schema.is(TranscriptMirror);

/**
 * Pure reducer: `(frame, state) → { events, newState }`. The reducer never
 * throws — every branch returns a valid `MapFrameResult`. Frames the reducer
 * does not specifically handle become an `OtherMessage` and leave state
 * untouched (other than `last_event` / `last_event_at` for dashboard
 * visibility).
 */
export const mapFrame = (
  frame: StreamJsonMessage,
  sessionState: ClaudeSessionState,
  options: MapFrameOptions = {},
): MapFrameResult => {
  if (isSystem(frame)) {
    return mapSystem(frame, sessionState);
  }
  if (isResult(frame)) {
    return mapResult(frame, sessionState);
  }
  if (isAssistant(frame)) {
    return mapAssistant(frame, sessionState, options);
  }
  if (isUser(frame)) {
    return mapUser(frame, sessionState);
  }
  if (isRateLimitEvent(frame)) {
    return mapRateLimit(frame, sessionState);
  }
  if (isStreamEvent(frame)) {
    return mapStreamEvent(frame, sessionState);
  }
  if (isTranscriptMirror(frame)) {
    // Mirrored transcript frames have no orchestrator-relevant payload;
    // surface as OtherMessage without touching state so the recent-events
    // feed can still show them at debug level if anyone wants.
    return {
      events: [
        new OtherMessage({
          type: "transcript_mirror",
          subtype: null,
          raw: frame,
        }),
      ],
      newState: sessionState,
    };
  }
  // Control-protocol frames + UnknownFrame catch-all all land here.
  // Control frames are out-of-band for the conversation stream (ControlProtocol
  // owns them); UnknownFrame is the forward-compat catch-all. Both are
  // surfaced as OtherMessage so a misrouted/forward-compat frame still
  // appears on the recent-events feed.
  const frameType =
    typeof (frame as { type?: unknown }).type === "string"
      ? ((frame as { type: string }).type)
      : "unknown";
  return {
    events: [
      new OtherMessage({
        type: frameType,
        subtype: null,
        raw: frame,
      }),
    ],
    newState: touchEvent(sessionState, "OtherMessage"),
  };
};

/* -------------------------------------------------------------------------- */
/* Internals.                                                                 */
/* -------------------------------------------------------------------------- */

const touchEvent = (
  state: ClaudeSessionState,
  tag: string,
): ClaudeSessionState => ({
  ...state,
  last_event: tag,
  last_event_at: new Date(),
});

/**
 * Sum the components of a `Usage` block into a single total-tokens number.
 * The Anthropic API doesn't ship a `total_tokens` field on every model; we
 * compute one to keep the dashboard column populated. Cache reads/creates
 * are billed separately so we include them here too.
 */
const totalTokensFromUsage = (usage: Usage | undefined): number => {
  if (usage === undefined) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return input + output + cacheCreate + cacheRead;
};

const isSystemInit = Schema.is(SystemInitMessage);
const isSystemApiRetry = Schema.is(SystemApiRetryMessage);
const isSystemTaskNotification = Schema.is(SystemTaskNotificationMessage);

const mapSystem = (
  frame: SystemMessage,
  state: ClaudeSessionState,
): MapFrameResult => {
  if (isSystemInit(frame)) {
    return mapInit(frame, state);
  }
  if (isSystemApiRetry(frame)) {
    return {
      events: [
        new ApiRetrying({
          attempt: frame.attempt,
          max_retries: frame.max_retries,
          retry_delay_ms: frame.retry_delay_ms,
          error: frame.error,
          error_status: frame.error_status,
        }),
      ],
      newState: touchEvent(state, "ApiRetrying"),
    };
  }
  if (isSystemTaskNotification(frame)) {
    return {
      events: [
        new Notification({
          level: "info",
          source: "task_notification",
          message: frame.description ?? frame.status ?? "task notification",
          detail: frame,
        }),
      ],
      newState: touchEvent(state, "Notification"),
    };
  }
  // Anything else (`task_started`, `task_progress`, `hook_*`, `mirror_error`,
  // `session_state_changed`, `plugin_install`, plus the `SystemUnknownMessage`
  // catch-all) is surfaced as OtherMessage with the subtype preserved so the
  // dashboard's recent-events feed can show it.
  const subtype =
    typeof (frame as { subtype?: unknown }).subtype === "string"
      ? ((frame as { subtype: string }).subtype)
      : null;
  return {
    events: [
      new OtherMessage({
        type: "system",
        subtype,
        raw: frame,
      }),
    ],
    newState: touchEvent(state, "OtherMessage"),
  };
};

/**
 * Map a `system.init` frame to a `SessionStarted` event plus a `Notification`
 * per non-empty `plugin_errors` entry. The notification path is how this
 * pure module reports plugin load failures to the orchestrator without
 * taking a Logger dependency — the orchestrator turns each `Notification`
 * with `level: "warn"` into a real warn log line.
 */
const mapInit = (
  frame: Schema.Schema.Type<typeof SystemInitMessage>,
  state: ClaudeSessionState,
): MapFrameResult => {
  const plugins: ReadonlyArray<SessionStartedPlugin> = frame.plugins ?? [];
  const pluginErrors: ReadonlyArray<SessionStartedPluginError> =
    frame.plugin_errors ?? [];
  const sessionStarted = new SessionStarted({
    session_id: frame.session_id ?? null,
    model: frame.model ?? null,
    plugins,
    plugin_errors: pluginErrors,
  });

  const events: Array<RuntimeEvent> = [sessionStarted];
  for (const err of pluginErrors) {
    events.push(
      new Notification({
        level: "warn",
        source: "plugin_load",
        message: `plugin '${err.plugin}' failed to load: ${err.message}`,
        detail: err,
      }),
    );
  }

  const next: ClaudeSessionState = {
    ...state,
    thread_id: frame.session_id ?? state.thread_id,
    model: frame.model ?? state.model,
    last_event: "SessionStarted",
    last_event_at: new Date(),
  };
  return { events, newState: next };
};

const mapResult = (
  frame: ResultMessage,
  state: ClaudeSessionState,
): MapFrameResult => {
  const errors: ReadonlyArray<string> = frame.errors ?? [];
  const apiErrorStatus = frame.api_error_status ?? null;

  // Pre-init error result → StartupFailed instead of TurnFailed.
  if (state.thread_id === null && frame.is_error) {
    return {
      events: [
        new StartupFailed({
          subtype: frame.subtype,
          errors,
          api_error_status: apiErrorStatus,
        }),
      ],
      newState: {
        ...state,
        last_event: "StartupFailed",
        last_event_at: new Date(),
        turn_count: state.turn_count + 1,
      },
    };
  }

  // Token totals. `result.usage` is a turn aggregate; we replace (not add)
  // because the field is the absolute total at the end of this turn — the
  // orchestrator's flush-then-update loop computes deltas vs `last_reported_*`.
  const usage = frame.usage;
  const inputTokens = usage?.input_tokens ?? state.claude_input_tokens;
  const outputTokens = usage?.output_tokens ?? state.claude_output_tokens;
  const totalTokens =
    usage !== undefined ? totalTokensFromUsage(usage) : state.claude_total_tokens;

  // Synthesize the composite session_id only when we have a thread_id.
  // (Pre-init error result already short-circuited above.)
  const threadId = state.thread_id ?? frame.session_id;
  const turnId = frame.num_turns;
  const sessionId = synthesizeSessionId(threadId, turnId);

  const events: Array<RuntimeEvent> = [];
  if (frame.is_error) {
    events.push(
      new TurnFailed({
        thread_id: threadId,
        turn_id: turnId,
        session_id: sessionId,
        subtype: frame.subtype,
        errors,
        api_error_status: apiErrorStatus,
        duration_ms: frame.duration_ms,
      }),
    );
  } else {
    events.push(
      new TurnCompleted({
        thread_id: threadId,
        turn_id: turnId,
        session_id: sessionId,
        duration_ms: frame.duration_ms,
        duration_api_ms: frame.duration_api_ms,
        num_turns: frame.num_turns,
        total_cost_usd: frame.total_cost_usd ?? null,
        usage: usage ?? null,
        model_usage: frame.modelUsage ?? null,
      }),
    );
    if (usage !== undefined) {
      events.push(
        new UsageReport({
          thread_id: threadId,
          turn_id: turnId,
          usage,
          total_cost_usd: frame.total_cost_usd ?? null,
          model_usage: frame.modelUsage ?? null,
        }),
      );
    }
  }

  const newState: ClaudeSessionState = {
    ...state,
    latest_turn_id: turnId,
    claude_input_tokens: inputTokens,
    claude_output_tokens: outputTokens,
    claude_total_tokens: totalTokens,
    turn_count: state.turn_count + 1,
    last_event: frame.is_error ? "TurnFailed" : "TurnCompleted",
    last_event_at: new Date(),
  };
  return { events, newState };
};

const mapAssistant = (
  frame: AssistantMessage,
  state: ClaudeSessionState,
  options: MapFrameOptions,
): MapFrameResult => {
  const events: Array<RuntimeEvent> = [];

  // Walk content blocks: text → TextDelta (consolidated per block), tool_use
  // → ToolCallStarted (+ optional ApprovalAutoApproved).
  for (const block of frame.message.content) {
    appendAssistantBlockEvents(events, block, options);
  }

  // assistant.error set on a continued run → TurnEndedWithError.
  if (frame.error !== null && frame.error !== undefined) {
    events.push(
      new TurnEndedWithError({
        thread_id: state.thread_id,
        turn_id: state.latest_turn_id,
        error: frame.error,
        model: frame.message.model,
      }),
    );
  }

  // Heartbeat: keep the model fresh (some sessions only learn the model from
  // the first assistant frame, e.g. when init didn't carry it). Also stash
  // the most recent non-empty text-block content as `last_message` — empty
  // text blocks happen between tool calls and would otherwise overwrite the
  // user-visible last message with a blank.
  let lastMessage = state.last_message;
  for (const block of frame.message.content) {
    if (block.type === "text" && block.text.length > 0) {
      lastMessage = block.text;
    }
  }

  const newState: ClaudeSessionState = {
    ...state,
    model: frame.message.model ?? state.model,
    last_message: lastMessage,
    last_event:
      events.length > 0
        ? (events[events.length - 1]?._tag ?? "OtherMessage")
        : state.last_event,
    last_event_at: events.length > 0 ? new Date() : state.last_event_at,
  };
  return { events, newState };
};

const appendAssistantBlockEvents = (
  events: Array<RuntimeEvent>,
  block: ContentBlock,
  options: MapFrameOptions,
): void => {
  switch (block.type) {
    case "text":
      // Text blocks in assistant frames are the consolidated form (no
      // `--include-partial-messages` needed). Emit as a single TextDelta
      // so downstream UIs can append/log it directly.
      if (block.text.length > 0) {
        events.push(
          new TextDelta({
            thread_id: null,
            text: block.text,
          }),
        );
      }
      return;
    case "tool_use":
      events.push(
        new ToolCallStarted({
          tool_name: block.name,
          tool_use_id: block.id,
          input: block.input,
        }),
      );
      if (options.bypass_permissions === true) {
        events.push(
          new ApprovalAutoApproved({
            tool_name: block.name,
            tool_use_id: block.id,
            input: block.input,
          }),
        );
      }
      return;
    case "thinking":
    case "tool_result":
    case "server_tool_use":
    case "advisor_tool_result":
      // These blocks are either non-actionable for the orchestrator
      // (thinking) or only meaningful in a `user` frame (tool_result), or
      // server-side and never returned by the host (server_tool_use,
      // advisor_tool_result). Skipped on the assistant side.
      return;
  }
};

const mapUser = (
  frame: UserMessage,
  state: ClaudeSessionState,
): MapFrameResult => {
  const events: Array<RuntimeEvent> = [];
  const content = frame.message.content;
  if (typeof content !== "string") {
    for (const block of content) {
      if (block.type === "tool_result") {
        events.push(
          new ToolCallCompleted({
            tool_use_id: block.tool_use_id,
            is_error: block.is_error ?? false,
            content: block.content,
          }),
        );
      }
    }
  }
  if (events.length === 0) {
    return { events, newState: state };
  }
  return {
    events,
    newState: touchEvent(state, "ToolCallCompleted"),
  };
};

const mapRateLimit = (
  frame: RateLimitEvent,
  state: ClaudeSessionState,
): MapFrameResult => {
  const newState: ClaudeSessionState = {
    ...state,
    latest_rate_limit: frame.rate_limit_info,
    last_event: "RateLimit",
    last_event_at: new Date(),
  };
  return {
    events: [new RateLimit({ info: frame.rate_limit_info })],
    newState,
  };
};

const mapStreamEvent = (
  frame: StreamEvent,
  state: ClaudeSessionState,
): MapFrameResult => {
  // `event` is an opaque pass-through of an Anthropic API SSE event. We
  // attempt a single specialization — `content_block_delta` carrying a
  // `text_delta` — and otherwise surface the frame as a Notification so
  // the dashboard's event feed has visibility.
  const text = extractTextDelta(frame.event);
  if (text !== null) {
    return {
      events: [new TextDelta({ thread_id: state.thread_id, text })],
      newState: {
        ...state,
        last_event: "TextDelta",
        last_event_at: new Date(),
      },
    };
  }
  return {
    events: [
      new Notification({
        level: "info",
        source: "stream_event",
        message: "stream_event",
        detail: frame.event,
      }),
    ],
    newState: touchEvent(state, "Notification"),
  };
};

/**
 * Best-effort extractor for the `text_delta` shape inside a `stream_event`.
 * Returns the inner text when the event matches Anthropic's
 * `content_block_delta` envelope with a `text_delta` body, otherwise `null`.
 * The shape is `{type:"content_block_delta", delta:{type:"text_delta", text:string}}`.
 * Modeled loosely so the parser doesn't fail on future deltas it doesn't know.
 */
const extractTextDelta = (event: unknown): string | null => {
  if (typeof event !== "object" || event === null) return null;
  const ev = event as { readonly type?: unknown; readonly delta?: unknown };
  if (ev.type !== "content_block_delta") return null;
  const delta = ev.delta;
  if (typeof delta !== "object" || delta === null) return null;
  const d = delta as { readonly type?: unknown; readonly text?: unknown };
  if (d.type !== "text_delta") return null;
  if (typeof d.text !== "string") return null;
  return d.text;
};
