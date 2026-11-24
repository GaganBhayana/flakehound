import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childElements, parseXml, textContent, type XmlElement, type XmlError, type XmlParseOptions } from './parse.ts';

function parsed(input: string, options?: XmlParseOptions): XmlElement {
  const result = parseXml(input, options);
  if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function failed(input: string, options?: XmlParseOptions): XmlError {
  const result = parseXml(input, options);
  if (result.ok) assert.fail(`expected an error for ${JSON.stringify(input)}`);
  return result.error;
}

const el = (name: string, attributes: Record<string, string> = {}, children: XmlElement['children'] = []): XmlElement => ({
  type: 'element',
  name,
  attributes,
  children,
});
const text = (value: string) => ({ type: 'text' as const, text: value });

test('elements, nesting and self-closing tags', () => {
  assert.deepEqual(parsed('<a><b/><c></c></a>'), el('a', {}, [el('b'), el('c')]));
  assert.deepEqual(parsed('<a />'), el('a'));
});

test('attributes with both quote styles, spacing and entities', () => {
  const root = parsed(`<testcase name="adds &amp; subtracts" classname='math.Calc' time = "0.25" />`);
  assert.deepEqual(root.attributes, { name: 'adds & subtracts', classname: 'math.Calc', time: '0.25' });
});

test('attribute values normalise literal tabs and newlines but keep encoded ones', () => {
  assert.equal(parsed('<a v="x\ty\nz&#10;"/>').attributes['v'], 'x y z\n');
});

test('names may hold namespaces, dots, dashes and non-ASCII letters', () => {
  const root = parsed('<ns:suite xml:lang="en" data-id="1"><prüfung/></ns:suite>');
  assert.equal(root.name, 'ns:suite');
  assert.deepEqual(root.attributes, { 'xml:lang': 'en', 'data-id': '1' });
  assert.equal(childElements(root)[0]?.name, 'prüfung');
});

test('an attribute named __proto__ stays an ordinary property', () => {
  const root = parsed('<a __proto__="x"/>');
  assert.equal(Object.getPrototypeOf(root.attributes), Object.prototype);
  assert.equal(Object.hasOwn(root.attributes, '__proto__'), true);
  assert.equal(root.attributes['__proto__'], 'x');
});

test('text, the five predefined entities and numeric references', () => {
  const root = parsed('<m>a &lt; b &gt; c &amp; &quot;d&quot; &apos;e&apos; &#65;&#x42;&#x1F600;</m>');
  assert.deepEqual(root.children, [text(`a < b > c & "d" 'e' AB😀`)]);
});

test('CDATA is kept raw and merged with neighbouring text', () => {
  const root = parsed('<failure>at <![CDATA[x < y && <b>]]> end</failure>');
  assert.deepEqual(root.children, [text('at x < y && <b> end')]);
  assert.deepEqual(parsed('<o><![CDATA[   ]]></o>').children, [text('   ')]);
});

test('comments and processing instructions are skipped', () => {
  const root = parsed('<?xml version="1.0" encoding="UTF-8"?>\n<!-- report -->\n<a><!-- inner --><?pi data?><b/></a>\n<!-- trailing -->');
  assert.deepEqual(root, el('a', {}, [el('b')]));
});

test('whitespace-only text is dropped by default and kept on request', () => {
  const input = '<a>\n  <b>x</b>\n</a>';
  assert.deepEqual(parsed(input), el('a', {}, [el('b', {}, [text('x')])]));
  assert.deepEqual(parsed(input, { keepWhitespace: true }).children, [text('\n  '), el('b', {}, [text('x')]), text('\n')]);
});

test('mixed content keeps text order around child elements', () => {
  const root = parsed('<p>one <b>two</b> three</p>');
  assert.deepEqual(root.children, [text('one '), el('b', {}, [text('two')]), text(' three')]);
  assert.equal(textContent(root), 'one two three');
});

test('text of non-breaking spaces is data, not ignorable whitespace', () => {
  assert.deepEqual(parsed('<a>\u00a0\u00a0</a>').children, [text('\u00a0\u00a0')]);
  assert.deepEqual(parsed('<a>&#160;</a>').children, [text('\u00a0')]);
});

test('line endings are normalised in text, CDATA and attribute values', () => {
  const root = parsed('<a v="x\r\ny\rz"><b>l1\r\nl2\rl3</b><c><![CDATA[s1\r\ns2]]></c></a>');
  assert.equal(root.attributes['v'], 'x y z');
  assert.equal(textContent(childElements(root, 'b')[0] as XmlElement), 'l1\nl2\nl3');
  assert.equal(textContent(childElements(root, 'c')[0] as XmlElement), 's1\ns2');
  assert.equal(textContent(parsed('<a>x&#13;&#10;y</a>')), 'x\r\ny');
});

test('a byte order mark is ignored', () => {
  assert.deepEqual(parsed('﻿<a/>'), el('a'));
});

test('a JUnit-shaped report parses into a usable tree', () => {
  const report = [
    '<?xml version="1.0"?>',
    '<testsuites tests="2" failures="1">',
    '  <testsuite name="calc" tests="2">',
    '    <testcase name="adds" time="0.01"/>',
    '    <testcase name="divides" time="0.02">',
    '      <failure message="expected 2"><![CDATA[AssertionError: expected 2\n    at calc.test.js:9:3]]></failure>',
    '      <system-out>log line</system-out>',
    '    </testcase>',
    '  </testsuite>',
    '</testsuites>',
  ].join('\n');
  const root = parsed(report);
  const cases = childElements(childElements(root, 'testsuite')[0] as XmlElement, 'testcase');
  assert.deepEqual(cases.map((c) => c.attributes['name']), ['adds', 'divides']);
  const failure = childElements(cases[1] as XmlElement, 'failure')[0] as XmlElement;
  assert.equal(failure.attributes['message'], 'expected 2');
  assert.equal(textContent(failure), 'AssertionError: expected 2\n    at calc.test.js:9:3');
});

test('DOCTYPE is rejected, so no XXE or entity expansion', () => {
  const xxe = '<?xml version="1.0"?>\n<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>\n<r>&x;</r>';
  assert.deepEqual(failed(xxe), { message: 'DOCTYPE is not allowed (DTDs and external entities are disabled)', line: 2, column: 1 });
  assert.match(failed('<!doctype html><a/>').message, /DOCTYPE/);
  const bomb = '<!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><l>&b;</l>';
  assert.match(failed(bomb).message, /DOCTYPE/);
});

test('custom entities and other declarations are rejected', () => {
  assert.deepEqual(failed('<a>\n  &x;</a>'), {
    message: 'unknown entity &x; (only the five predefined entities are supported)',
    line: 2,
    column: 3,
  });
  assert.match(failed('<a><!ENTITY x "y"></a>').message, /unsupported markup declaration/);
});

test('depth is capped', () => {
  const nested = (depth: number) => '<a>'.repeat(depth) + '</a>'.repeat(depth);
  assert.equal(parsed(nested(64)).name, 'a');
  assert.match(failed(nested(65)).message, /nested deeper than 64/);
  assert.match(failed('<a><b/></a>', { maxDepth: 1 }).message, /nested deeper than 1/);
  assert.equal(parsed('<a/>', { maxDepth: 1 }).name, 'a');
});

test('deep nesting far past the cap fails cleanly without a stack overflow', () => {
  assert.match(failed('<a>'.repeat(100_000), { maxDepth: 200_000 }).message, /never closed/);
});

test('input size is capped in UTF-8 bytes', () => {
  assert.equal(parsed('<a>xx</a>', { maxBytes: 9 }).name, 'a');
  assert.deepEqual(failed('<a>xx</a>', { maxBytes: 8 }), { message: 'input is larger than 8 bytes', line: 1, column: 1 });
  assert.match(failed('<a>éé</a>', { maxBytes: 9 }).message, /larger than 9 bytes/);
});

const malformed: ReadonlyArray<[string, string, RegExp, number, number]> = [
  ['empty input', '', /no root element/, 1, 1],
  ['only a comment', '<!-- x -->', /no root element/, 1, 11],
  ['unclosed element', '<a>\n<b>\n</b>', /<a> is never closed/, 1, 1],
  ['mismatched closing tag', '<a>\n  <b></c>\n</a>', /<\/c> does not match <b>/, 2, 6],
  ['stray closing tag', '<a/></b>', /unexpected closing tag/, 1, 5],
  ['two roots', '<a/>\n<b/>', /more than one root/, 2, 1],
  ['text before the root', 'hello <a/>', /text outside the root/, 1, 1],
  ['text after the root', '<a/>\n  oops', /text outside the root/, 2, 3],
  ['missing element name', '<a>< b/></a>', /expected element name/, 1, 5],
  ['unquoted attribute', '<a x=1/>', /quoted value for attribute x/, 1, 6],
  ['attribute without a value', '<a x/>', /expected = after attribute x/, 1, 5],
  ['attributes without whitespace', '<a x="1"y="2"/>', /whitespace before attribute/, 1, 9],
  ['duplicate attribute', '<a x="1" x="2"/>', /duplicate attribute x/, 1, 10],
  ['unterminated attribute value', '<a x="1/>', /unterminated value for attribute x/, 1, 6],
  ['< in an attribute value', '<a x="<"/>', /'<' is not allowed/, 1, 7],
  ['tag cut off', '<a x="1"', /end of input inside a tag/, 1, 9],
  ['unterminated comment', '<a><!-- x</a>', /unterminated comment/, 1, 8],
  ['unterminated CDATA', '<a><![CDATA[x</a>', /unterminated CDATA/, 1, 13],
  ['CDATA outside the root', '<![CDATA[x]]><a/>', /CDATA outside the root/, 1, 1],
  ['bare ampersand', '<a>fish & chips</a>', /unterminated entity/, 1, 9],
  ['malformed character reference', '<a>&#xZZ;</a>', /malformed character reference/, 1, 4],
  ['NUL character reference', '<a>&#0;</a>', /not a valid XML character/, 1, 4],
  ['out-of-range character reference', '<a>&#x110000;</a>', /not a valid XML character/, 1, 4],
  ['unknown entity in an attribute', '<a x="&nbsp;"/>', /unknown entity &nbsp;/, 1, 7],
  ['unterminated processing instruction', '<a><?pi x</a>', /unterminated processing instruction/, 1, 6],
  ['closing tag cut off', '<a></a', /expected > to close <\/a/, 1, 7],
  ['non-breaking space before the root', '\u00a0<a/>', /text outside the root/, 1, 1],
  ['error line after CRLF line endings', '<a>\r\n<b>\r\n</c>', /<\/c> does not match <b>/, 3, 1],
  ['error line after lone CR line endings', '<a>\r<b>\r</c>', /<\/c> does not match <b>/, 3, 1],
];

for (const [name, input, message, line, column] of malformed) {
  test(`malformed: ${name}`, () => {
    const error = failed(input);
    assert.match(error.message, message);
    assert.deepEqual([error.line, error.column], [line, column]);
  });
}

test('invalid options throw a RangeError', () => {
  assert.throws(() => parseXml('<a/>', { maxDepth: 0 }), RangeError);
  assert.throws(() => parseXml('<a/>', { maxBytes: 1.5 }), RangeError);
});

test('childElements filters by name and skips text', () => {
  const root = parsed('<r>t<a/><b/><a/></r>');
  assert.deepEqual(childElements(root).map((c) => c.name), ['a', 'b', 'a']);
  assert.equal(childElements(root, 'a').length, 2);
  assert.deepEqual(childElements(root, 'z'), []);
});
