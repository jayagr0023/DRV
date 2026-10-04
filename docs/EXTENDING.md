# Extending DryRun Visualizer

The shared wire contract is `lib/api-spec/openapi.yaml`. After changing it,
run `pnpm --filter @workspace/api-spec run codegen` and
`python3 scripts/export_trace_schema.py`. Keep TypeScript/Zod, Pydantic, and
JSON Schema validation aligned.

## Add an analyzer

Implement `TraceAnalyzer.analyze(document) -> Annotation[]`, register it in the
`AnalyzerPipeline`, and test the returned annotation's step index, severity,
code, and beginner-readable message. V1 intentionally registers no analyzers;
the document always contains an `annotations` array.

## Add an explainer

Implement `Explainer.explain(step, prevStep, sourceModel) -> string`, then
register a factory in `ExplainerRegistry`. Explanations must not be empty and
must be grounded in the step and its variable diff. Keep language-specific
details in `meta`.

## Add a trace store

Implement `TraceStore.put(document)` and `TraceStore.get(traceId)`. The v1
implementation is `NoOpTraceStore`; it does not retain data and there is no
trace retrieval endpoint. A persistent implementation must be introduced with
an explicit retention and access policy.

## Add a feature flag

Add a typed field to `FeatureFlags`, default it to false, and keep its UI
hidden while disabled. V1 flags are `shareLinks`, `compare`, and `aiExplain`,
all false.

## Schema compatibility

Additive, backwards-compatible schema changes advance the minor version.
Breaking changes advance the major version. Frontends must reject unknown
major versions with a clear message.