import {
  CreateTraceBody,
  CreateTraceResponse,
} from '@workspace/api-zod';
import type {
  KeyframeStep,
  RunnerJob,
  TraceEnd,
  TraceStreamRecord,
} from '@workspace/api-zod';
import { createHash } from 'node:crypto';

const source =
  'public class Main { public static void main(String[] args) { System.out.println(1); } }';
const traceIdHash = createHash('sha256');
for (const part of ['java', source, '', '1.0.0']) {
  const bytes = Buffer.from(part, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  traceIdHash.update(length).update(bytes);
}
const traceId = traceIdHash.digest('hex');
if (traceId !== '2a4ae6c501d883083c3da23b735305053172a47856d900e7f6948901a836947d') {
  throw new Error(`Trace ID differs from the v1 cross-language fixture: ${traceId}`);
}

const traceRequest = {
  schemaVersion: '1.0.0',
  language: 'java',
  code: source,
  stdin: '',
};

const sampleKeyframe = {
  storage: 'keyframe',
  step: 0,
  snapshot: {
    step: 0,
    event: 'line',
    line: 1,
    frame: { method: 'main', class: 'Main' },
    stack: [{ method: 'main', class: 'Main', line: 1, locals: {} }],
    stackTruncated: 0,
    statics: {},
    heap: {},
    stdout: '',
    stderr: '',
    changed: [],
    explanation: 'Started main; no variables changed yet.',
    error: null,
  },
} satisfies KeyframeStep;

const sampleEnd = {
  status: 'ok',
  diagnostics: [],
} satisfies TraceEnd;

const sampleDocument = {
  traceId,
  schemaVersion: '1.0.0',
  language: 'java',
  languageVersion: '21',
  createdAt: '2026-10-04T12:00:00Z',
  source,
  stdin: '',
  meta: {},
  steps: [sampleKeyframe],
  annotations: [],
  end: sampleEnd,
};

CreateTraceBody.parse(traceRequest);
CreateTraceResponse.parse(sampleDocument);
const runnerJob = {
  schemaVersion: '1.0.0',
  language: 'java',
  code: source,
  stdin: '',
  limits: {
    maxSteps: 2000,
    totalTimeoutMs: 10000,
    compileTimeoutMs: 3000,
    traceTimeoutMs: 7000,
    maxOutputBytes: 10000,
    maxStdinBytes: 5000,
    maxCodeBytes: 20000,
  },
} satisfies RunnerJob;

const streamRecords: TraceStreamRecord[] = [
  {
    type: 'meta',
    schemaVersion: '1.0.0',
    traceId,
    language: 'java',
    languageVersion: '21',
    meta: {},
  },
  {
    type: 'step',
    schemaVersion: '1.0.0',
    data: sampleDocument.steps[0],
  },
  {
    type: 'end',
    schemaVersion: '1.0.0',
    end: sampleDocument.end,
  },
];

if (runnerJob.limits.maxSteps !== 2000 || streamRecords.length !== 3) {
  throw new Error('The typed v1 runner fixtures are incomplete.');
}
console.log('TypeScript request and trace schemas validated; runner job and stream types compiled.');