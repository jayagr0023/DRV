import type { DeltaStep, StoredTraceStep, TraceStep } from '@workspace/api-client-react';

const KEYFRAME_INTERVAL = 50;
const clone = <T,>(value: T): T => structuredClone(value);

function decodePointer(path: string): string[] {
  if (path.length > 512 || !path.startsWith('/')) throw new Error('Patch path is malformed or too long.');
  const parts = path.slice(1).split('/').map((part) => {
    if (/~(?![01])/u.test(part)) throw new Error('Patch path contains an invalid JSON Pointer escape.');
    return part.replace(/~1/g, '/').replace(/~0/g, '~');
  });
  if (parts.length > 32 || !['stack', 'statics', 'heap'].includes(parts[0])) {
    throw new Error('Patch path is outside the permitted trace state.');
  }
  return parts;
}

function setOwnValue(record: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function applyOperation(root: TraceStep, operation: DeltaStep['patch'][number]): void {
  const parts = decodePointer(operation.path);
  const hasValue = Object.hasOwn(operation, 'value');
  if ((operation.op === 'add' || operation.op === 'replace') && (!hasValue || operation.value === undefined)) {
    throw new Error('Patch operation is missing its value.');
  }
  if (operation.op === 'remove' && hasValue) throw new Error('Remove operations must not include a value.');

  let parent: unknown = root;
  for (const key of parts.slice(0, -1)) {
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length) throw new Error('Patch array path is out of bounds.');
      parent = parent[Number(key)];
    } else if (typeof parent === 'object' && parent !== null && Object.hasOwn(parent, key)) {
      parent = (parent as Record<string, unknown>)[key];
    } else {
      throw new Error('Patch path does not resolve to an existing state container.');
    }
  }

  const key = parts.at(-1)!;
  if (Array.isArray(parent)) {
    if (key === '-' && operation.op !== 'add') throw new Error('The append marker is only valid for add operations.');
    if (key !== '-' && !/^(0|[1-9]\d*)$/u.test(key)) throw new Error('Patch array index is malformed.');
    const index = key === '-' ? parent.length : Number(key);
    if (!Number.isInteger(index) || index < 0 || index > parent.length || (operation.op !== 'add' && index >= parent.length)) {
      throw new Error('Patch array index is out of bounds.');
    }
    if (operation.op === 'remove') parent.splice(index, 1);
    else if (operation.op === 'add') parent.splice(index, 0, clone(operation.value));
    else parent[index] = clone(operation.value);
    return;
  }

  if (typeof parent !== 'object' || parent === null) throw new Error('Patch target is not a container.');
  const target = parent as Record<string, unknown>;
  if ((operation.op === 'remove' || operation.op === 'replace') && !Object.hasOwn(target, key)) {
    throw new Error('Patch target does not exist.');
  }
  if (operation.op === 'remove') delete target[key];
  else setOwnValue(target, key, clone(operation.value));
}

export function reconstructNextStep(
  previous: TraceStep | null,
  entry: StoredTraceStep,
  expectedStep: number,
): TraceStep {
  if (entry.step !== expectedStep) throw new Error('Trace steps must be contiguous and start at zero.');
  const shouldBeKeyframe = expectedStep % KEYFRAME_INTERVAL === 0;
  if ((entry.storage === 'keyframe') !== shouldBeKeyframe) {
    throw new Error(`A full keyframe is required every ${KEYFRAME_INTERVAL} steps.`);
  }

  if (entry.storage === 'keyframe') {
    if (!entry.snapshot || entry.snapshot.step !== entry.step) throw new Error('Keyframe step is malformed.');
    return clone(entry.snapshot);
  }

  if (!previous) throw new Error('A delta arrived before its base keyframe.');
  const state: TraceStep = clone(previous);
  for (const operation of entry.patch) applyOperation(state, operation);

  return {
    ...state,
    step: entry.step,
    event: entry.event,
    line: entry.line,
    frame: clone(entry.frame),
    stackTruncated: entry.stackTruncated,
    stdout: entry.stdout,
    stderr: entry.stderr,
    changed: clone(entry.changed),
    explanation: entry.explanation,
    error: clone(entry.error),
  };
}

export function reconstructSteps(stored: StoredTraceStep[]): TraceStep[] {
  const full: TraceStep[] = [];
  let previous: TraceStep | null = null;
  for (const [index, entry] of stored.entries()) {
    previous = reconstructNextStep(previous, entry, index);
    full.push(previous);
  }
  return full;
}