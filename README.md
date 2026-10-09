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
| Workspace and package management | npm 11 workspaces |
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
- npm 11.10.1 (the repository pins this in `package.json`)
- Python 3
- JDK 21 or newer on `PATH` (`java` and `javac`)

For Docker deployment, use Linux with Docker Engine and Docker Compose v2. The
deployment configuration supports Linux ARM64 as well as x86-64.

## Install dependencies

From the repository root:

```sh
npm ci
```

## Run locally on Windows (PowerShell)

Open three terminals at the repository root. The Java runner must be available
before the API can advertise Java or execute traces.

For a fresh checkout, create the local env files from their examples:

```powershell
Copy-Item .\artifacts\api-server\.env.example .\artifacts\api-server\.env
Copy-Item .\artifacts\dryrun-visualizer\.env.example .\artifacts\dryrun-visualizer\.env
```

Replace `RUNNER_API_KEY` in the API env file with a long random value before
starting the services. Do not commit local `.env` files.

### Terminal 1: Java runner

```powershell
$env:PORT = '7000'
$env:RUNNER_API_KEY = (Get-Content .\artifacts\api-server\.env |
  Where-Object { $_ -match '^RUNNER_API_KEY=' } |
  Select-Object -First 1) -replace '^RUNNER_API_KEY=', ''
python .\services\java-runner\server.py
```

Use the same `RUNNER_API_KEY` in the API and runner. The runner compiles its
JDI tracer when the first valid Java trace is received.
Check that it responds:

```powershell
Invoke-RestMethod http://localhost:7000/health
```

### Terminal 2: API

Build the API once, then start it:

```powershell
npm run build --workspace=@workspace/api-server
npm run start --workspace=@workspace/api-server
```

The API loads `artifacts/api-server/.env` when started, including its port,
runner URL, and shared runner key.

### Terminal 3: frontend

```powershell
npm run dev --workspace=@workspace/dryrun-visualizer
```

Vite loads `artifacts/dryrun-visualizer/.env`. Open
<http://localhost:5173>; Vite proxies `/api` requests to
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
npm run typecheck
npm run test:trace --workspace=@workspace/dryrun-visualizer
npm run build --workspace=@workspace/api-server
```

Build the production frontend (Vite requires both environment variables):

**PowerShell**

```powershell
$env:PORT = '18670'
$env:BASE_PATH = '/'
$env:NODE_ENV = 'production'
npm run build --workspace=@workspace/dryrun-visualizer
```

**Bash**

```sh
PORT=18670 BASE_PATH=/ NODE_ENV=production \
  npm run build --workspace=@workspace/dryrun-visualizer
```

## Deploy

The supported self-hosted deployment runs the frontend, API, and runner as
Docker Compose services behind Caddy. The API and runner are private; only
Caddy's HTTP/HTTPS ports are published.

See [deploy/README.md](deploy/README.md) for the step-by-step Oracle Cloud
Always Free VM setup, DNS and firewall requirements, Compose commands,
health checks, updates, and operations.

## Deploy the frontend on Vercel and services on Render

The frontend can be hosted as a Vercel static site while the Express API and
Java runner run as separate Render services. The API must be publicly reachable
by the browser; keep the runner private and connect it to the API over Render's
private network. Deploy both Render services in the same region.

### Render API and Java runner

Create two Render services from this repository:

1. Create a **private service** for the Java runner with runtime **Docker**,
   Dockerfile path `services/java-runner/Dockerfile`, and Docker build context
   `services/java-runner`. Set `PORT` to `7000` and `RUNNER_API_KEY` to a long,
   random secret. Use an always-on instance with enough memory for Java
   execution.
2. Create a public **web service** for the API with runtime **Docker**,
   Dockerfile path `deploy/api.Dockerfile`, and Docker build context `.`. Set
   `PORT` to `5000`, `RUNNER_API_KEY` to the exact same value configured on the
   runner, and `RUNNER_URL` to the runner's internal address shown in its
   Render dashboard, including `http://` and `:7000` (for example,
   `http://<runner-internal-host>:7000`).
3. After the API deploys, verify
   `https://<api-service>.onrender.com/api/healthz` and
   `https://<api-service>.onrender.com/api/languages`. The language list should
   include Java.

Set these environment variables in the deployed services:

| Service | Variable | Value |
| --- | --- | --- |
| Render Java runner | `PORT` | `7000` |
| Render Java runner | `RUNNER_API_KEY` | A long random secret |
| Render API | `PORT` | `5000` |
| Render API | `RUNNER_URL` | Runner's internal URL, e.g. `http://<runner-internal-host>:7000` |
| Render API | `RUNNER_API_KEY` | The exact same secret as the Java runner |

### Vercel frontend

Import the repository into Vercel with the repository root as the project root.
The root [`vercel.json`](./vercel.json) supplies the workspace build command,
static output directory, and SPA rewrite. Add this Vercel environment variable
for the Production environment (and Preview too, if previews should use the
same API):

```text
VITE_API_BASE_URL=https://<api-service>.onrender.com
```

Set `VITE_API_BASE_URL` in the Vercel project's Production environment (and
Preview too, if previews should use the same API). Use the API origin only; do
not append `/api`. Redeploy after setting the variable, since Vite embeds it
into the frontend at build time.

Set the same `RUNNER_API_KEY` in the API and Java runner service environments;
the API uses it to authenticate its trace requests to the runner. The API
currently allows cross-origin requests so the Vercel site can call it.
For a public deployment, protect and monitor trace execution: submitted Java
programs consume CPU and memory. Render free web services may sleep when idle;
use always-on instances where reliable execution availability is required.

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
