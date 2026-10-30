import { describe, expect, it } from 'vitest';
import { escapeHtml, renderStatsHtml } from '../../src/ui/statsHtml';
import { ChatStats, Metrics } from '../../src/metrics';

const CSP_SOURCE = 'vscode-webview://abc';

function view(metrics: Metrics, chat: ChatStats) {
  return { inline: metrics.snapshot(), chat: chat.snapshot(), cspSource: CSP_SOURCE };
}

describe('renderStatsHtml', () => {
  it('renders the inline and chat numbers of the window', () => {
    const metrics = new Metrics();
    metrics.recordRequest('ollama', 'completion', 120);
    metrics.recordRequest('ollama', 'cancelled', 40);
    metrics.recordShown('ollama', { fromCache: false, ms: 330 });
    metrics.recordShown('ollama', { fromCache: true, ms: 4 });
    metrics.recordAccepted('ollama');
    const chat = new ChatStats();
    chat.record('claude-cli.haiku', 'complete', 2400);
    chat.record('claude-cli.haiku', 'error', 100);
    const html = renderStatsHtml(view(metrics, chat));
    expect(html).toContain(
      '<th scope="row">ollama</th><td>2</td><td>1</td><td>0</td><td>0</td><td>1</td><td>120 ms</td><td>120 ms</td>',
    );
    expect(html).toContain(
      '<th scope="row">ollama</th><td>2</td><td>1</td><td>1</td><td>50 %</td><td>4 ms</td>',
    );
    expect(html).toContain(
      '<th scope="row">claude-cli.haiku</th><td>2</td><td>1</td><td>0</td><td>1</td><td>100 ms</td>',
    );
    expect(html).toContain('Since this window started');
  });

  it('says so when there is nothing yet', () => {
    const html = renderStatsHtml(view(new Metrics(), new ChatStats()));
    expect(html).toContain('No inline completions yet.');
    expect(html).toContain('No chat requests yet.');
    expect(html).not.toContain('<table');
  });

  it('shows a dash for a value that does not exist yet', () => {
    const metrics = new Metrics();
    metrics.recordRequest('codex-cli', 'error', 500);
    const html = renderStatsHtml(view(metrics, new ChatStats()));
    expect(html).toContain(
      '<th scope="row">codex-cli</th><td>0</td><td>0</td><td>0</td><td>—</td><td>—</td>',
    );
  });

  it('escapes backend and model ids', () => {
    const metrics = new Metrics();
    metrics.recordRequest('<img src=x onerror=alert(1)>', 'completion', 1);
    const chat = new ChatStats();
    chat.record('"model"&\'x\'', 'complete', 1);
    const html = renderStatsHtml(view(metrics, chat));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;model&quot;&amp;&#39;x&#39;');
  });

  it('has a CSP that allows only styles, and no script', () => {
    const html = renderStatsHtml(view(new Metrics(), new ChatStats()));
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)?.[1];
    expect(csp).toBe(`default-src 'none'; style-src ${CSP_SOURCE} 'unsafe-inline';`);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
