// Unit tests for src/http/Dashboard.ts: HTML escaping (XSS guard), meta-refresh,
// rendered tables for running / retrying / recent events, and graceful empties.
import { describe, expect, it } from "bun:test";
import type { LogRecord } from "../../../src/observability/Logger.ts";
import { escapeHtml, html, renderDashboard } from "../../../src/http/Dashboard.ts";
import type { ApiState } from "../../../src/http/snapshot.ts";

/* -------------------------------------------------------------------------- */
/* Fixtures.                                                                  */
/* -------------------------------------------------------------------------- */

const emptyState = (overrides?: Partial<ApiState>): ApiState => ({
  generated_at: "2026-02-24T20:15:30.000Z",
  counts: { running: 0, retrying: 0 },
  running: [],
  retrying: [],
  codex_totals: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    seconds_running: 0,
  },
  rate_limits: null,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* escapeHtml.                                                                */
/* -------------------------------------------------------------------------- */

describe("escapeHtml", () => {
  it("escapes the five HTML special characters", () => {
    expect(escapeHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml(`"quoted"`)).toBe("&quot;quoted&quot;");
    expect(escapeHtml(`it's`)).toBe("it&#39;s");
  });

  it("does not double-escape entity references", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

/* -------------------------------------------------------------------------- */
/* html tagged template.                                                      */
/* -------------------------------------------------------------------------- */

describe("html tagged template", () => {
  it("escapes interpolated string values", () => {
    const out = html`<p>${"<script>"}</p>`;
    expect(out).toBe("<p>&lt;script&gt;</p>");
  });

  it("renders null / undefined as empty strings", () => {
    const out = html`<p>${null}${undefined}</p>`;
    expect(out).toBe("<p></p>");
  });

  it("coerces numbers via String", () => {
    const out = html`<p>${42}</p>`;
    expect(out).toBe("<p>42</p>");
  });
});

/* -------------------------------------------------------------------------- */
/* renderDashboard — content + escaping.                                       */
/* -------------------------------------------------------------------------- */

describe("renderDashboard", () => {
  it("includes the auto-refresh meta tag", () => {
    const out = renderDashboard({ state: emptyState(), recent_events: [] });
    expect(out).toContain(`<meta http-equiv="refresh" content="5">`);
  });

  it("shows generated_at and the totals cards", () => {
    const state = emptyState({
      codex_totals: {
        input_tokens: 5_000,
        output_tokens: 2_400,
        total_tokens: 7_400,
        seconds_running: 1834.2,
      },
    });
    const out = renderDashboard({ state, recent_events: [] });
    expect(out).toContain("2026-02-24T20:15:30.000Z");
    expect(out).toContain("5,000");
    expect(out).toContain("2,400");
    expect(out).toContain("7,400");
    expect(out).toContain("1834.2s");
  });

  it("renders empty placeholders when there are no running / retry / events", () => {
    const out = renderDashboard({ state: emptyState(), recent_events: [] });
    expect(out).toContain("No running sessions.");
    expect(out).toContain("No retries queued.");
    expect(out).toContain("No recent events.");
    expect(out).toContain("No rate-limit info reported.");
  });

  it("renders the running-table row content when a session is active", () => {
    const state = emptyState({
      counts: { running: 1, retrying: 0 },
      running: [
        {
          issue_id: "issue-id-1",
          issue_identifier: "MT-649",
          state: "In Progress",
          session_id: "session-1",
          turn_count: 4,
          last_event: "turn_completed",
          last_message: "",
          started_at: "2026-02-24T20:10:12.000Z",
          last_event_at: "2026-02-24T20:14:59.000Z",
          tokens: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
        },
      ],
    });
    const out = renderDashboard({ state, recent_events: [] });
    expect(out).toContain("MT-649");
    expect(out).toContain("In Progress");
    expect(out).toContain("session-1");
    expect(out).toContain("turn_completed");
  });

  it("HTML-escapes hostile issue identifiers (XSS guard, spec-required)", () => {
    const state = emptyState({
      counts: { running: 1, retrying: 0 },
      running: [
        {
          issue_id: "issue-id-1",
          issue_identifier: "<script>alert(1)</script>",
          state: "<img src=x onerror=alert(1)>",
          session_id: "session-1",
          turn_count: 1,
          last_event: "notification",
          last_message: "<b>injected</b>",
          started_at: "2026-02-24T20:10:12.000Z",
          last_event_at: "2026-02-24T20:14:59.000Z",
          tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      ],
    });
    const out = renderDashboard({ state, recent_events: [] });
    // The literal `<script>` substring must not appear as an actual tag.
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).not.toContain("<img src=x");
    // But the escaped form does.
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders retry-table content", () => {
    const state = emptyState({
      counts: { running: 0, retrying: 1 },
      retrying: [
        {
          issue_id: "issue-id-2",
          issue_identifier: "MT-650",
          attempt: 3,
          due_at: "2026-02-24T20:16:00.000Z",
          error: "no available orchestrator slots",
        },
      ],
    });
    const out = renderDashboard({ state, recent_events: [] });
    expect(out).toContain("MT-650");
    expect(out).toContain("2026-02-24T20:16:00.000Z");
    expect(out).toContain("no available orchestrator slots");
  });

  it("renders rate limit information when present", () => {
    const state = emptyState({
      rate_limits: {
        status: "limited",
        rate_limit_type: "tokens_per_minute",
        utilization: 0.95,
      },
    });
    const out = renderDashboard({ state, recent_events: [] });
    expect(out).toContain("limited");
    expect(out).toContain("tokens_per_minute");
    expect(out).toContain("0.95");
  });

  it("renders recent-event rows and caps at 50", () => {
    const records: Array<LogRecord> = Array.from({ length: 70 }, (_, i) => ({
      timestamp: `2026-02-24T20:15:${String(i % 60).padStart(2, "0")}.000Z`,
      level: "info" as const,
      msg: `event-${i}`,
    }));
    const out = renderDashboard({ state: emptyState(), recent_events: records });
    // The most recent 50 should appear; the oldest 20 should be dropped.
    expect(out).toContain("event-69");
    expect(out).toContain("event-20");
    expect(out).not.toContain("event-19");
    expect(out).not.toContain("event-0");
  });
});
