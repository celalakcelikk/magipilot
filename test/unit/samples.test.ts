import { describe, expect, it } from 'vitest';
import {
  codexCompletionPrompt,
  completionUserPrompt,
  CURSOR,
  qwenFimPrompt,
} from '../../scripts/bench/prompt';
import { loadSamples, parseSample } from '../../scripts/bench/samples';

describe('bench samples', () => {
  const samples = loadSamples();

  it('has 20 samples with unique ids and a non-empty expected middle', () => {
    expect(samples).toHaveLength(20);
    expect(new Set(samples.map((s) => s.id)).size).toBe(20);
    for (const sample of samples) {
      expect(sample.expected.trim(), sample.id).not.toBe('');
      expect(sample.prefix.length, sample.id).toBeGreaterThan(0);
    }
  });

  it('stays within the PLAN §8 context limits (3000 / 1000 chars)', () => {
    for (const sample of samples) {
      expect(sample.prefix.length, sample.id).toBeLessThanOrEqual(3000);
      expect(sample.suffix.length, sample.id).toBeLessThanOrEqual(1000);
    }
  });

  it('covers the planned language mix', () => {
    const counts: Record<string, number> = {};
    for (const s of samples) counts[s.languageId] = (counts[s.languageId] ?? 0) + 1;
    expect(counts).toEqual({ typescript: 6, python: 5, go: 3, rust: 2, java: 2, javascript: 2 });
  });

  it('rejects files without exactly one FILL region', () => {
    expect(() => parseSample('x.ts', 'no marker')).toThrow();
    expect(() => parseSample('x.ts', '<FILL>a</FILL><FILL>b</FILL>')).toThrow();
    expect(() => parseSample('x.kt', '<FILL>a</FILL>')).toThrow();
    expect(parseSample('01-a.py', 'p<FILL>m</FILL>s')).toEqual({
      id: '01-a',
      languageId: 'python',
      filePath: 'src/a.py',
      prefix: 'p',
      expected: 'm',
      suffix: 's',
    });
  });
});

describe('bench prompts', () => {
  const sample = parseSample('01-a.py', 'def f():\n    <FILL>return 1</FILL>\n');

  it('puts exactly one cursor marker between prefix and suffix', () => {
    const prompt = completionUserPrompt(sample);
    expect(prompt.split(CURSOR)).toHaveLength(2);
    expect(prompt).toContain(`def f():\n    ${CURSOR}\n`);
    expect(prompt).not.toContain('return 1');
    expect(codexCompletionPrompt(sample)).toContain('code completion engine');
  });

  it('builds Qwen FIM token prompts', () => {
    expect(qwenFimPrompt(sample)).toBe(
      '<|fim_prefix|>def f():\n    <|fim_suffix|>\n<|fim_middle|>',
    );
  });
});
