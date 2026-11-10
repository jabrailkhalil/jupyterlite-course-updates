import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  fingerprint,
  planUpdate,
  resolveUpdate,
  sourceText
} from '../lib/merge.js';

const LEARNER_SOURCE =
  'answer = sum([2, 3, 5])\nprint("learner:", answer)';
const INCOMING_SOURCE =
  'answer = 2 + 3 + 5\nprint("author:", answer)';
const UPDATED_INSTRUCTIONS =
  'Add 2, 3, and 5. Store the result in answer and explain your method.';
const clone = value => structuredClone(value);
const load = version =>
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(`../fixtures/course-assets/v${version}/lesson.ipynb`, import.meta.url)
      ),
      'utf8'
    )
  );

function learnerNotebook() {
  const value = load(1);
  value.cells[1].source = LEARNER_SOURCE;
  value.cells[1].execution_count = 7;
  value.cells[1].outputs = [
    { output_type: 'stream', name: 'stdout', text: 'learner: 10\n' }
  ];
  value.cells[1].metadata = { trusted: true, tags: ['learner-note'] };
  value.metadata.language_info = { name: 'python', version: '3.14.0' };
  return value;
}

function immutableCall(base, learner, incoming, choices = {}) {
  const before = [base, learner, incoming].map(value => JSON.stringify(value));
  const plan = planUpdate(base, learner, incoming);
  const result = resolveUpdate(plan, choices);
  assert.deepEqual(
    [base, learner, incoming].map(value => JSON.stringify(value)),
    before,
    'planning and resolution must not edit any input notebook'
  );
  return { plan, result };
}

test('author-only instructions update produces the specified two cell sources', () => {
  const { plan, result } = immutableCall(load(1), load(1), load(2));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changedCells, ['instructions']);
  assert.deepEqual(
    result.cells.map(cell => [cell.id, sourceText(cell.source)]),
    [
      ['instructions', UPDATED_INSTRUCTIONS],
      ['answer', 'answer = None']
    ]
  );
});

test('learner-only work retains source, outputs, execution count and metadata', () => {
  const learner = learnerNotebook();
  const { plan, result } = immutableCall(load(1), learner, load(1));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changedCells, []);
  assert.deepEqual(result, learner);
});

test('separate author and learner cells merge without losing the answer or output', () => {
  const learner = learnerNotebook();
  const { plan, result } = immutableCall(load(1), learner, load(2));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(plan.changedCells, ['instructions']);
  assert.equal(sourceText(result.cells[0].source), UPDATED_INSTRUCTIONS);
  assert.deepEqual(result.cells[1], learner.cells[1]);
  assert.deepEqual(result.metadata, learner.metadata);
});

test('identical source edits are not conflicts and keep the learner execution', () => {
  const learner = learnerNotebook();
  learner.cells[1].source = INCOMING_SOURCE;
  learner.cells[1].outputs[0].text = 'author: 10\n';
  const { plan, result } = immutableCall(load(1), learner, load(3));
  assert.deepEqual(plan.conflicts, []);
  assert.deepEqual(result.cells[1], learner.cells[1]);
});

test('different edits to the same cell require an explicit choice', () => {
  const base = load(1);
  const learner = learnerNotebook();
  const incoming = load(3);
  const before = [base, learner, incoming].map(value => JSON.stringify(value));
  const plan = planUpdate(base, learner, incoming);
  assert.deepEqual(plan.conflicts, [
    {
      id: 'answer',
      index: 1,
      base: 'answer = None',
      learner: LEARNER_SOURCE,
      incoming: INCOMING_SOURCE
    }
  ]);
  assert.deepEqual(plan.changedCells, ['instructions', 'answer']);
  assert.throws(() => resolveUpdate(plan, {}), /choice|unresolved|conflict|answer/i);
  assert.deepEqual(
    [base, learner, incoming].map(value => JSON.stringify(value)),
    before
  );
});

test('choosing the learner keeps its answer and execution state', () => {
  const learner = learnerNotebook();
  const { result } = immutableCall(load(1), learner, load(3), {
    answer: 'learner'
  });
  assert.equal(sourceText(result.cells[0].source), UPDATED_INSTRUCTIONS);
  assert.deepEqual(result.cells[1], learner.cells[1]);
});

test('choosing incoming code clears stale outputs, execution count and trust', () => {
  const { result } = immutableCall(load(1), learnerNotebook(), load(3), {
    answer: 'incoming'
  });
  assert.equal(sourceText(result.cells[1].source), INCOMING_SOURCE);
  assert.deepEqual(result.cells[1].outputs, []);
  assert.equal(result.cells[1].execution_count, null);
  assert.equal(Object.hasOwn(result.cells[1].metadata, 'trusted'), false);
  assert.deepEqual(result.cells[1].metadata.tags, ['learner-note']);
});

test('an incoming-only code edit also invalidates a prior execution', () => {
  const learner = load(1);
  learner.cells[1].execution_count = 2;
  learner.cells[1].outputs = [
    { output_type: 'stream', name: 'stdout', text: 'None\n' }
  ];
  learner.cells[1].metadata.trusted = true;
  const { result } = immutableCall(load(1), learner, load(3));
  assert.equal(sourceText(result.cells[1].source), INCOMING_SOURCE);
  assert.deepEqual(result.cells[1].outputs, []);
  assert.equal(result.cells[1].execution_count, null);
  assert.equal(Object.hasOwn(result.cells[1].metadata, 'trusted'), false);
});

test('review snapshots and resolved notebooks are detached from their inputs', () => {
  const base = load(1);
  const learner = learnerNotebook();
  const incoming = load(2);
  const plan = planUpdate(base, learner, incoming);
  base.cells[0].source = 'changed outside the review';
  learner.cells[1].outputs[0].text = 'changed outside the review';
  incoming.cells[0].source = 'changed outside the review';
  assert.equal(sourceText(plan.base.cells[0].source), load(1).cells[0].source);
  assert.equal(plan.learner.cells[1].outputs[0].text, 'learner: 10\n');
  assert.equal(sourceText(plan.incoming.cells[0].source), UPDATED_INSTRUCTIONS);
  const result = resolveUpdate(plan, {});
  result.cells[1].outputs[0].text = 'edited copy';
  assert.equal(plan.learner.cells[1].outputs[0].text, 'learner: 10\n');
  assert.notEqual(result.cells[1], plan.learner.cells[1]);
});

test('line-array sources and object key order have the same semantic fingerprint', () => {
  const base = load(1);
  const equivalent = {
    cells: clone(base.cells),
    metadata: clone(base.metadata),
    nbformat_minor: 5,
    nbformat: 4
  };
  equivalent.cells[1].source = ['answer = ', 'None'];
  assert.equal(sourceText(['first\n', 'second']), 'first\nsecond');
  assert.equal(fingerprint(base), fingerprint(equivalent));
  const result = resolveUpdate(planUpdate(base, equivalent, load(2)), {});
  assert.equal(sourceText(result.cells[1].source), 'answer = None');
  equivalent.cells[1].source = ['answer = ', 'True'];
  assert.notEqual(fingerprint(base), fingerprint(equivalent));
});

const unsupportedChanges = [
  ['incoming notebook metadata', (_base, _learner, incoming) => {
    incoming.metadata.new_course_policy = { grade: 'changed' };
  }],
  ['incoming cell metadata', (_base, _learner, incoming) => {
    incoming.cells[1].metadata.tags = ['new-incoming-tag'];
  }],
  ['incoming attachments', (_base, _learner, incoming) => {
    incoming.cells[0].attachments = { diagram: { 'image/png': 'YWJj' } };
  }],
  ['an incoming inserted cell', (_base, _learner, incoming) => {
    incoming.cells.push({ cell_type: 'markdown', id: 'extra', metadata: {}, source: 'extra' });
  }],
  ['a learner-deleted cell', (_base, learner) => { learner.cells.pop(); }],
  ['reordered incoming cells', (_base, _learner, incoming) => { incoming.cells.reverse(); }],
  ['a changed cell type', (_base, _learner, incoming) => {
    incoming.cells[1] = { cell_type: 'markdown', id: 'answer', metadata: {}, source: 'changed' };
  }],
  ['duplicate IDs', (_base, _learner, incoming) => { incoming.cells[1].id = 'instructions'; }],
  ['missing IDs', (_base, learner) => { delete learner.cells[1].id; }]
];

for (const [label, change] of unsupportedChanges) {
  test(`unsupported ${label} is rejected explicitly without input mutation`, () => {
    const base = load(1);
    const learner = learnerNotebook();
    const incoming = load(2);
    change(base, learner, incoming);
    const before = [base, learner, incoming].map(value => JSON.stringify(value));
    assert.throws(
      () => planUpdate(base, learner, incoming),
      /unsupported|metadata|attachment|cell|layout|order|id|field/i
    );
    assert.deepEqual(
      [base, learner, incoming].map(value => JSON.stringify(value)),
      before
    );
  });
}

test('invalid source and notebook major versions are rejected', () => {
  const invalidSource = load(2);
  invalidSource.cells[0].source = 42;
  assert.throws(() => planUpdate(load(1), load(1), invalidSource), /source|cell/i);
  const unsupportedMajor = load(2);
  unsupportedMajor.nbformat = 5;
  assert.throws(() => planUpdate(load(1), load(1), unsupportedMajor), /format|notebook|schema/i);
  assert.throws(() => sourceText(['a', undefined]), /source|string/i);
});

test('unknown or invalid resolution choices cannot silently select a source', () => {
  const plan = planUpdate(load(1), learnerNotebook(), load(3));
  assert.throws(() => resolveUpdate(plan, { answer: 'both' }), /choice|resolution|incoming|learner/i);
  assert.throws(
    () => resolveUpdate(plan, { answer: 'learner', unknown: 'incoming' }),
    /choice|unknown|conflict|resolution/i
  );
});

test('removing the conflict list from a serialized plan cannot bypass review', () => {
  const plan = clone(planUpdate(load(1), learnerNotebook(), load(3)));
  plan.conflicts = [];
  assert.throws(() => resolveUpdate(plan, {}), /plan|conflict|choice|review|changed/i);
});
