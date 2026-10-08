# Java runner

This service accepts the versioned trace request on `POST /trace` and emits
NDJSON `meta`, `step`, and `end` records. It is intended to run separately from
the public API and inside a restricted container.

## Local development

Requires Python 3 and JDK 21+ on `PATH`. User programs are compiled against
Java 21 APIs even when a newer JDK is installed, matching the container runtime.

```powershell
$env:PORT='7000'
python .\services\java-runner\server.py
```

Health check:

```powershell
Invoke-RestMethod http://localhost:7000/health
```

## Container

```powershell
docker build -t dryrun-java:21 .\services\java-runner
docker run --rm --name dryrun-java -p 7000:7000 --network none --memory 512m --cpus 1 dryrun-java:21
```

The runner launches the debuggee through the JDK JDI launching connector and
emits one step record per user-source line across the classes in the uploaded
source file. It captures visible local variables, call frames, arrays,
user-defined objects, and the fields backing standard `java.util` collections.
When compilation fails because an unqualified public JDK class is missing, the
runner consults the active JDK image and retries with explicit imports for
unambiguous class names. Explicit imports remain recommended when names are
ambiguous. The source lines shown in the trace still match the uploaded file.
Compilation and uncaught runtime failures are returned as diagnostics with
source-line locations when the compiler or JVM provides them.

The trace is a source-level dry run: it records executable line events rather
than every bytecode operation. Object references are followed through nested
structures (including cycles) up to the runner's 500-object heap limit;
platform objects outside the common collection and numeric types are
intentionally summarized. The runner accepts one uploaded source file with
helper classes in that file; external dependencies, multi-file projects,
native code, and bytecode-level events are not supported. In the inspector,
click a reference ID to jump to that object's fields and continue following
the structure.
