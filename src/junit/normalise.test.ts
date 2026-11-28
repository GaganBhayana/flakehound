import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseXml } from '../xml/parse.ts';
import {
  MAX_MESSAGE_LENGTH,
  MAX_TEXT_LENGTH,
  normaliseJunit,
  normaliseJunitTree,
  parseDuration,
  testId,
  type JunitError,
  type TestResult,
} from './normalise.ts';

const FIXTURES = new URL('../../test/fixtures/junit/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');

function results(xml: string): readonly TestResult[] {
  const result = normaliseJunit(xml);
  if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result.error)}`);
  return result.results;
}

function failure(xml: string): JunitError {
  const result = normaliseJunit(xml);
  if (result.ok) assert.fail('expected an error');
  return result.error;
}

const withoutId = ({ id: _id, ...rest }: TestResult) => rest;
const one = (xml: string): TestResult => {
  const [first, ...rest] = results(xml);
  assert.equal(rest.length, 0);
  assert.ok(first);
  return first;
};

for (const framework of ['jest', 'vitest', 'pytest', 'gotestsum', 'surefire', 'rspec']) {
  test(`${framework} report matches its expected output`, () => {
    const actual = results(fixture(`${framework}.xml`));
    const expected: unknown = JSON.parse(fixture(`${framework}.expected.json`));
    assert.deepEqual(actual.map(withoutId), expected);
    for (const r of actual) assert.equal(r.id, testId(r.suite, r.classname, r.name, r.file));
  });
}

test('ids are stable across runs and differ between tests', () => {
  const first = results(fixture('pytest.xml')).map((r) => r.id);
  const second = results(fixture('pytest.xml').replaceAll('time="0.001"', 'time="9.9"')).map((r) => r.id);
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, first.length);
  for (const id of first) assert.match(id, /^[0-9a-f]{16}$/);
  // Field boundaries are kept: moving text between fields gives another id.
  assert.notEqual(testId('a b', undefined, 'c', undefined), testId('a', undefined, 'b c', undefined));
  assert.notEqual(testId('s', undefined, 'n', undefined), testId('s', '', 'n', 'x'));
});

test('a repeated case (a retry) keeps both entries with one id', () => {
  const [a, b] = results('<testsuite name="s"><testcase name="t"><failure message="boom"/></testcase><testcase name="t"/></testsuite>');
  assert.ok(a && b);
  assert.equal(a.id, b.id);
  assert.deepEqual([a.status, b.status], ['failed', 'passed']);
});

test('Surefire reruns are counted whatever the final outcome', () => {
  const failed = one(
    '<testsuite><testcase name="t"><failure message="boom">a</failure><rerunFailure message="boom">b</rerunFailure><rerunFailure message="boom">c</rerunFailure></testcase></testsuite>',
  );
  assert.deepEqual([failed.status, failed.rerunFailures, failed.message, failed.stack], ['failed', 2, 'boom', 'a']);
  const errored = one('<testsuite><testcase name="t"><error message="down"/><rerunError message="down"/></testcase></testsuite>');
  assert.deepEqual([errored.status, errored.rerunFailures], ['error', 1]);
  const flaky = one('<testsuite><testcase name="t"><flakyError message="x"/><flakyFailure message="y"/></testcase></testsuite>');
  assert.deepEqual([flaky.status, flaky.rerunFailures, 'message' in flaky], ['passed', 2, false]);
});

test('failure wins over error, error over skipped', () => {
  assert.equal(one('<testsuite><testcase name="t"><skipped/><error/><failure/></testcase></testsuite>').status, 'failed');
  assert.equal(one('<testsuite><testcase name="t"><skipped/><error/></testcase></testsuite>').status, 'error');
  assert.equal(one('<testsuite><testcase name="t"><system-out>x</system-out><skipped/></testcase></testsuite>').status, 'skipped');
});

test('message falls back to the first non-blank line of the body', () => {
  const r = one('<testsuite><testcase name="t"><failure message="  ">\n\n  first line  \nsecond</failure></testcase></testsuite>');
  assert.equal(r.message, 'first line');
  assert.equal(r.stack, 'first line  \nsecond');
  const bare = one('<testsuite><testcase name="t"><failure/></testcase></testsuite>');
  assert.equal(bare.status, 'failed');
  assert.equal('message' in bare || 'stack' in bare, false);
});

test('nested suites, a bare testsuite root and an empty report', () => {
  const nested = results(
    '<testsuites><testsuite name="outer"><testcase name="a"/><testsuite name="inner"><testcase name="b"/></testsuite><testcase name="c"/></testsuite><testsuite name="other"><testcase name="d"/></testsuite></testsuites>',
  );
  assert.deepEqual(
    nested.map((r) => [r.suite, r.name]),
    [['outer', 'a'], ['outer', 'c'], ['outer / inner', 'b'], ['other', 'd']],
  );
  assert.equal(one('<testsuite name="s"><testcase name="t"/></testsuite>').suite, 's');
  assert.equal(one('<testsuites><testcase name="t"/></testsuites>').suite, '');
  assert.deepEqual(results('<testsuites/>'), []);
  assert.deepEqual(results('<testsuites name="x" tests="0"></testsuites>'), []);
});

test('file comes from the case, then the suite, then a path-like classname or suite name', () => {
  assert.equal(one('<testsuite file="a/b.py"><testcase name="t" file=".\\x\\y.py"/></testsuite>').file, 'x/y.py');
  assert.equal(one('<testsuite file="./a/b.py"><testcase name="t"/></testsuite>').file, 'a/b.py');
  assert.equal(one('<testsuite name="src/z.spec.tsx"><testcase name="t"/></testsuite>').file, 'src/z.spec.tsx');
  assert.equal(one('<testsuite><testcase name="t" classname="pkg/m_test.go"/></testsuite>').file, 'pkg/m_test.go');
  // Dotted module and class names, package paths and sentences are not files.
  for (const classname of ['tests.test_math.TestDivide', 'com.acme.MathTest', 'github.com/acme/widgets', 'math adds.js numbers']) {
    assert.equal(one(`<testsuite><testcase name="t" classname="${classname}"/></testsuite>`).file, undefined, classname);
  }
  assert.equal(one('<testsuite><testcase name="t" file="  "/></testsuite>').file, undefined);
  assert.equal(one('<testsuite><testcase name="t" file="a//./b/c.py"/></testsuite>').file, 'a/b/c.py');
});

test('absolute paths and ".." segments never become a file', () => {
  const unsafe = ['/home/runner/work/w/w/src/a.test.js', 'D:\\a\\w\\w\\src\\a.test.js', 'c:/x/a.py', '\\\\host\\share\\a.py', '../../etc/passwd', 'src/../../a.py', 'src/..'];
  for (const file of unsafe) {
    assert.equal(one(`<testsuite><testcase name="t" file="${file}"/></testsuite>`).file, undefined, file);
  }
  // An unsafe case path falls back to the suite's file, and an unsafe classname is not inferred.
  assert.equal(one('<testsuite file="src/a.py"><testcase name="t" file="/abs/a.py"/></testsuite>').file, 'src/a.py');
  assert.equal(one('<testsuite><testcase name="t" classname="../x/a_test.go"/></testsuite>').file, undefined);
});

test('rootDir makes absolute paths relative, so ids match across runners', () => {
  const xml = (file: string) => `<testsuite name="math"><testcase name="adds" file="${file}"/></testsuite>`;
  const linux = normaliseJunit(xml('/home/runner/work/w/w/src/a.test.js'), { rootDir: '/home/runner/work/w/w/' });
  const windows = normaliseJunit(xml('D:\\a\\w\\w\\src\\a.test.js'), { rootDir: 'd:\\A\\w\\w' });
  const relative = normaliseJunit(xml('./src/a.test.js'), { rootDir: '/elsewhere' });
  assert.ok(linux.ok && windows.ok && relative.ok);
  assert.equal(linux.results[0]?.file, 'src/a.test.js');
  assert.equal(windows.results[0]?.file, 'src/a.test.js');
  assert.equal(linux.results[0]?.id, windows.results[0]?.id);
  assert.equal(linux.results[0]?.id, relative.results[0]?.id);
  // POSIX roots are case-sensitive, a path outside the root stays unset, and the root itself is not a file.
  const outside = (file: string, rootDir: string) => normaliseJunit(xml(file), { rootDir });
  for (const [file, rootDir] of [['/Home/w/a.js', '/home/w'], ['/home/wx/a.js', '/home/w'], ['/home/w', '/home/w'], ['/home/w/../a.js', '/home/w']]) {
    const r = outside(file ?? '', rootDir ?? '');
    assert.ok(r.ok);
    assert.equal(r.results[0]?.file, undefined, `${file} under ${rootDir}`);
  }
  // Suite files and path-like suite names use rootDir too.
  const tree = parseXml('<testsuites><testsuite name="/r/src/b.spec.ts"><testcase name="t"/></testsuite></testsuites>');
  assert.ok(tree.ok);
  const named = normaliseJunitTree(tree.value, { rootDir: '/r' });
  assert.ok(named.ok);
  assert.equal(named.results[0]?.file, 'src/b.spec.ts');
});

test('rootDir must be an absolute path', () => {
  for (const rootDir of ['src', './x', '', '/', 'C:', 'C:\\']) {
    assert.throws(() => normaliseJunit('<testsuites/>', { rootDir }), RangeError, rootDir);
  }
});

test('empty classname and missing name are tolerated', () => {
  const r = one('<testsuite name="s"><testcase classname=""/></testsuite>');
  assert.equal(r.name, '');
  assert.equal('classname' in r, false);
});

test('long messages, stacks and output are cut', () => {
  const long = 'x'.repeat(MAX_TEXT_LENGTH * 2);
  const r = one(`<testsuite><testcase name="t"><failure message="${long}">${long}</failure><system-out>${long}</system-out></testcase></testsuite>`);
  assert.equal(r.message?.length, MAX_MESSAGE_LENGTH);
  assert.equal(r.stack?.length, MAX_TEXT_LENGTH);
  assert.equal(r.output?.length, MAX_TEXT_LENGTH);
  assert.ok(r.message?.endsWith('…'));
  // A cut never leaves half of a surrogate pair.
  const emoji = '😀'.repeat(MAX_MESSAGE_LENGTH);
  const cut = one(`<testsuite><testcase name="t"><failure message="${emoji}"/></testcase></testsuite>`).message ?? '';
  const last = cut.charCodeAt(cut.length - 2);
  assert.ok(last < 0xd800 || last > 0xdbff);
});

test('whitespace-heavy text is trimmed in linear time', () => {
  const body = 'a' + ' '.repeat(200_000) + 'b';
  const started = performance.now();
  const r = one(`<testsuite><testcase name="t"><failure>\n${body}\n\n</failure><system-out>${body}</system-out></testcase></testsuite>`);
  assert.equal(r.message, body.slice(0, MAX_MESSAGE_LENGTH - 1) + '…');
  assert.equal(r.stack, body.slice(0, MAX_TEXT_LENGTH - 1) + '…');
  assert.ok(performance.now() - started < 1_000);
});

test('parseDuration reads seconds into whole milliseconds', () => {
  const cases: [string | undefined, number][] = [
    ['0.0011', 1],
    ['0.0004', 0],
    ['2.5', 2500],
    ['3', 3000],
    ['.25', 250],
    ['1e-3', 1],
    [' 0.5 ', 500],
    ['1,234.5', 1_234_500],
    ['1,23', 0],
    ['-1', 0],
    ['NaN', 0],
    ['Infinity', 0],
    ['', 0],
    ['0x10', 0],
    ['1e400', 0],
    [undefined, 0],
  ];
  for (const [time, ms] of cases) assert.equal(parseDuration(time), ms, String(time));
});

test('rejects documents that are not JUnit reports', () => {
  assert.match(failure('<html><body/></html>').message, /root element is <html>/);
  const xml = failure('<testsuites>\n<testsuite>\n</testsuites>');
  assert.equal(xml.line, 3);
  assert.match(failure('<!DOCTYPE x [<!ENTITY a "b">]><testsuites/>').message, /DOCTYPE/i);
});

test('normaliseJunitTree accepts an already parsed tree', () => {
  const parsed = parseXml(fixture('rspec.xml'));
  assert.ok(parsed.ok);
  const tree = normaliseJunitTree(parsed.value);
  assert.ok(tree.ok);
  assert.equal(tree.results.length, 3);
});
