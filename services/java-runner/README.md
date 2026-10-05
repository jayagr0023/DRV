# Java runner

This service accepts the versioned trace request on `POST /trace` and emits
NDJSON `meta`, `step`, and `end` records. It is intended to run separately from
the public API and inside a restricted container.

## Local development

Requires Python 3 and JDK 21+ on `PATH`:

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
emits one step record per user-source line. It captures visible local variables
and call frames. Heap object inspection, exception requests, and richer
collection rendering remain follow-up work behind this same protocol.
