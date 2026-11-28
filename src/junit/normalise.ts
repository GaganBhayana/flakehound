import { createHash } from 'node:crypto';
import { childElements, parseXml, textContent, type XmlElement, type XmlParseOptions } from '../xml/parse.ts';

/** Outcome of one test case. */
export type TestStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** One test case from a JUnit report, in the same shape whatever framework wrote it. */
export interface TestResult {
  /** Stable 16-hex-char id from suite, classname, name and file. Equal across runs of the same test. */
  readonly id: string;
  /** Enclosing `<testsuite>` names, outermost first, joined with ` / `. Empty when the report has none. */
  readonly suite: string;
  /** The `classname` attribute (a class, module or package), when present and not empty. */
  readonly classname?: string;
  readonly name: string;
  /**
   * Repository-relative path of the test file, when the report gives or implies one.
   * Unset when the path is absolute (and not under `rootDir`) or has a `..` segment.
   */
  readonly file?: string;
  readonly status: TestStatus;
  /** Wall time in whole milliseconds; 0 when missing or invalid. */
  readonly durationMs: number;
  /** Short failure, error or skip reason. */
  readonly message?: string;
  /** Full failure or error text, usually the stack trace. */
  readonly stack?: string;
  /** The case's `system-out` and `system-err`, joined. */
  readonly output?: string;
  /**
   * Failed attempts that Surefire recorded besides the final outcome (`flakyFailure`,
   * `flakyError`, `rerunFailure`, `rerunError`). On a `passed` result these are the failed
   * attempts before it passed in the same job; on a `failed` or `error` result they are the
   * reruns that failed too.
   */
  readonly rerunFailures?: number;
}

/** Why a report could not be read. Line and column are set for XML syntax errors. */
export interface JunitError {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

/** Options for {@link normaliseJunitTree}. */
export interface JunitOptions {
  /**
   * Absolute path of the checkout (for example `GITHUB_WORKSPACE`). Absolute file paths
   * under it become repository-relative, so ids match across runners. Compared
   * case-insensitively when it starts with a drive letter.
   */
  readonly rootDir?: string;
}

/** Options for {@link normaliseJunit}: XML limits plus {@link JunitOptions}. */
export interface NormaliseOptions extends XmlParseOptions, JunitOptions {}

/** Outcome of {@link normaliseJunit}. */
export type JunitResult = { readonly ok: true; readonly results: readonly TestResult[] } | { readonly ok: false; readonly error: JunitError };

/** Longest `message` kept; longer ones are cut and end with `…`. */
export const MAX_MESSAGE_LENGTH = 1_000;
/** Longest `stack` or `output` kept; longer ones are cut and end with `…`. */
export const MAX_TEXT_LENGTH = 16_000;

const RERUN_ELEMENTS = new Set(['flakyFailure', 'flakyError', 'rerunFailure', 'rerunError']);
/** Extensions that mark a `classname` or suite name as a test file path (Vitest, Jest with file names). */
const TEST_FILE = /\.(?:[cm]?[jt]sx?|py|rb|go|java|kt|cs|php|rs|exs?)$/;

/**
 * Parses a JUnit XML report and returns one {@link TestResult} per `<testcase>`. Each suite's
 * own cases come first, in document order, followed by the cases of its nested suites, suite
 * by suite. Accepts a `<testsuites>` or a bare `<testsuite>` root and nested suites, as written
 * by jest-junit, Vitest, pytest, gotestsum, Maven Surefire and rspec_junit_formatter.
 * A case with `<failure>` is `failed`, else with `<error>` is `error`, else with `<skipped>`
 * is `skipped`, else `passed`. Repeated cases (retries) are kept and share an id.
 * Throws a `RangeError` when `rootDir` is not an absolute path.
 */
export function normaliseJunit(xml: string, options: NormaliseOptions = {}): JunitResult {
  const { rootDir, ...xmlOptions } = options;
  const root = checkRootDir(rootDir);
  const parsed = parseXml(xml, xmlOptions);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return walk(parsed.value, root);
}

/** Like {@link normaliseJunit} for an already parsed document. */
export function normaliseJunitTree(root: XmlElement, options: JunitOptions = {}): JunitResult {
  return walk(root, checkRootDir(options.rootDir));
}

function walk(root: XmlElement, rootDir: string | undefined): JunitResult {
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    return { ok: false, error: { message: `not a JUnit report: root element is <${root.name}>, expected <testsuites> or <testsuite>` } };
  }
  const results: TestResult[] = [];
  const pending: { element: XmlElement; suites: readonly string[]; file: string | undefined }[] = [{ element: root, suites: [], file: undefined }];
  while (pending.length > 0) {
    const { element, suites, file } = pending.pop() as (typeof pending)[number];
    const isSuite = element.name === 'testsuite';
    const name = isSuite ? element.attributes['name']?.trim() : undefined;
    const path = name ? [...suites, name] : suites;
    const suiteFile = (isSuite ? repoPath(element.attributes['file'], rootDir) : undefined) ?? file;
    const children = element.children.filter((c): c is XmlElement => c.type === 'element');
    const nested: typeof pending = [];
    for (const child of children) {
      if (child.name === 'testcase') results.push(toResult(child, path, suiteFile, rootDir));
      else if (child.name === 'testsuite') nested.push({ element: child, suites: path, file: suiteFile });
    }
    // Keep document order: cases of this suite first, then nested suites in order.
    for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i] as (typeof pending)[number]);
  }
  return { ok: true, results };
}

function toResult(testcase: XmlElement, suites: readonly string[], suiteFile: string | undefined, rootDir: string | undefined): TestResult {
  const suite = suites.join(' / ');
  const attrs = testcase.attributes;
  const name = (attrs['name'] ?? '').trim();
  const classname = attrs['classname']?.trim() || undefined;
  const file = repoPath(attrs['file'], rootDir) ?? suiteFile ?? inferFile(classname, rootDir) ?? inferFile(suites.at(-1), rootDir);
  const outcome = findOutcome(testcase);
  const output = [...childElements(testcase, 'system-out'), ...childElements(testcase, 'system-err')]
    .map((e) => trimXmlSpace(textContent(e)))
    .filter((s) => s !== '')
    .join('\n');
  const reruns = testcase.children.filter((c) => c.type === 'element' && RERUN_ELEMENTS.has(c.name)).length;
  return {
    id: testId(suite, classname, name, file),
    suite,
    ...(classname === undefined ? {} : { classname }),
    name,
    ...(file === undefined ? {} : { file }),
    status: outcome.status,
    durationMs: parseDuration(attrs['time']),
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
    ...(outcome.stack === undefined ? {} : { stack: outcome.stack }),
    ...(output === '' ? {} : { output: cut(output, MAX_TEXT_LENGTH) }),
    ...(reruns === 0 ? {} : { rerunFailures: reruns }),
  };
}

function findOutcome(testcase: XmlElement): { status: TestStatus; message?: string; stack?: string } {
  const steps: [string, TestStatus][] = [['failure', 'failed'], ['error', 'error'], ['skipped', 'skipped']];
  for (const [tag, status] of steps) {
    const element = childElements(testcase, tag)[0];
    if (element === undefined) continue;
    const body = trimXmlSpace(textContent(element));
    const message = trimXmlSpace(element.attributes['message'] ?? '') || firstLine(body);
    return {
      status,
      ...(message === '' ? {} : { message: cut(message, MAX_MESSAGE_LENGTH) }),
      ...(body === '' ? {} : { stack: cut(body, MAX_TEXT_LENGTH) }),
    };
  }
  return { status: 'passed' };
}

/** Stable id for a test: the first 16 hex chars of SHA-256 over its identifying fields. */
export function testId(suite: string, classname: string | undefined, name: string, file: string | undefined): string {
  return createHash('sha256').update(JSON.stringify([suite, classname ?? '', name, file ?? ''])).digest('hex').slice(0, 16);
}

/**
 * Seconds as written in a `time` attribute to whole milliseconds. Accepts thousands
 * separators (`1,234.5`, written by some Surefire versions); anything else invalid is 0.
 */
export function parseDuration(time: string | undefined): number {
  if (time === undefined) return 0;
  let value = time.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(value)) value = value.replaceAll(',', '');
  if (!/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$|^\.\d+$/.test(value)) return 0;
  const ms = Math.round(Number(value) * 1000);
  return Number.isSafeInteger(ms) ? ms : 0;
}

/** A path starting with `/` (POSIX or UNC) or a drive letter (`C:`), after `\\` became `/`. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:)/;
const DRIVE = /^[A-Za-z]:/;

/** Validates `rootDir` and returns it with forward slashes and no trailing slash. */
function checkRootDir(rootDir: string | undefined): string | undefined {
  if (rootDir === undefined) return undefined;
  const value = slashes(rootDir.trim()).replace(/\/+$/, '');
  if (!ABSOLUTE.test(value) || value === '' || /^[A-Za-z]:$/.test(value)) {
    throw new RangeError(`rootDir must be an absolute path below the filesystem root, got ${JSON.stringify(rootDir.slice(0, 200))}`);
  }
  return value;
}

/**
 * Turns a file attribute into a repository-relative path: forward slashes, no `.` or empty
 * segments, `rootDir` removed from absolute paths. Returns undefined when the path is empty,
 * still absolute, or has a `..` segment.
 */
function repoPath(path: string | undefined, rootDir: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  let value = slashes(path.trim());
  if (rootDir !== undefined && ABSOLUTE.test(value)) {
    const caseless = DRIVE.test(rootDir);
    const head = value.slice(0, rootDir.length + 1);
    const prefix = rootDir + '/';
    if (caseless ? head.toLowerCase() === prefix.toLowerCase() : head === prefix) value = value.slice(prefix.length);
  }
  if (ABSOLUTE.test(value)) return undefined;
  const segments = value.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return undefined;
  return segments.join('/');
}

function slashes(path: string): string {
  return path.replaceAll('\\', '/');
}

/** Treats a classname or suite name as a file path when it ends in a source extension. */
function inferFile(value: string | undefined, rootDir: string | undefined): string | undefined {
  if (value === undefined || /\s/.test(value) || !TEST_FILE.test(value)) return undefined;
  return repoPath(value, rootDir);
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? '' : line.trim();
}

/** Trims XML whitespace (space, tab, CR, LF) in linear time; `trim()` would also drop U+00A0. */
function trimXmlSpace(text: string): string {
  const space = (i: number) => {
    const c = text.charCodeAt(i);
    return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
  };
  let start = 0;
  let end = text.length;
  while (start < end && space(start)) start++;
  while (end > start && space(end - 1)) end--;
  return text.slice(start, end);
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // don't split a surrogate pair
  return text.slice(0, end) + '…';
}
