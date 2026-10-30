// Declarations without bodies from a source file (docs/plans/phase-3-context.md C2). A line and
// bracket-depth heuristic on a copy of the text whose comments and string contents are blanked
// (same length, newlines kept), so every slice comes from the original text. No parser dependency.
// Every scan is bounded, because the extraction is synchronous and no deadline can stop it
// (security review S1): bracket matching, the declarations of a file and the members of a class.
import type { ImportLanguage, Wanted } from './imports';
import { maskCode } from './mask';

export interface Declaration {
  /** Undefined for an anonymous default export. */
  name?: string;
  isDefault: boolean;
  text: string;
}

const OPEN = '([{';
const CLOSE = ')]}';
/** A bracket closed further away than this counts as unclosed. */
const MATCH_LIMIT = 20_000;
/** Declarations looked at per file, and members per class. */
const MAX_DECLARATIONS = 200;
const MAX_MEMBERS = 100;

/** Index of the bracket that closes the one at `open`, or -1. */
function matchClose(masked: string, open: number): number {
  let depth = 0;
  const end = Math.min(masked.length, open + MATCH_LIMIT);
  for (let i = open; i < end; i++) {
    const c = masked[i]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Bracket depth at the start of every line. */
function lineDepths(masked: string): { starts: number[]; depths: number[] } {
  const starts = [0];
  const depths = [0];
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth = Math.max(0, depth - 1);
    else if (c === '\n') {
      starts.push(i + 1);
      depths.push(depth);
    }
  }
  return { starts, depths };
}

/** Previous non-space character before `index`, looking back at most 200 characters. */
function before(masked: string, index: number): string {
  for (let i = index - 1; i >= Math.max(0, index - 200); i--) {
    if (!/\s/.test(masked[i]!)) return masked[i]!;
  }
  return '';
}

/**
 * The `{` that opens a body, scanning from `from` at bracket depth 0, or the `;` that ends a
 * declaration without one. A `{` after `:`, `|`, `&`, `<`, `,`, `(`, `[` or `=` starts a type
 * literal or a value, not a body, and is skipped whole.
 */
function bodyOrEnd(masked: string, from: number, limit = 4000): { index: number; body: boolean } {
  const end = Math.min(masked.length, from + limit);
  for (let i = from; i < end; i++) {
    const c = masked[i]!;
    if (c === ';') return { index: i, body: false };
    if (c === '{') {
      if (':|&<,([='.includes(before(masked, i))) {
        const close = matchClose(masked, i);
        if (close < 0) return { index: -1, body: false };
        i = close;
        continue;
      }
      return { index: i, body: true };
    }
    if (c === '(' || c === '[') {
      const close = matchClose(masked, i);
      if (close < 0) return { index: -1, body: false };
      i = close;
    }
  }
  return { index: -1, body: false };
}

/** The end of a statement without a body: `;` at depth 0, or a line end not continued. */
function statementEnd(masked: string, from: number, limit = 4000): number {
  const end = Math.min(masked.length, from + limit);
  let depth = 0;
  let last = '';
  for (let i = from; i < end; i++) {
    const c = masked[i]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    if (depth === 0 && c === ';') return i + 1;
    if (depth === 0 && c === '\n') {
      let j = i + 1;
      while (j < end && /\s/.test(masked[j]!)) j++;
      const next = j < end ? masked[j]! : '';
      const continued = '=|&,(:?'.includes(last) || (next !== '' && '|&.?:='.includes(next));
      if (!continued) return i;
    }
    if (!/\s/.test(c)) last = c;
  }
  return end;
}

const NAME = '[A-Za-z_$][\\w$]*';

function tsMembers(text: string, masked: string, open: number, close: number): string[] {
  const members: string[] = [];
  const body = masked.slice(open + 1, close);
  const { starts, depths } = lineDepths(body);
  for (let line = 0; line < starts.length && members.length < MAX_MEMBERS; line++) {
    if (depths[line] !== 0) continue;
    const lineText = body.slice(starts[line], starts[line + 1] ?? body.length);
    const indent = lineText.search(/\S/);
    if (indent < 0) continue;
    const s = open + 1 + starts[line]! + indent;
    const head = masked.slice(s, s + 120);
    if (/^(private\b|#|@|static\s*\{|\}|;)/.test(head)) continue;
    if (
      !new RegExp(
        `^(?:(?:public|protected|static|readonly|abstract|override|declare|async|get|set)\\s+)*\\*?\\s*(?:${NAME}|\\[)`,
      ).test(head)
    )
      continue;
    // A method has a parameter list before its body; a property ends at `=`, `;` or the line end.
    // Decided on the member's first line, before its `;`: a later member's `(` must not count.
    const first = /^[^;\n]*/.exec(head)![0];
    const eq = /^[^=(;\n]*=(?!>)/.exec(first);
    const paren = first.search(/\(/);
    if (paren >= 0 && (eq === null || paren < eq[0].length)) {
      const params = s + paren;
      const after = matchClose(masked, params);
      if (after < 0) continue;
      const found = bodyOrEnd(masked, after + 1);
      const stop = found.index < 0 ? after + 1 : found.index;
      members.push(`${text.slice(s, stop).trimEnd()};`);
    } else {
      const stop = eq ? s + eq[0].length - 1 : statementEnd(masked, s);
      members.push(`${text.slice(s, stop).trimEnd().replace(/;$/, '')};`);
    }
  }
  return members;
}

function tsDeclaration(text: string, masked: string, s: number): Declaration | undefined {
  const prefix = /^(?:export\s+)?(default\s+)?(?:declare\s+)?/.exec(masked.slice(s))!;
  const isDefault = prefix[1] !== undefined;
  const k = s + prefix[0].length;
  const rest = masked.slice(k, k + 200);
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^(?:async\\s+)?function\\b\\s*\\*?\\s*(${NAME})?`).exec(rest))) {
    const params = masked.indexOf('(', k + m[0].length);
    if (params < 0) return undefined;
    const close = matchClose(masked, params);
    if (close < 0) return undefined;
    const found = bodyOrEnd(masked, close + 1);
    const stop = found.index < 0 ? close + 1 : found.index;
    return { name: m[1], isDefault, text: `${text.slice(s, stop).trimEnd()};` };
  }
  if ((m = new RegExp(`^(?:abstract\\s+)?class\\b\\s*(${NAME})?`).exec(rest))) {
    const found = bodyOrEnd(masked, k + m[0].length);
    if (!found.body) return undefined;
    const close = matchClose(masked, found.index);
    if (close < 0) return undefined;
    const members = tsMembers(text, masked, found.index, close);
    const header = text.slice(s, found.index).trimEnd();
    return {
      name: m[1],
      isDefault,
      text: members.length
        ? `${header} {\n${members.map((x) => `  ${x}`).join('\n')}\n}`
        : `${header} {}`,
    };
  }
  if ((m = new RegExp(`^(?:interface\\s+|(?:const\\s+)?enum\\s+)(${NAME})`).exec(rest))) {
    const open = masked.indexOf('{', k + m[0].length);
    const close = open < 0 ? -1 : matchClose(masked, open);
    if (close < 0) return undefined;
    return { name: m[1], isDefault, text: text.slice(s, close + 1) };
  }
  if ((m = new RegExp(`^type\\s+(${NAME})`).exec(rest))) {
    const stop = statementEnd(masked, k);
    return { name: m[1], isDefault, text: text.slice(s, stop).trimEnd() };
  }
  if ((m = new RegExp(`^(?:const|let|var)\\s+(${NAME})`).exec(rest))) {
    const after = k + m[0].length;
    const end = statementEnd(masked, after);
    const tail = masked.slice(after, end);
    const annotation = /^\s*:/.test(tail);
    const eq = tail.search(/=(?!>)/);
    if (annotation) {
      const stop = eq < 0 ? end : after + eq;
      return { name: m[1], isDefault, text: `${text.slice(s, stop).trimEnd().replace(/;$/, '')};` };
    }
    if (eq < 0)
      return { name: m[1], isDefault, text: `${text.slice(s, end).trimEnd().replace(/;$/, '')};` };
    const rhsStart = after + eq + 1;
    const rhs = masked.slice(rhsStart, end);
    // An arrow function: keep its parameters and return type.
    const arrow = /^\s*(?:async\s+)?(?:\(|[A-Za-z_$][\w$]*\s*=>)/.exec(rhs);
    if (arrow) {
      let i = rhsStart + rhs.search(/\S/);
      if (/^async\s/.test(masked.slice(i, i + 6))) {
        i += 5;
        while (/\s/.test(masked[i] ?? '')) i++;
      }
      if (masked[i] === '(') {
        const close = matchClose(masked, i);
        const arrowAt = close < 0 ? -1 : masked.indexOf('=>', close);
        if (arrowAt >= 0 && arrowAt < end) {
          return { name: m[1], isDefault, text: `${text.slice(s, arrowAt + 2).trimEnd()} …;` };
        }
      } else {
        const arrowAt = masked.indexOf('=>', i);
        if (arrowAt >= 0 && arrowAt < end) {
          return { name: m[1], isDefault, text: `${text.slice(s, arrowAt + 2).trimEnd()} …;` };
        }
      }
    }
    if (/^\s*(?:async\s+)?function\b/.test(rhs)) {
      const params = masked.indexOf('(', rhsStart);
      const close = params < 0 ? -1 : matchClose(masked, params);
      if (close >= 0) {
        const found = bodyOrEnd(masked, close + 1);
        const stop = found.index < 0 ? close + 1 : found.index;
        return { name: m[1], isDefault, text: `${text.slice(s, stop).trimEnd()};` };
      }
    }
    return { name: m[1], isDefault, text: `${text.slice(s, rhsStart - 1).trimEnd()} = …;` };
  }
  return undefined;
}

const LOCAL_DECLARATION =
  /^(?:declare\s+)?(?:async\s+function\b|function\b|(?:abstract\s+)?class\b|interface\s|type\s|(?:const\s+)?enum\s|(?:const|let|var)\s)/;

/**
 * `export { a, b as c }` (without `from`) and `export default a;`: exported name → local name.
 * A re-export (`export { a } from './x'`) is not a declaration of this file.
 */
function exportList(masked: string, s: number): { local: string; exported: string }[] {
  const open = masked.indexOf('{', s);
  const close = open < 0 ? -1 : matchClose(masked, open);
  if (close < 0 || /^\s*from\b/.test(masked.slice(close + 1, close + 40))) return [];
  return masked
    .slice(open + 1, close)
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/),
    )
    .filter((names) => new RegExp(`^${NAME}$`).test(names[0]!.trim()))
    .map(([local, exported]) => ({ local: local!.trim(), exported: (exported ?? local!).trim() }));
}

function tsDeclarations(text: string): Declaration[] {
  const masked = maskCode(text, 'ts');
  const { starts, depths } = lineDepths(masked);
  const lineStart = (line: number): number | undefined => {
    if (depths[line] !== 0) return undefined;
    const lineText = masked.slice(starts[line], starts[line + 1] ?? masked.length);
    const indent = lineText.search(/\S/);
    return indent < 0 ? undefined : starts[line]! + indent;
  };
  const exported = starts.some((_, line) => {
    const s = lineStart(line);
    return s !== undefined && /^export\b/.test(masked.slice(s, s + 7));
  });
  const declarations: Declaration[] = [];
  const locals = new Map<string, Declaration>();
  const listed: { local: string; exported: string }[] = [];
  let looked = 0;
  for (let line = 0; line < starts.length && looked < MAX_DECLARATIONS; line++) {
    const s = lineStart(line);
    if (s === undefined) continue;
    const head = masked.slice(s, s + 60);
    if (!exported) {
      // A file without ES exports (CommonJS): its top-level functions and classes.
      if (!/^(?:async\s+)?function\b|^class\b/.test(head)) continue;
      looked++;
      const declaration = tsDeclaration(text, masked, s);
      if (declaration) declarations.push(declaration);
      continue;
    }
    if (/^export\s*(?:type\s*)?\{/.test(head)) {
      listed.push(...exportList(masked, s));
      continue;
    }
    const defaultName = new RegExp(`^export\\s+default\\s+(${NAME})\\s*(?:;|$)`, 'm').exec(head);
    if (defaultName && !/^(?:async|function|class|abstract)$/.test(defaultName[1]!)) {
      listed.push({ local: defaultName[1]!, exported: 'default' });
      continue;
    }
    const isExport = /^export\b/.test(head);
    if (!isExport && !LOCAL_DECLARATION.test(head)) continue;
    looked++;
    const declaration = tsDeclaration(text, masked, s);
    if (!declaration) continue;
    if (isExport) declarations.push(declaration);
    // Every named declaration, exported or not, can be named again by an export list or
    // `export default name;` (CTX-I009).
    if (declaration.name !== undefined) locals.set(declaration.name, declaration);
  }
  // Locals exported by a list or `export default name;`, under their exported names.
  for (const { local, exported: name } of listed) {
    const declaration = locals.get(local);
    if (!declaration) continue;
    if (name === 'default') {
      declarations.push({ isDefault: true, text: `${declaration.text}\nexport default ${local};` });
    } else {
      const alias = name === local ? '' : `\nexport { ${local} as ${name} };`;
      declarations.push({ name, isDefault: false, text: `${declaration.text}${alias}` });
    }
  }
  return declarations;
}

/** End of a Python header: the `:` at bracket depth 0 after `from`. */
function pythonHeaderEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length && i < from + 4000; i++) {
    const c = masked[i]!;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

function pythonDeclarations(text: string): Declaration[] {
  const masked = maskCode(text, 'python');
  const { starts, depths } = lineDepths(masked);
  const lines = starts.map((start, i) =>
    masked.slice(start, (starts[i + 1] ?? masked.length + 1) - 1),
  );
  const indentOf = (line: number): number => {
    const indent = lines[line]!.search(/\S/);
    return indent < 0 ? -1 : indent;
  };
  const decoratorsBefore = (line: number, indent: number): string[] => {
    const found: string[] = [];
    for (let i = line - 1; i >= 0; i--) {
      if (indentOf(i) !== indent || !lines[i]!.trimStart().startsWith('@')) break;
      found.unshift(text.slice(starts[i], starts[i]! + lines[i]!.length).trimEnd());
    }
    return found;
  };
  const header = (line: number): { text: string; end: number } | undefined => {
    const s = starts[line]! + indentOf(line);
    const colon = pythonHeaderEnd(masked, s);
    if (colon < 0) return undefined;
    return { text: text.slice(starts[line], colon + 1), end: colon };
  };
  const declarations: Declaration[] = [];
  for (let line = 0; line < lines.length && declarations.length < MAX_DECLARATIONS; line++) {
    if (depths[line] !== 0 || indentOf(line) !== 0) continue;
    const def = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(lines[line]!);
    const cls = /^class\s+([A-Za-z_]\w*)/.exec(lines[line]!);
    if (!def && !cls) continue;
    const head = header(line);
    if (!head) continue;
    const decorators = decoratorsBefore(line, 0);
    if (def) {
      declarations.push({
        name: def[1],
        isDefault: false,
        text: [...decorators, `${head.text} ...`].join('\n'),
      });
      continue;
    }
    // Class body: the lines indented deeper than the class, up to the next top-level line.
    const members: string[] = [];
    let bodyIndent = -1;
    for (let i = line + 1; i < lines.length && members.length < MAX_MEMBERS; i++) {
      const indent = indentOf(i);
      if (indent < 0) continue;
      if (indent === 0 && depths[i] === 0) break;
      if (depths[i] !== 0) continue;
      if (bodyIndent < 0) bodyIndent = indent;
      if (indent !== bodyIndent) continue;
      const trimmed = lines[i]!.trimStart();
      const method = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
      if (method) {
        if (method[1]!.startsWith('_') && method[1] !== '__init__') continue;
        const methodHead = header(i);
        if (!methodHead) continue;
        members.push(...decoratorsBefore(i, bodyIndent), `${methodHead.text} ...`);
        continue;
      }
      const field = /^([A-Za-z]\w*)\s*:(?!=)/.exec(trimmed);
      if (field) {
        const raw = text.slice(starts[i], starts[i]! + lines[i]!.length);
        const eq = lines[i]!.search(/(?<![=!<>])=(?!=)/);
        members.push((eq < 0 ? raw : raw.slice(0, eq)).trimEnd());
      }
    }
    declarations.push({
      name: cls![1],
      isDefault: false,
      text: [
        ...decorators,
        members.length ? `${head.text}\n${members.join('\n')}` : `${head.text} ...`,
      ].join('\n'),
    });
  }
  return declarations;
}

/** Every declaration of a file, in source order. */
export function extractDeclarations(language: ImportLanguage, text: string): Declaration[] {
  return language === 'ts' ? tsDeclarations(text) : pythonDeclarations(text);
}

/**
 * The declarations an import asks for, joined and cut at a line end to `maxChars`: named imports
 * keep only their names; otherwise every public declaration (Python names starting with `_` are
 * private).
 */
export function renderDeclarations(
  declarations: readonly Declaration[],
  wanted: Wanted,
  language: ImportLanguage,
  maxChars: number,
): string {
  const chosen = declarations.filter((declaration) => {
    if (wanted.names === undefined) {
      return !(language === 'python' && declaration.name?.startsWith('_'));
    }
    return (
      (declaration.name !== undefined && wanted.names.includes(declaration.name)) ||
      (wanted.default === true && declaration.isDefault)
    );
  });
  const lines = chosen.flatMap((declaration) => declaration.text.split('\n'));
  let text = '';
  for (const line of lines) {
    const next = text === '' ? line : `${text}\n${line}`;
    if (next.length > maxChars) break;
    text = next;
  }
  return text;
}
