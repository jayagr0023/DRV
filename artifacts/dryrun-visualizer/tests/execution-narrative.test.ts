import assert from 'node:assert/strict';
import test from 'node:test';
import type { TraceStep } from '@workspace/api-client-react';
import { buildCallTree } from '../src/components/ExecutionNarrative';

function step(index: number, frames: Array<[string, string, number]>): TraceStep {
  return {
    step: index,
    event: 'line',
    line: frames.at(-1)?.[2] ?? null,
    frame: { class: frames.at(-1)?.[0] ?? 'Main', method: frames.at(-1)?.[1] ?? 'main' },
    stack: frames.map(([className, method, line]) => ({
      class: className,
      method,
      line,
      locals: {},
    })),
    stackTruncated: 0,
    statics: {},
    heap: {},
    stdout: '',
    stderr: '',
    changed: [],
    explanation: 'Observed test event.',
    error: null,
  };
}

test('reconstructs nested and recursive frames from observed stack snapshots', () => {
  const steps = [
    step(0, [['Main', 'main', 2]]),
    step(1, [['Main', 'main', 3], ['Main', 'factorial', 7]]),
    step(2, [['Main', 'main', 3], ['Main', 'factorial', 7], ['Main', 'factorial', 7]]),
    step(3, [['Main', 'main', 3], ['Main', 'factorial', 8]]),
  ];

  const roots = buildCallTree(steps, 3);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].frame.method, 'main');
  assert.equal(roots[0].children.length, 1);

  const factorial = roots[0].children[0];
  assert.equal(factorial.frame.method, 'factorial');
  assert.equal(factorial.endedAt, null);
  assert.equal(factorial.children.length, 1);
  assert.equal(factorial.children[0].frame.method, 'factorial');
  assert.equal(factorial.children[0].endedAt, 3);
});

test('restarts a call node when the same method is invoked again after returning', () => {
  const steps = [
    step(0, [['Main', 'main', 2], ['Main', 'visit', 6]]),
    step(1, [['Main', 'main', 3]]),
    step(2, [['Main', 'main', 4], ['Main', 'visit', 6]]),
  ];

  const roots = buildCallTree(steps, 2);
  assert.equal(roots[0].children.length, 2);
  assert.notEqual(roots[0].children[0].id, roots[0].children[1].id);
  assert.equal(roots[0].children[0].endedAt, 1);
  assert.equal(roots[0].children[1].endedAt, null);
});
