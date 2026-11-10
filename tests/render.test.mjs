import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, cellState } from '../lib/presentation.js';

const line = (text, change) => ({ text, change });

// Enumerate subsequences independently of the production LCS implementation.
// Fixtures are deliberately small; this is an oracle, not a scalable diff.
function subsequences(values) {
  const result = [[]];
  for (const value of values) result.push(...result.map(prefix => [...prefix, value]));
  return result;
}

function longestCommonLength(left, right) {
  const rightSubsequences = new Set(subsequences(right).map(values => JSON.stringify(values)));
  return Math.max(...subsequences(left)
    .filter(values => rightSubsequences.has(JSON.stringify(values)))
    .map(values => values.length));
}

test('line presentation keeps identical source and a trailing empty line unchanged', () => {
  const result = diffLines('answer = 10\nprint(answer)\n', 'answer = 10\nprint(answer)\n');
  const expected = ['answer = 10', 'print(answer)', ''].map(text => line(text, 'unchanged'));
  assert.deepEqual(result, { before: expected, after: expected });
});

test('line presentation labels replacements on their correct sides', () => {
  assert.deepEqual(diffLines('answer = None', 'answer = sum([2, 3, 5])'), {
    before: [line('answer = None', 'removed')],
    after: [line('answer = sum([2, 3, 5])', 'added')]
  });
});

test('line presentation highlights only an inserted line between unchanged context', () => {
  assert.deepEqual(diffLines('start\nfinish', 'start\nnew explanation\nfinish'), {
    before: [line('start', 'unchanged'), line('finish', 'unchanged')],
    after: [line('start', 'unchanged'), line('new explanation', 'added'), line('finish', 'unchanged')]
  });
});

test('line presentation retains both repeated context lines around a deletion', () => {
  assert.deepEqual(diffLines('repeat\nobsolete\nrepeat', 'repeat\nrepeat'), {
    before: [line('repeat', 'unchanged'), line('obsolete', 'removed'), line('repeat', 'unchanged')],
    after: [line('repeat', 'unchanged'), line('repeat', 'unchanged')]
  });
});

test('small line diffs preserve exact sources and use an independently minimal edit count', () => {
  const cases = [
    ['', ''],
    ['', 'new'],
    ['old', ''],
    ['a\nb', 'b\na'],
    ['a\nb\na', 'a\na'],
    ['a\na\nb', 'a\nb\nb'],
    ['\na\n', 'a\n'],
    ['first\nkeep\nlast', 'keep\nlast\nnew'],
    ['repeat\nleft\nrepeat\ntail', 'repeat\nright\nrepeat\ntail'],
    ['alpha\nbeta\ngamma', 'delta\nepsilon']
  ];
  for (const [before, after] of cases) {
    const result = diffLines(before, after);
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    assert.equal(result.before.map(item => item.text).join('\n'), before);
    assert.equal(result.after.map(item => item.text).join('\n'), after);
    assert.ok(result.before.every(item => ['removed', 'unchanged'].includes(item.change)));
    assert.ok(result.after.every(item => ['added', 'unchanged'].includes(item.change)));
    const commonBefore = result.before.filter(item => item.change === 'unchanged').map(item => item.text);
    const commonAfter = result.after.filter(item => item.change === 'unchanged').map(item => item.text);
    assert.deepEqual(commonBefore, commonAfter);
    const expectedCommon = longestCommonLength(beforeLines, afterLines);
    assert.equal(commonBefore.length, expectedCommon, `non-minimal diff: ${JSON.stringify([before, after])}`);
    const edits = result.before.filter(item => item.change === 'removed').length
      + result.after.filter(item => item.change === 'added').length;
    assert.equal(edits, beforeLines.length + afterLines.length - 2 * expectedCommon);
  }
});

test('large-input presentation preserves exact data and unchanged boundary context', () => {
  const before = ['shared start', ...Array.from({ length: 210 }, (_, index) => `old ${index}`), 'shared end'];
  const after = ['shared start', ...Array.from({ length: 210 }, (_, index) => `new ${index}`), 'shared end'];
  const result = diffLines(before.join('\n'), after.join('\n'));
  assert.deepEqual(result.before.map(item => item.text), before);
  assert.deepEqual(result.after.map(item => item.text), after);
  assert.deepEqual(result.before[0], line('shared start', 'unchanged'));
  assert.deepEqual(result.after[0], line('shared start', 'unchanged'));
  assert.deepEqual(result.before.at(-1), line('shared end', 'unchanged'));
  assert.deepEqual(result.after.at(-1), line('shared end', 'unchanged'));
  assert.equal(result.before.filter(item => item.change === 'removed').length, 210);
  assert.equal(result.after.filter(item => item.change === 'added').length, 210);
});

test('presentation data preserves literal HTML and Unicode without escaping or interpreting it', () => {
  const value = '<img src="/no-request" onerror="alert(1)">\n<script>literal()</script>\nОтвет: 10 🧪';
  const result = diffLines('answer = None', value);
  assert.equal(result.after.map(item => item.text).join('\n'), value);
  assert.ok(result.after.every(item => item.change === 'added'));
});

test('written cell states distinguish unchanged, unilateral, shared and conflicting source edits', () => {
  const cases = [
    ['base', 'base', 'base', 'unchanged'],
    ['base', 'base', 'course edit', 'course'],
    ['base', 'my answer', 'base', 'learner'],
    ['base', 'same edit', 'same edit', 'course'],
    ['base', 'my answer', 'course edit', 'conflict'],
    ['', '', 'new exercise', 'course'],
    ['', 'my answer', '', 'learner']
  ];
  for (const [base, learner, incoming, expected] of cases) {
    assert.equal(cellState(base, learner, incoming), expected);
  }
});
