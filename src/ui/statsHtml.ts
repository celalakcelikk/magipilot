// HTML of the `Magipilot: Show Stats` panel (docs/plans/phase-3-metrics.md M1). Kept free of the
// `vscode` module so it can be unit-tested. The page is static: no script, a CSP that allows only
// styles, and nothing but numbers, fixed labels and escaped backend/model ids — never content.
import type { BackendStats, ChatModelStats } from '../metrics';

export interface StatsView {
  inline: Record<string, BackendStats>;
  chat: Record<string, ChatModelStats>;
  /** `webview.cspSource` of the panel. */
  cspSource: string;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

function count(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n)) : '—';
}

function ms(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n)} ms`;
}

function rate(n: number | undefined): string {
  return n === undefined || !Number.isFinite(n) ? '—' : `${Math.round(n * 100)} %`;
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = headers.map((h, i) => `<th${i === 0 ? ' scope="col"' : ''}>${h}</th>`).join('');
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`,
    )
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sorted<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

export function renderStatsHtml(view: StatsView): string {
  const inline = sorted(view.inline);
  const chat = sorted(view.chat);
  const inlineSection =
    inline.length === 0
      ? '<p class="empty">No inline completions yet.</p>'
      : table(
          [
            'Backend',
            'Requests',
            'Completions',
            'Empty',
            'Errors',
            'Cancelled',
            'Latency p50',
            'Latency p95',
          ],
          inline.map(([id, s]) => [
            escapeHtml(id),
            count(s.requests),
            count(s.completions),
            count(s.empty),
            count(s.errors),
            count(s.cancelled),
            ms(s.p50Ms),
            ms(s.p95Ms),
          ]),
        ) +
        table(
          ['Backend', 'Shown', 'From cache', 'Accepted', 'Acceptance', 'Time to suggestion p50'],
          inline.map(([id, s]) => [
            escapeHtml(id),
            count(s.shown),
            count(s.cacheHits),
            count(s.accepted),
            rate(s.acceptanceRate),
            ms(s.timeToSuggestionP50Ms),
          ]),
        );
  const chatSection =
    chat.length === 0
      ? '<p class="empty">No chat requests yet.</p>'
      : table(
          ['Model', 'Requests', 'Complete', 'Cancelled', 'Errors', 'Duration p50'],
          chat.map(([id, s]) => [
            escapeHtml(id),
            count(s.requests),
            count(s.complete),
            count(s.cancelled),
            count(s.errors),
            ms(s.p50Ms),
          ]),
        );
  const csp = `default-src 'none'; style-src ${view.cspSource} 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Magipilot Stats</title>
<style>
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 16px 16px; }
h1 { font-size: 1.3em; font-weight: 600; }
h2 { font-size: 1.1em; font-weight: 600; margin-top: 1.6em; }
p.note, p.empty { color: var(--vscode-descriptionForeground); }
table { border-collapse: collapse; margin: 0.6em 0 1em; }
th, td { padding: 4px 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
thead th { text-align: right; font-weight: 600; white-space: nowrap; }
thead th:first-child, tbody th { text-align: left; font-weight: normal; }
td { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
</head>
<body>
<h1>Magipilot statistics</h1>
<p class="note">Since this window started. Numbers only, kept in memory: they are never stored or sent anywhere.</p>
<h2>Inline completions</h2>
${inlineSection}
<p class="note">Requests reached the backend; cancelled requests were superseded or cancelled before an answer. Shown counts suggestions handed to the editor, from the backend or the cache.</p>
<h2>Chat</h2>
${chatSection}
</body>
</html>
`;
}
