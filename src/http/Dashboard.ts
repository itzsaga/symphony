// Server-side HTML rendering for the §13.7.1 dashboard at GET /.
// Pure string builders + a tagged-template `html` helper that escapes interpolations.
import type { LogRecord } from "../observability/Logger.ts";
import type {
  ApiRetryEntry,
  ApiRunningEntry,
  ApiState,
} from "./snapshot.ts";

/* -------------------------------------------------------------------------- */
/* HTML escaping primitives.                                                  */
/*                                                                            */
/* The dashboard interpolates strings from arbitrary tracker data (issue      */
/* titles, error messages, last-message echoes from the agent). Every         */
/* interpolated string passes through `escapeHtml`. Numbers/null skip the    */
/* escape but are still coerced via String(). The XSS test in Dashboard.test  */
/* asserts that an issue title with `<script>` renders as literal text.       */
/* -------------------------------------------------------------------------- */

/**
 * Escape the five HTML special characters into entity references. Apostrophe
 * uses `&#39;` rather than `&apos;` because the latter is not part of HTML4.
 * Order matters: `&` must be replaced first so the `&` in entity references
 * introduced by later replacements isn't double-escaped.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Tagged-template helper: every interpolation is coerced to a string and
 * HTML-escaped. Use this for every piece of HTML the dashboard emits so the
 * escaping is impossible to forget.
 *
 * Nested `html` fragments are pre-escaped — to compose, build them with
 * `html\`...\`` and interpolate the resulting string as-is via {@link raw}.
 */
export const html = (
  strings: TemplateStringsArray,
  ...values: ReadonlyArray<unknown>
): string => {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i] ?? "";
    if (i < values.length) {
      const v = values[i];
      if (v === undefined || v === null) {
        out += "";
        continue;
      }
      if (typeof v === "object" && v !== null && "__raw" in v) {
        out += (v as { readonly __raw: string }).__raw;
        continue;
      }
      out += escapeHtml(String(v));
    }
  }
  return out;
};

/**
 * Mark a string as pre-escaped HTML so {@link html} interpolates it
 * verbatim. Use sparingly — only for compositional cases where the inner
 * string is already an `html\`...\`` fragment.
 */
export const raw = (s: string): { readonly __raw: string } => ({ __raw: s });

/* -------------------------------------------------------------------------- */
/* Cell formatters.                                                           */
/* -------------------------------------------------------------------------- */

const fmtSeconds = (s: number): string => {
  // Human-readable runtime totals: keep one decimal place if the value is
  // fractional, none otherwise. Stays operator-friendly without dragging in
  // Intl number formatting.
  if (Number.isInteger(s)) return `${s}s`;
  return `${s.toFixed(1)}s`;
};

const fmtTokens = (n: number): string => n.toLocaleString("en-US");

const fmtMissing = (v: string | null): string => (v === null ? "—" : v);

/* -------------------------------------------------------------------------- */
/* Table sections.                                                            */
/* -------------------------------------------------------------------------- */

const renderRunningRow = (entry: ApiRunningEntry): string => html`
  <tr>
    <td>${entry.issue_identifier}</td>
    <td>${entry.state}</td>
    <td><code>${fmtMissing(entry.session_id)}</code></td>
    <td>${entry.turn_count}</td>
    <td>${fmtMissing(entry.last_event)}</td>
    <td>${fmtMissing(entry.last_event_at)}</td>
    <td>${fmtTokens(entry.tokens.input_tokens)} / ${fmtTokens(
      entry.tokens.output_tokens,
    )} / ${fmtTokens(entry.tokens.total_tokens)}</td>
  </tr>
`;

const renderRunningTable = (running: ReadonlyArray<ApiRunningEntry>): string => {
  if (running.length === 0) {
    return html`<p class="empty">No running sessions.</p>`;
  }
  const rows = running.map(renderRunningRow).join("");
  return html`
    <table class="sessions">
      <thead>
        <tr>
          <th>Identifier</th>
          <th>State</th>
          <th>Session</th>
          <th>Turns</th>
          <th>Last Event</th>
          <th>Last Event At</th>
          <th>Tokens (in / out / total)</th>
        </tr>
      </thead>
      <tbody>${raw(rows)}</tbody>
    </table>
  `;
};

const renderRetryRow = (entry: ApiRetryEntry): string => html`
  <tr>
    <td>${entry.issue_identifier}</td>
    <td>${entry.attempt}</td>
    <td>${entry.due_at}</td>
    <td>${fmtMissing(entry.error)}</td>
  </tr>
`;

const renderRetryTable = (retrying: ReadonlyArray<ApiRetryEntry>): string => {
  if (retrying.length === 0) {
    return html`<p class="empty">No retries queued.</p>`;
  }
  const rows = retrying.map(renderRetryRow).join("");
  return html`
    <table class="retries">
      <thead>
        <tr>
          <th>Identifier</th>
          <th>Attempt</th>
          <th>Due At</th>
          <th>Error</th>
        </tr>
      </thead>
      <tbody>${raw(rows)}</tbody>
    </table>
  `;
};

const renderRateLimits = (info: ApiState["rate_limits"]): string => {
  if (info === null) {
    return html`<p class="empty">No rate-limit info reported.</p>`;
  }
  // Render as a definition list so the operator sees every meaningful field
  // without having to read JSON. Only spell out the fields the spec wire
  // shape declares; unknown extra keys are ignored to keep the rendering
  // predictable.
  const parts: Array<string> = [];
  parts.push(html`<dt>Status</dt><dd>${info.status}</dd>`);
  if (info.rate_limit_type !== undefined) {
    parts.push(html`<dt>Type</dt><dd>${info.rate_limit_type}</dd>`);
  }
  if (info.utilization !== undefined) {
    parts.push(html`<dt>Utilization</dt><dd>${info.utilization}</dd>`);
  }
  if (info.resets_at !== undefined) {
    parts.push(html`<dt>Resets At</dt><dd>${info.resets_at}</dd>`);
  }
  if (info.overage_status !== undefined) {
    parts.push(html`<dt>Overage Status</dt><dd>${info.overage_status}</dd>`);
  }
  return html`<dl class="rate-limits">${raw(parts.join(""))}</dl>`;
};

const renderRecentEventRow = (record: LogRecord): string => {
  const ts = typeof record["timestamp"] === "string" ? record["timestamp"] : "";
  const level = typeof record["level"] === "string" ? record["level"] : "";
  const msgValue = record["msg"];
  const msg = typeof msgValue === "string" ? msgValue : "";
  const issueId =
    typeof record["issue_id"] === "string" ? record["issue_id"] : "";
  const issueIdentifier =
    typeof record["issue_identifier"] === "string"
      ? record["issue_identifier"]
      : "";
  const issueCell = issueIdentifier !== "" ? issueIdentifier : issueId;
  return html`
    <tr>
      <td>${ts}</td>
      <td>${level}</td>
      <td>${fmtMissing(issueCell === "" ? null : issueCell)}</td>
      <td>${msg}</td>
    </tr>
  `;
};

const renderRecentEvents = (
  records: ReadonlyArray<LogRecord>,
): string => {
  if (records.length === 0) {
    return html`<p class="empty">No recent events.</p>`;
  }
  // Take the last 50 by chronological order — the ring buffer already keeps
  // recent-first, but we cap defensively in case the buffer capacity ever
  // grows beyond 50.
  const recent = records.slice(-50);
  const rows = recent.map(renderRecentEventRow).join("");
  return html`
    <table class="events">
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Level</th>
          <th>Issue</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>${raw(rows)}</tbody>
    </table>
  `;
};

/* -------------------------------------------------------------------------- */
/* Stylesheet — inlined so the dashboard is one self-contained document.      */
/*                                                                            */
/* Operator-friendly, monospace-leaning. No JS, no external CSS, no images.   */
/* The dashboard is reachable from a fresh laptop, including offline.         */
/* -------------------------------------------------------------------------- */

const STYLESHEET = `
:root { color-scheme: light dark; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
    sans-serif;
  margin: 1.5rem;
  line-height: 1.4;
}
h1 { margin-top: 0; }
h2 { margin-top: 2rem; }
table { border-collapse: collapse; margin: 0.5rem 0 1rem; min-width: 100%; }
th, td { padding: 0.4rem 0.6rem; text-align: left; vertical-align: top;
  border-bottom: 1px solid rgba(127, 127, 127, 0.25); font-size: 0.9rem; }
th { font-weight: 600; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.85rem; }
.summary { display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 1rem; }
.summary .card { padding: 0.75rem 1rem; border: 1px solid rgba(127,127,127,0.3);
  border-radius: 0.5rem; min-width: 8rem; }
.summary .card h3 { margin: 0 0 0.25rem; font-size: 0.8rem; font-weight: 500;
  text-transform: uppercase; opacity: 0.7; }
.summary .card p { margin: 0; font-size: 1.4rem; font-variant-numeric: tabular-nums; }
.empty { opacity: 0.6; font-style: italic; }
dl.rate-limits { display: grid; grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem; margin: 0.25rem 0; }
dl.rate-limits dt { font-weight: 600; }
dl.rate-limits dd { margin: 0; }
`;

/* -------------------------------------------------------------------------- */
/* Page builder.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Inputs for the dashboard page. Kept separate from the renderer so callers
 * (the route handler) can assemble them once and the renderer stays pure
 * data-in / string-out.
 */
export interface DashboardViewModel {
  readonly state: ApiState;
  readonly recent_events: ReadonlyArray<LogRecord>;
}

/**
 * Render the full dashboard HTML document. Pure string-producing function —
 * no IO, no Effect dependency. The route handler wraps the result in a
 * `text/html` response.
 *
 * The `<meta http-equiv="refresh" content="5">` tag is the v1 answer to the
 * "stays current without JS" requirement: 5 seconds is the spec's
 * recommended idle timeout and works well for operator polling without
 * thrashing the orchestrator's read path.
 */
export const renderDashboard = (model: DashboardViewModel): string => {
  const { state, recent_events } = model;
  const totals = state.codex_totals;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>Symphony</title>
<style>${raw(STYLESHEET)}</style>
</head>
<body>
<h1>Symphony</h1>
<p class="generated">Generated at ${state.generated_at}</p>

<div class="summary">
  <div class="card"><h3>Running</h3><p>${state.counts.running}</p></div>
  <div class="card"><h3>Retrying</h3><p>${state.counts.retrying}</p></div>
  <div class="card"><h3>Input Tokens</h3><p>${fmtTokens(totals.input_tokens)}</p></div>
  <div class="card"><h3>Output Tokens</h3><p>${fmtTokens(totals.output_tokens)}</p></div>
  <div class="card"><h3>Total Tokens</h3><p>${fmtTokens(totals.total_tokens)}</p></div>
  <div class="card"><h3>Runtime</h3><p>${fmtSeconds(totals.seconds_running)}</p></div>
</div>

<h2>Running</h2>
${raw(renderRunningTable(state.running))}

<h2>Retrying</h2>
${raw(renderRetryTable(state.retrying))}

<h2>Rate Limits</h2>
${raw(renderRateLimits(state.rate_limits))}

<h2>Recent Events</h2>
${raw(renderRecentEvents(recent_events))}
</body>
</html>
`;
};
