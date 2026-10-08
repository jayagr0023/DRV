import { CreateTraceResponse } from '@workspace/api-zod';
import type {
  StoredTraceStep,
  TraceAnnotation,
  TraceDiagnostic,
  TraceDocument,
  TraceEnd,
  TraceMetaLine,
  TraceStep,
  TraceStreamRecord,
} from '@workspace/api-client-react';
import { z } from 'zod';
import { reconstructNextStep, reconstructSteps } from '@/lib/reconstruct-trace';

export type TracePayload = {
  document: TraceDocument | null;
  meta: TraceMetaLine | null;
  steps: TraceStep[];
  end: TraceEnd | null;
  diagnostics: TraceDiagnostic[];
  annotations: TraceAnnotation[];
  partial: boolean;
};

export function stdoutThroughStep(steps: Pick<TraceStep, 'stdout'>[], activeIndex: number): string {
  const visibleStepCount = Math.max(0, Math.min(steps.length, activeIndex + 1));
  return steps.slice(0, visibleStepCount).map((step) => step.stdout).join('');
}

const documentShape = CreateTraceResponse.shape;
const traceStreamRecordSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('meta'),
    schemaVersion: documentShape.schemaVersion,
    traceId: documentShape.traceId,
    language: documentShape.language,
    languageVersion: documentShape.languageVersion,
    meta: documentShape.meta,
  }),
  z.object({
    type: z.literal('step'),
    schemaVersion: documentShape.schemaVersion,
    data: documentShape.steps.element,
  }),
  z.object({
    type: z.literal('end'),
    schemaVersion: documentShape.schemaVersion,
    end: documentShape.end,
  }),
]);

const MAX_TRACE_STEPS = 2000;
const MAX_RECORD_CHARACTERS = 5_000_000;

function payload(
  document: TraceDocument | null,
  meta: TraceMetaLine | null,
  steps: TraceStep[],
  end: TraceEnd | null,
  diagnostics: TraceDiagnostic[],
  annotations: TraceAnnotation[],
): TracePayload {
  return { document, meta, steps: [...steps], end, diagnostics, annotations, partial: end === null };
}

function readJsonDocument(value: unknown): TracePayload {
  const validated = CreateTraceResponse.parse(value);
  const document = validated as unknown as TraceDocument;
  const steps = reconstructSteps(document.steps);
  return payload(document, null, steps, document.end, document.end.diagnostics, document.annotations);
}

export async function consumeTraceResponse(
  response: Response,
  onUpdate: (value: TracePayload) => void,
): Promise<TracePayload> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('json') && !contentType.includes('ndjson')) {
    const result = readJsonDocument(await response.json());
    onUpdate(result);
    return result;
  }

  if (!response.body) throw new Error('The trace response did not include a readable body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let meta: TraceMetaLine | null = null;
  let end: TraceEnd | null = null;
  const stored: StoredTraceStep[] = [];
  const steps: TraceStep[] = [];
  let previous: TraceStep | null = null;
  let ended = false;

  const currentPayload = () => payload(null, meta, steps, end, end?.diagnostics ?? [], []);
  const consumeLine = (line: string) => {
    if (!line.trim()) return false;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(line);
    } catch {
      throw new Error('A trace stream line was not valid JSON.');
    }
    const parsedRecord = traceStreamRecordSchema.safeParse(parsedJson);
    if (!parsedRecord.success) throw new Error('A trace stream record did not match the generated contract.');
    const item = parsedRecord.data as TraceStreamRecord;

    if (ended) throw new Error('The trace stream contained data after its end record.');
    if (item.type === 'meta') {
      if (meta || stored.length) throw new Error('The trace stream metadata must appear exactly once, before its steps.');
      meta = item;
    } else {
      if (!meta) throw new Error('The trace stream omitted metadata before its first event.');
      if (item.type === 'step') {
        if (stored.length >= MAX_TRACE_STEPS) throw new Error('The trace stream exceeded the 2,000-step limit.');
        previous = reconstructNextStep(previous, item.data, stored.length);
        stored.push(item.data);
        steps.push(previous);
      } else {
        end = item.end;
        ended = true;
      }
    }
    return true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let updated = false;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        updated = consumeLine(line) || updated;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_RECORD_CHARACTERS) throw new Error('A trace stream record exceeded the allowed size.');
      if (updated) onUpdate(currentPayload());
    }

    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer.replace(/\r$/u, ''));
    const result = currentPayload();
    onUpdate(result);
    return result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}