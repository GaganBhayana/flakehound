/** An XML element with its attributes and children, in document order. */
export interface XmlElement {
  readonly type: 'element';
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

/** Character data. Adjacent text, entities and CDATA sections are merged into one node. */
export interface XmlText {
  readonly type: 'text';
  readonly text: string;
}

/** A node in the parsed tree. Comments and processing instructions are dropped. */
export type XmlNode = XmlElement | XmlText;

/** Why and where parsing failed. Line and column start at 1. */
export interface XmlError {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/** Parse outcome: the root element, or the first error found. */
export type XmlResult = { readonly ok: true; readonly value: XmlElement } | { readonly ok: false; readonly error: XmlError };

/** Limits and switches for {@link parseXml}. */
export interface XmlParseOptions {
  /** Deepest allowed element nesting; the root is depth 1. Defaults to 64. */
  readonly maxDepth?: number;
  /** Largest accepted input in UTF-8 bytes. Defaults to 32 MiB. */
  readonly maxBytes?: number;
  /** Keep text nodes that hold only whitespace. Defaults to false; CDATA is always kept. */
  readonly keepWhitespace?: boolean;
}

/** Defaults for {@link XmlParseOptions}. */
export const XML_DEFAULTS = { maxDepth: 64, maxBytes: 32 * 1024 * 1024, keepWhitespace: false } as const;

const NAME = /[\p{L}_:][\p{L}\p{N}_.:·-]*/uy;
const SPACE = /[ \t\r\n]*/y;
const PREDEFINED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Thrown inside the parser only; {@link parseXml} turns it into an `XmlError`. */
class Fail {
  readonly message: string;
  readonly at: number;
  constructor(message: string, at: number) {
    this.message = message;
    this.at = at;
  }
}

interface Open {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  readonly at: number;
  text: string;
  hasCdata: boolean;
}

function position(input: string, at: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at && i < input.length; i++) {
    if (input.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart + 1 };
}

function validCodePoint(cp: number): boolean {
  return cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/** Replaces entity and character references in raw text that starts at `offset` in the input. */
function decode(raw: string, offset: number): string {
  if (!raw.includes('&')) return raw;
  let out = '';
  let last = 0;
  for (let amp = raw.indexOf('&'); amp !== -1; amp = raw.indexOf('&', last)) {
    out += raw.slice(last, amp);
    const semi = raw.indexOf(';', amp);
    if (semi === -1 || semi - amp > 12) throw new Fail('unterminated entity reference', offset + amp);
    const ref = raw.slice(amp + 1, semi);
    if (ref.startsWith('#')) {
      const hex = /^#x[0-9a-fA-F]+$/.test(ref);
      if (!hex && !/^#[0-9]+$/.test(ref)) throw new Fail(`malformed character reference &${ref};`, offset + amp);
      const cp = Number.parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!validCodePoint(cp)) throw new Fail(`character reference &${ref}; is not a valid XML character`, offset + amp);
      out += String.fromCodePoint(cp);
    } else {
      const value = PREDEFINED[ref];
      if (value === undefined) throw new Fail(`unknown entity &${ref}; (only the five predefined entities are supported)`, offset + amp);
      out += value;
    }
    last = semi + 1;
  }
  return out + raw.slice(last);
}

function readName(input: string, at: number, what: string): string {
  NAME.lastIndex = at;
  const match = NAME.exec(input);
  if (match === null) throw new Fail(`expected ${what} name`, at);
  return match[0];
}

function skipSpace(input: string, at: number): number {
  SPACE.lastIndex = at;
  SPACE.exec(input);
  return SPACE.lastIndex;
}

/** Parses attributes from `at` up to `>` or `/>`. Returns the attributes, the end index and whether the tag self-closes. */
function readAttributes(input: string, at: number): { attributes: Record<string, string>; end: number; selfClosing: boolean } {
  const attributes: Record<string, string> = {};
  let pos = at;
  for (;;) {
    const afterSpace = skipSpace(input, pos);
    if (input.startsWith('/>', afterSpace)) return { attributes, end: afterSpace + 2, selfClosing: true };
    if (input[afterSpace] === '>') return { attributes, end: afterSpace + 1, selfClosing: false };
    if (afterSpace >= input.length) throw new Fail('unexpected end of input inside a tag', afterSpace);
    if (afterSpace === pos) throw new Fail('expected whitespace before attribute', pos);
    const name = readName(input, afterSpace, 'attribute');
    if (Object.hasOwn(attributes, name)) throw new Fail(`duplicate attribute ${name}`, afterSpace);
    pos = skipSpace(input, afterSpace + name.length);
    if (input[pos] !== '=') throw new Fail(`expected = after attribute ${name}`, pos);
    pos = skipSpace(input, pos + 1);
    const quote = input[pos];
    if (quote !== '"' && quote !== "'") throw new Fail(`expected a quoted value for attribute ${name}`, pos);
    const close = input.indexOf(quote, pos + 1);
    if (close === -1) throw new Fail(`unterminated value for attribute ${name}`, pos);
    const raw = input.slice(pos + 1, close);
    const lt = raw.indexOf('<');
    if (lt !== -1) throw new Fail(`'<' is not allowed in attribute ${name}`, pos + 1 + lt);
    const value = decode(raw.replace(/[\t\r\n]/g, ' '), pos + 1);
    // defineProperty keeps a name such as "__proto__" an ordinary own property.
    Object.defineProperty(attributes, name, { value, enumerable: true, writable: true, configurable: true });
    pos = close + 1;
  }
}

function flushText(open: Open, keepWhitespace: boolean): void {
  if (open.text !== '' && (open.hasCdata || keepWhitespace || open.text.trim() !== '')) {
    open.children.push({ type: 'text', text: open.text });
  }
  open.text = '';
  open.hasCdata = false;
}

function skipPast(input: string, at: number, terminator: string, what: string): number {
  const end = input.indexOf(terminator, at);
  if (end === -1) throw new Fail(`unterminated ${what}`, at);
  return end + terminator.length;
}

function parseDocument(input: string, options: Required<XmlParseOptions>): XmlElement {
  const stack: Open[] = [];
  let root: XmlElement | undefined;
  let pos = input.charCodeAt(0) === 0xfeff ? 1 : 0;

  while (pos < input.length) {
    const top = stack.at(-1);
    const lt = input.indexOf('<', pos);
    const textEnd = lt === -1 ? input.length : lt;
    if (textEnd > pos) {
      const raw = input.slice(pos, textEnd);
      if (top === undefined) {
        if (raw.trim() !== '') throw new Fail('text outside the root element', pos + raw.search(/\S/));
      } else {
        top.text += decode(raw, pos);
      }
      pos = textEnd;
      continue;
    }

    if (input.startsWith('<!--', pos)) {
      pos = skipPast(input, pos + 4, '-->', 'comment');
    } else if (input.startsWith('<?', pos)) {
      pos = skipPast(input, pos + 2, '?>', 'processing instruction');
    } else if (input.startsWith('<![CDATA[', pos)) {
      if (top === undefined) throw new Fail('CDATA outside the root element', pos);
      const end = skipPast(input, pos + 9, ']]>', 'CDATA section');
      top.text += input.slice(pos + 9, end - 3);
      top.hasCdata = true;
      pos = end;
    } else if (/^<!doctype/i.test(input.slice(pos, pos + 9))) {
      throw new Fail('DOCTYPE is not allowed (DTDs and external entities are disabled)', pos);
    } else if (input.startsWith('<!', pos)) {
      throw new Fail('unsupported markup declaration', pos);
    } else if (input.startsWith('</', pos)) {
      const name = readName(input, pos + 2, 'closing tag');
      const end = skipSpace(input, pos + 2 + name.length);
      if (input[end] !== '>') throw new Fail(`expected > to close </${name}`, end);
      if (top === undefined) throw new Fail(`unexpected closing tag </${name}>`, pos);
      if (top.name !== name) throw new Fail(`closing tag </${name}> does not match <${top.name}>`, pos);
      flushText(top, options.keepWhitespace);
      stack.pop();
      const element: XmlElement = { type: 'element', name, attributes: top.attributes, children: top.children };
      const parent = stack.at(-1);
      if (parent === undefined) root = element;
      else parent.children.push(element);
      pos = end + 1;
    } else {
      if (top === undefined && root !== undefined) throw new Fail('more than one root element', pos);
      if (stack.length >= options.maxDepth) throw new Fail(`elements nested deeper than ${options.maxDepth}`, pos);
      const name = readName(input, pos + 1, 'element');
      const { attributes, end, selfClosing } = readAttributes(input, pos + 1 + name.length);
      if (top !== undefined) flushText(top, options.keepWhitespace);
      if (selfClosing) {
        const element: XmlElement = { type: 'element', name, attributes, children: [] };
        if (top === undefined) root = element;
        else top.children.push(element);
      } else {
        stack.push({ name, attributes, children: [], at: pos, text: '', hasCdata: false });
      }
      pos = end;
    }
  }

  const unclosed = stack.at(-1);
  if (unclosed !== undefined) throw new Fail(`element <${unclosed.name}> is never closed`, unclosed.at);
  if (root === undefined) throw new Fail('no root element', input.length);
  return root;
}

/**
 * Parses an XML document such as a JUnit report into a tree. Non-validating and safe for
 * untrusted input: DOCTYPE (and so every custom or external entity) is rejected, only the
 * five predefined entities and numeric character references are expanded, and nesting
 * depth and input size are capped. Returns the first error with its line and column.
 * Throws a `RangeError` for invalid options.
 */
export function parseXml(input: string, options: XmlParseOptions = {}): XmlResult {
  const settings = { ...XML_DEFAULTS, ...options };
  for (const key of ['maxDepth', 'maxBytes'] as const) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) {
      throw new RangeError(`${key} must be a positive integer, got ${settings[key]}`);
    }
  }
  // UTF-8 never needs fewer bytes than the string has UTF-16 code units, so the length check can reject early.
  if (input.length > settings.maxBytes || Buffer.byteLength(input, 'utf8') > settings.maxBytes) {
    return { ok: false, error: { message: `input is larger than ${settings.maxBytes} bytes`, line: 1, column: 1 } };
  }
  try {
    return { ok: true, value: parseDocument(input, settings) };
  } catch (error) {
    if (!(error instanceof Fail)) throw error;
    return { ok: false, error: { message: error.message, ...position(input, error.at) } };
  }
}

/** The element's direct child elements, optionally only those with `name`. */
export function childElements(element: XmlElement, name?: string): XmlElement[] {
  return element.children.filter((c): c is XmlElement => c.type === 'element' && (name === undefined || c.name === name));
}

/** All text inside the element and its descendants, concatenated in document order. */
export function textContent(node: XmlNode): string {
  if (node.type === 'text') return node.text;
  let out = '';
  const pending: XmlNode[] = [...node.children].reverse();
  while (pending.length > 0) {
    const next = pending.pop() as XmlNode;
    if (next.type === 'text') out += next.text;
    else for (let i = next.children.length - 1; i >= 0; i--) pending.push(next.children[i] as XmlNode);
  }
  return out;
}
