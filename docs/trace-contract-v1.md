# Trace contract v1

`lib/api-spec/openapi.yaml` is the source of truth for the HTTP and trace
schemas. Orval generates the TypeScript client and Zod validators from it.
`scripts/export_trace_schema.py` exports the JSON Schema at
`schemas/trace-v1.schema.json`; the FastAPI/Pydantic models mirror the same
wire contract. The contract check validates one representative document in
Zod, JSON Schema, and Pydantic.

## Versioning

Every runner job, NDJSON record, and completed `TraceDocument` carries
`schemaVersion: "1.0.0"`. The first number is the major version; clients must
reject an unknown major version. Additive, backwards-compatible fields advance
the minor version. Breaking shape or semantic changes advance the major
version. Do not change generated files by hand; update OpenAPI, regenerate, and
re-export the JSON Schema.

## Runner protocol

The runner accepts one JSON job on stdin:

```json
{
  "schemaVersion": "1.0.0",
  "language": "java",
  "code": "...",
  "stdin": "",
  "limits": {
    "maxSteps": 2000,
    "totalTimeoutMs": 10000,
    "compileTimeoutMs": 3000,
    "traceTimeoutMs": 7000,
    "maxOutputBytes": 10000,
    "maxStdinBytes": 5000,
    "maxCodeBytes": 20000
  }
}
```

It emits and flushes one NDJSON record at a time: one `meta` line, zero or more
`step` lines, then exactly one `end` line. Each line has `type` and
`schemaVersion`. An `end` line is still required after compile errors,
runtime errors, truncation, or timeout; already-emitted steps remain usable.
`POST /api/trace` documents both `application/x-ndjson` streaming and
`application/json` full-document responses.

## Snapshots and deltas

`TraceStep` describes the fully reconstructed logical state. To bound trace
storage and slider jumps, `TraceDocument.steps` stores `StoredTraceStep`
records:

- Step 0 and each step whose zero-based index is divisible by 50 is a
  `keyframe` with a complete `snapshot`.
- Other steps are `delta` records. Their `patch` is an ordered JSON-Patch-like
  list applied to the previous reconstructed step. Only `/stack`, `/statics`,
  and `/heap` (and their descendants) may be patched.
- Supported operations are `add`, `replace`, and `remove`. `add` and
  `replace` require `value`; `remove` omits it. Paths use JSON Pointer escaping
  (`~1` for `/`, `~0` for `~`). Operations are applied in order.
- A delta carries the current step's event, line, frame, stack truncation
  count, stdout/stderr additions, changed paths, explanation, and error. The
  patch replaces only state roots; it does not patch those event fields.

To reconstruct step N, locate the nearest preceding keyframe and apply at
most 49 following deltas. Reconstructed steps are immutable values. The
frontend reconstruction function must be pure and must not mutate a keyframe
or earlier step.

## Stable trace IDs

The ID is the lowercase hexadecimal SHA-256 digest of four UTF-8 values in
order: `language`, `code`, `stdin`, `schemaVersion`. Each value is prefixed by
its byte length as an unsigned 64-bit big-endian integer. This tuple encoding
is unambiguous, including when source or stdin contains NUL bytes.

## Extension seams shipped in v1

- `TraceStore` exposes `put(document)` and `get(traceId)`; v1 uses
  `NoOpTraceStore`.
- `Explainer` exposes `explain(step, prevStep, sourceModel)` and is selected
  through `ExplainerRegistry`.
- `AnalyzerPipeline` runs registered post-trace analyzers and returns an
  annotation list; the v1 pipeline is empty.
- `FeatureFlags` defines `shareLinks`, `compare`, and `aiExplain`, all false.
- `LanguageAdapterRegistry` currently contains Java only; `/api/languages` is
  derived from its descriptors.

## Sandbox boundary note

The public API must not receive Docker socket access. The separate
runner-service is the only container-control boundary. Linux JDI's launching
connector commonly uses a local socket transport; container network isolation
and debug-channel reachability must be verified before describing the runner as
hardened. Static source checks are defense in depth, not a sandbox.