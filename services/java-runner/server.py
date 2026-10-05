from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import tempfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "1.0.0"
MAX_CODE_BYTES = 20_000
MAX_STDIN_BYTES = 5_000
MAX_OUTPUT_BYTES = 10_000
COMPILE_TIMEOUT_SECONDS = 10
RUN_TIMEOUT_SECONDS = 7
TRACER_SOURCE = Path(__file__).with_name("src") / "JdiTracer.java"
TRACER_CLASSES = Path(__file__).with_name("classes")


def trace_id(language: str, code: str, stdin: str) -> str:
    digest = hashlib.sha256()
    for value in (language, code, stdin, SCHEMA_VERSION):
        encoded = value.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def diagnostic(message: str, severity: str = "error", line: int | None = None) -> dict[str, Any]:
    return {"line": line, "column": None, "message": message, "severity": severity}


def parse_compile_line(output: str) -> tuple[str, int | None]:
    match = re.search(r"Main\.java:(\d+):\s*(.*)", output)
    if match:
        return match.group(2).strip(), int(match.group(1))
    return output.strip() or "Java compilation failed.", None


def record_line(record: dict[str, Any]) -> bytes:
    return (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")


def ensure_tracer() -> None:
    tracer_class = TRACER_CLASSES / "JdiTracer.class"
    if tracer_class.exists() and tracer_class.stat().st_mtime >= TRACER_SOURCE.stat().st_mtime:
        return
    TRACER_CLASSES.mkdir(parents=True, exist_ok=True)
    compiled = subprocess.run(
        ["javac", "--add-modules", "jdk.jdi", "-g", "-d", str(TRACER_CLASSES), str(TRACER_SOURCE)],
        capture_output=True,
        text=True,
        timeout=COMPILE_TIMEOUT_SECONDS,
        check=False,
    )
    if compiled.returncode != 0:
        raise RuntimeError(compiled.stderr.strip() or "The JDI tracer could not be compiled.")


def run_trace(payload: dict[str, Any]) -> list[bytes]:
    language = payload.get("language")
    code = payload.get("code")
    stdin = payload.get("stdin", "")
    if language != "java":
        raise ValueError("Only Java jobs are supported.")
    if not isinstance(code, str) or not isinstance(stdin, str):
        raise ValueError("code and stdin must be strings.")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise ValueError("Source exceeds the 20,000-byte limit.")
    if len(stdin.encode("utf-8")) > MAX_STDIN_BYTES:
        raise ValueError("Standard input exceeds the 5,000-byte limit.")

    identifier = trace_id(language, code, stdin)
    meta = {
        "type": "meta",
        "schemaVersion": SCHEMA_VERSION,
        "traceId": identifier,
        "language": "java",
        "languageVersion": "21",
        "meta": {"runner": "local-java-runner", "mode": "process"},
    }
    output = [record_line(meta)]

    with tempfile.TemporaryDirectory(prefix="dryrun-java-") as directory:
        source = Path(directory) / "Main.java"
        source.write_text(code, encoding="utf-8")
        try:
            compiled = subprocess.run(
                ["javac", "-g", "-proc:none", "-encoding", "UTF-8", "Main.java"],
                cwd=directory,
                capture_output=True,
                text=True,
                timeout=COMPILE_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired:
            output.append(record_line({"type": "end", "schemaVersion": SCHEMA_VERSION, "end": {"status": "timeout", "diagnostics": [diagnostic("Java compilation timed out.")]}}))
            return output

        if compiled.returncode != 0:
            message, line = parse_compile_line(compiled.stderr)
            output.append(record_line({"type": "end", "schemaVersion": SCHEMA_VERSION, "end": {"status": "compile_error", "diagnostics": [diagnostic(message, line=line)]}}))
            return output

        ensure_tracer()
        stdin_file = Path(directory) / "stdin.txt"
        stdin_file.write_text(stdin, encoding="utf-8")
        environment = {**os.environ, "DRYRUN_MAIN_CLASS": "Main"}
        try:
            traced = subprocess.run(
                ["java", "--add-modules", "jdk.jdi", "-cp", str(TRACER_CLASSES), "JdiTracer", directory, str(stdin_file)],
                cwd=directory,
                capture_output=True,
                text=True,
                timeout=RUN_TIMEOUT_SECONDS,
                check=False,
                env=environment,
            )
        except subprocess.TimeoutExpired:
            output.append(record_line({"type": "end", "schemaVersion": SCHEMA_VERSION, "end": {"status": "timeout", "diagnostics": [diagnostic("Java tracing timed out.")]}}))
            return output

        snapshots: list[dict[str, Any]] = []
        terminal: dict[str, Any] | None = None
        for line in traced.stdout.splitlines():
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if item.get("kind") == "end":
                terminal = item
            elif "step" in item and "stack" in item:
                snapshots.append(item)

        if snapshots and terminal:
            snapshots[-1]["stdout"] += terminal.get("stdout", "")
            snapshots[-1]["stderr"] += terminal.get("stderr", "")

        for index, snapshot in enumerate(snapshots):
            snapshot["step"] = index
            if index == 0 or index % 50 == 0:
                data = {"storage": "keyframe", "step": index, "snapshot": snapshot}
            else:
                data = {
                    "storage": "delta",
                    "step": index,
                    "event": snapshot["event"],
                    "line": snapshot["line"],
                    "frame": snapshot["frame"],
                    "stackTruncated": snapshot["stackTruncated"],
                    "patch": [
                        {"op": "replace", "path": "/stack", "value": snapshot["stack"]},
                        {"op": "replace", "path": "/statics", "value": snapshot["statics"]},
                        {"op": "replace", "path": "/heap", "value": snapshot["heap"]},
                    ],
                    "stdout": snapshot["stdout"],
                    "stderr": snapshot["stderr"],
                    "changed": snapshot["changed"],
                    "explanation": snapshot["explanation"],
                    "error": snapshot["error"],
                }
            output.append(record_line({"type": "step", "schemaVersion": SCHEMA_VERSION, "data": data}))

        status = (terminal or {}).get("status", "runtime_error" if traced.returncode else "ok")
        if snapshots and not traced.stderr.strip():
            status = "ok"
        diagnostics = []
        if traced.returncode != 0 and not snapshots:
            diagnostics.append(diagnostic(traced.stderr.strip() or "The JDI tracer failed."))
        output.append(record_line({"type": "end", "schemaVersion": SCHEMA_VERSION, "end": {"status": status, "diagnostics": diagnostics}}))
        return output


class Handler(BaseHTTPRequestHandler):
    server_version = "dryrun-java-runner/0.1"

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"status":"ok"}')
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        if self.path != "/trace":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length))
            records = run_trace(payload)
        except (ValueError, json.JSONDecodeError) as error:
            body = json.dumps({"error": str(error), "code": "INVALID_TRACE_REQUEST"}).encode("utf-8")
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        except Exception as error:
            body = json.dumps({"error": str(error), "code": "TRACE_RUNNER_ERROR"}).encode("utf-8")
            self.send_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for record in records:
            self.wfile.write(record)
            self.wfile.flush()

    def log_message(self, format: str, *args: object) -> None:
        print(f"[{datetime.now(timezone.utc).isoformat()}] {format % args}")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7000"))
    print(f"Java runner listening on http://127.0.0.1:{port}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
