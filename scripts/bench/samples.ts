// Loads the fill-in-the-middle bench samples from test/fixtures/bench/samples/.
// Each sample is a source file with exactly one `<FILL>expected</FILL>` region.
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface BenchSample {
  id: string;
  languageId: string;
  /** Virtual workspace-relative path shown to the model. */
  filePath: string;
  prefix: string;
  suffix: string;
  expected: string;
}

export const SAMPLES_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'bench', 'samples');

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.js': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

const OPEN = '<FILL>';
const CLOSE = '</FILL>';

export function parseSample(fileName: string, text: string): BenchSample {
  const open = text.indexOf(OPEN);
  const close = text.indexOf(CLOSE);
  if (open < 0 || close < open || text.indexOf(OPEN, open + 1) >= 0) {
    throw new Error(`${fileName}: expected exactly one ${OPEN}…${CLOSE} region`);
  }
  const extension = extname(fileName);
  const languageId = LANGUAGE_BY_EXTENSION[extension];
  if (!languageId) {
    throw new Error(`${fileName}: unsupported extension ${extension}`);
  }
  const id = fileName.slice(0, -extension.length);
  return {
    id,
    languageId,
    filePath: `src/${id.replace(/^\d+-/, '')}${extension}`,
    prefix: text.slice(0, open),
    expected: text.slice(open + OPEN.length, close),
    suffix: text.slice(close + CLOSE.length),
  };
}

export function loadSamples(dir: string = SAMPLES_DIR): BenchSample[] {
  return readdirSync(dir)
    .filter((name) => LANGUAGE_BY_EXTENSION[extname(name)] !== undefined)
    .sort()
    .map((name) => parseSample(name, readFileSync(join(dir, name), 'utf8')));
}
