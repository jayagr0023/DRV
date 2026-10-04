# Adding a language adapter

The v1 registry exposes Java 21 only. Adding another language requires a
language adapter and a runner image that implements the same versioned job and
NDJSON protocol; it does not change the frontend's core trace fields.

1. Implement the `LanguageAdapter` interface with an ID, display name, version,
   runner image, file extension, starter template, examples, limits, and
   `validate(code)`.
2. Register it in `LanguageAdapterRegistry`. The API's language list is
   generated from the registry; do not maintain a second hard-coded dropdown.
3. Make the runner consume the shared job JSON and emit a `meta` record,
   `step` records, and a terminal `end` record. Put language-only data in
   `meta`.
4. Validate the runner records against the shared schema and add normalized
   golden traces for its language-specific behavior.
5. Keep execution in a fresh, restricted runner container. Never grant the
   public API container runtime control.

Do not register a language until its runner meets the same timeout, output,
input, and partial-trace guarantees as Java.