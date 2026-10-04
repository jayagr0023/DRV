---
name: Tracing and sandbox boundaries
description: User-approved architecture constraints for the Java tracer and isolated runner.
---

- Launch the debuggee with the JDI launching connector; do not expose a JDI debug socket.
- Trace only user-source classes and skip JDK/internal classes and synthetic or bridge methods.
- Keep container privileges in a separate runner service; the public API must never access the Docker socket.
- Treat user code as hostile and run it in a fresh, no-network sandbox container that is destroyed after each run.

**Why:** These are architecture decisions approved for DryRun Visualizer. They keep the debugger private and isolate hostile student code from the public API and host.

**How to apply:** Follow these constraints in the Java tracer and sandbox phases. Do not expose a debug port or move container privileges into the API process.

**Environment check (2026-10-04):** This workspace had the Docker CLI but no Docker daemon socket, and no `java`, `javac`, or `jdb` executable. Re-check in the target runner environment before implementing or testing execution.

**Why:** The local Replit workspace cannot run the required isolated Java debuggee, so a host-process fallback would violate the approved sandbox boundary.

**How to apply:** Build and verify tracing in the separate runner environment; keep the API in a truthful degraded state until that service is available.