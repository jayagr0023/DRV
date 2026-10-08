import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  KeyframeStep,
  TraceEnd,
  TraceStreamRecord,
} from '@workspace/api-client-react';
import { consumeTraceResponse, stdoutThroughStep } from '../src/lib/trace-response';
import { reconstructSteps } from '../src/lib/reconstruct-trace';

const keyframe: KeyframeStep = {
  storage: 'keyframe',
  step: 0,
  snapshot: {
    step: 0,
    event: 'line',
    line: 1,
    frame: { method: 'main', class: 'Main' },
    stack: [{ method: 'main', class: 'Main', line: 1, locals: {} }],
    stackTruncated: 0,
    statics: { count: { kind: 'prim', type: 'int', value: 1 } },
    heap: {},
    stdout: '',
    stderr: '',
    changed: [],
    explanation: 'Started main.',
    error: null,
  },
};

const delta = {
  storage: 'delta',
  step: 1,
  patch: [{ op: 'replace', path: '/statics/count/value', value: 2 }],
  event: 'line',
  line: 2,
  frame: { method: 'main', class: 'Main' },
  stackTruncated: 0,
  stdout: '',
  stderr: '',
  changed: ['count'],
  explanation: 'Updated count.',
  error: null,
} as const;

const traceEnd: TraceEnd = { status: 'ok', diagnostics: [] };
const metaRecord: TraceStreamRecord = {
  type: 'meta',
  schemaVersion: '1.0.0',
  traceId: 'a'.repeat(64),
  language: 'java',
  languageVersion: '21',
  meta: {},
};
const stepRecord: TraceStreamRecord = {
  type: 'step',
  schemaVersion: '1.0.0',
  data: keyframe,
};
const endRecord: TraceStreamRecord = {
  type: 'end',
  schemaVersion: '1.0.0',
  end: traceEnd,
};

function ndjsonResponse(records: TraceStreamRecord[]): Response {
  const chunks = records.map((record) => new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
}

test('reconstructs deltas without mutating their keyframe', () => {
  const steps = reconstructSteps([keyframe, delta]);

  assert.equal(steps.length, 2);
  assert.deepEqual(steps[0].statics.count, { kind: 'prim', type: 'int', value: 1 });
  assert.deepEqual(steps[1].statics.count, { kind: 'prim', type: 'int', value: 2 });
  assert.deepEqual(keyframe.snapshot.statics.count, { kind: 'prim', type: 'int', value: 1 });
});

test('preserves return values for their event and clears them on the next event', () => {
  const returnDelta = {
    ...delta,
    event: 'return' as const,
    returnValue: { kind: 'prim' as const, type: 'int', value: 5 },
  };
  const steps = reconstructSteps([keyframe, returnDelta, { ...delta, step: 2 }]);

  assert.deepEqual(steps[1].returnValue, { kind: 'prim', type: 'int', value: 5 });
  assert.equal(steps[2].returnValue, undefined);
});

test('rejects patch paths outside mutable trace state', () => {
  assert.throws(() => reconstructSteps([
    keyframe,
    { ...delta, patch: [{ op: 'replace', path: '/explanation', value: 'forbidden' }] },
  ]), /outside the permitted trace state/u);
});

test('consumes NDJSON incrementally and marks an unfinished stream partial', async () => {
  const observed: Array<{ stepCount: number; partial: boolean }> = [];
  const result = await consumeTraceResponse(ndjsonResponse([metaRecord, stepRecord]), (update) => {
    observed.push({ stepCount: update.steps.length, partial: update.partial });
  });

  assert.ok(observed.some((update) => update.stepCount === 1 && update.partial));
  assert.equal(result.steps.length, 1);
  assert.equal(result.partial, true);
  assert.equal(result.end, null);
});

test('accepts and closes a complete streamed trace', async () => {
  const result = await consumeTraceResponse(ndjsonResponse([metaRecord, stepRecord, endRecord]), () => {});

  assert.equal(result.steps.length, 1);
  assert.equal(result.end?.status, 'ok');
  assert.equal(result.partial, false);
});

test('accumulates program output through the selected event', () => {
  const steps = [
    { stdout: 'Enter size: ' },
    { stdout: 'Enter elements: ' },
    { stdout: '1 2 3\nSum is 6\n' },
  ];

  assert.equal(stdoutThroughStep(steps, 0), 'Enter size: ');
  assert.equal(stdoutThroughStep(steps, 2), 'Enter size: Enter elements: 1 2 3\nSum is 6\n');
  assert.equal(stdoutThroughStep(steps, -1), '');
  assert.equal(stdoutThroughStep(steps, 99), 'Enter size: Enter elements: 1 2 3\nSum is 6\n');
});