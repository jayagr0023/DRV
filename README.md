# DryRun Visualizer

DryRun Visualizer is a Java learning tool that lets a user submit a short Java
program, optionally provide standard input, execute it, and step through a
source-level trace of its state. It is designed to make execution easier to
understand by showing variables, call frames, program output, heap objects, and
data structures such as arrays, lists, maps, queues, trees, and graphs when
they are captured in the program.

## Objectives

- Make Java program execution visible one source event at a time.
- Support short, single-file programs, including programs that read from
  `System.in`.
- Visualize runtime state and common data structures without requiring users
  to configure a debugger.
- Return compilation errors and uncaught runtime failures as trace diagnostics.
- Keep execution in a separate Java runner rather than executing submitted
  source inside the web application process.

## Technology stack

| Area | Technology |
| --- | --- |
| Workspace and package management | pnpm 10 workspaces |
| Web application | React 19, TypeScript, Vite 7 |
| Editor and UI | CodeMirror 6, Radix UI, Tailwind CSS |
| Client state and requests | Zustand, TanStack Query, generated API client, Zod schemas |
| API | Node.js 24, TypeScript, Express 5 |
| Java execution and tracing | Python standard-library HTTP server, JDK 21+, Java Debug Interface (JDI) |
| Production web serving | Caddy |
| Deployment | Docker, Docker Compose |

## Architecture

```text
Browser
  │
  ├── Static React app served by Caddy
  │       └── /api/* reverse proxy
  │
  └──────────────────────► Express API (port 5000, private)
                                   │
                                   └──► Java runner (port 7000, private)
                                           ├── compiles submitted Java
                                           ├── runs it through JDI
                                           └── streams trace records
```

The API validates trace requests and forwards them to the Java runner. The
runner returns newline-delimited JSON (`meta`, `step`, and `end` records). The
frontend reconstructs the state changes and displays them with trace playback
controls. The frontend development server proxies `/api` to the local API.

## Repository layout

```text
artifacts/
  api-server/                 Express API
  dryrun-visualizer/          React/Vite frontend and frontend tests
deploy/                       Production Caddy and Docker build configuration
lib/
  api-client-react/           Generated API client and hooks
  api-spec/                   OpenAPI source of truth and code generation
  api-zod/                    Generated API schemas and types
schemas/                      Versioned trace schema
services/
  java-runner/                Python service and Java JDI tracer
compose.yaml                  Full single-VM Docker deployment
```

## Requirements

For local development:

- Node.js 24
- pnpm 10.32.1 (the repository pins this in `package.json`; enable it with
  `corepack enable`)
- Python 3
- JDK 21 or newer on `PATH` (`java` and `javac`)

For Docker deployment, use Linux with Docker Engine and Docker Compose v2. The
deployment configuration supports Linux ARM64 as well as x86-64.

## Install dependencies

From the repository root:

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Run locally on Windows (PowerShell)

Open three terminals at the repository root. The Java runner must be available
before the API can advertise Java or execute traces.

### Terminal 1: Java runner

```powershell
$env:PORT = '7000'
python .\services\java-runner\server.py
```

The runner compiles its JDI tracer when the first valid Java trace is received.
Check that it responds:

```powershell
Invoke-RestMethod http://localhost:7000/health
```

### Terminal 2: API

Build the API once, then start it:

```powershell
pnpm --filter @workspace/api-server run build
$env:PORT = '5000'
$env:RUNNER_URL = 'http://127.0.0.1:7000'
pnpm --filter @workspace/api-server run start
```

The API requires `PORT`. `RUNNER_URL` defaults to
`http://127.0.0.1:7000`; set it explicitly when the runner is not on that
address.

### Terminal 3: frontend

```powershell
$env:PORT = '5173'
$env:BASE_PATH = '/'
pnpm --filter @workspace/dryrun-visualizer run dev
```

Open <http://localhost:5173>. Vite proxies `/api` requests to
`http://localhost:5000`.

### Check local services

```powershell
Invoke-RestMethod http://localhost:5000/api/healthz
Invoke-RestMethod http://localhost:5000/api/health
Invoke-RestMethod http://localhost:5000/api/languages
```

The health endpoint should report `ok`, and the language registry should list
Java. In the editor, enter a Java program, provide any input in the **Standard
input** field before running, and select **Visualize**.

For example, this input provides five array elements, then two query ranges:

```text
5
1 2 3 4 5
2
1 3
2 5
```

## Build, typecheck, and tests

Run from the repository root:

```sh
pnpm run typecheck
pnpm --filter @workspace/dryrun-visualizer run test:trace
pnpm --filter @workspace/api-server run build
```

Build the production frontend (Vite requires both environment variables):

**PowerShell**

```powershell
$env:PORT = '18670'
$env:BASE_PATH = '/'
$env:NODE_ENV = 'production'
pnpm --filter @workspace/dryrun-visualizer run build
```

**Bash**

```sh
PORT=18670 BASE_PATH=/ NODE_ENV=production \
  pnpm --filter @workspace/dryrun-visualizer run build
```

## Deploy

The supported self-hosted deployment runs the frontend, API, and runner as
Docker Compose services behind Caddy. The API and runner are private; only
Caddy's HTTP/HTTPS ports are published.

See [deploy/README.md](deploy/README.md) for the step-by-step Oracle Cloud
Always Free VM setup, DNS and firewall requirements, Compose commands,
health checks, updates, and operations.

Deployment files:

- [compose.yaml](compose.yaml) — services, private networks, health checks,
  and resource limits.
- [deploy/api.Dockerfile](deploy/api.Dockerfile) — production API image.
- [deploy/web.Dockerfile](deploy/web.Dockerfile) — production frontend and
  Caddy image.
- [deploy/Caddyfile](deploy/Caddyfile) — HTTPS, static hosting, and API proxy.
- [.env.example](.env.example) — deployment domain and certificate email
  settings; copy it to `.env` on the server.
- [services/java-runner/Dockerfile](services/java-runner/Dockerfile) — JDK
  runner container.

## Trace scope and limits

- One uploaded Java source file is supported, with helper classes in that
  file. Multi-file projects and external dependencies are not supported.
- The trace is source-level and records executable source events; it does not
  show every bytecode instruction.
- The API currently accepts Java only.
- Request limits are 20,000 bytes of source, 5,000 bytes of standard input,
  and 2,000 trace steps. Program execution is time-limited.
- The runner captures a bounded heap and summarizes many platform internals.
  Some runtime objects may therefore be truncated or summarized rather than
  fully expanded.

## Security notice

The Java runner executes user-submitted code. The Compose setup keeps the
runner off the public network, disables its internet egress, and applies
container resource limits and filesystem restrictions. The application does
not currently provide user authentication or request rate limiting. Treat a
public deployment as a hobby/learning service, monitor its resource usage, and
do not expose the runner port directly. These container controls reduce risk
but are not a substitute for a hardened multi-tenant execution sandbox.
