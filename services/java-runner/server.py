from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
from typing import Any

SCHEMA_VERSION = "1.0.0"
MAX_CODE_BYTES = 20_000
MAX_STDIN_BYTES = 5_000
MAX_OUTPUT_BYTES = 10_000
COMPILE_TIMEOUT_SECONDS = 10
RUN_TIMEOUT_SECONDS = 30
TRACER_SOURCE = Path(__file__).with_name("src") / "JdiTracer.java"
TRACER_CLASSES = Path(__file__).with_name("classes")
JAVA_IDENTIFIER = r"[A-Za-z_$][A-Za-z0-9_$]*"
JDK_CLASS_INDEX: dict[str, tuple[str, ...]] | None = None
JDK_CLASS_INDEX_LOCK = Lock()


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
    match = re.search(r"[A-Za-z_$][A-Za-z0-9_$]*\.java:(\d+):\s*(.*)", output)
    if match:
        return match.group(2).strip(), int(match.group(1))
    return output.strip() or "Java compilation failed.", None


def jdk_class_index() -> dict[str, tuple[str, ...]]:
    global JDK_CLASS_INDEX
    if JDK_CLASS_INDEX is not None:
        return JDK_CLASS_INDEX

    with JDK_CLASS_INDEX_LOCK:
        if JDK_CLASS_INDEX is not None:
            return JDK_CLASS_INDEX

        java = shutil.which("java")
        if java is None:
            raise RuntimeError("The Java runtime could not be found on PATH.")
        properties = subprocess.run(
            [java, "-XshowSettings:properties", "-version"],
            capture_output=True,
            text=True,
            timeout=COMPILE_TIMEOUT_SECONDS,
            check=False,
        )
        home = re.search(r"(?m)^\s*java\.home\s*=\s*(.+?)\s*$", properties.stderr)
        if properties.returncode != 0 or home is None:
            raise RuntimeError("The Java runtime location could not be determined.")

        jdk_home = Path(home.group(1))
        jimage = jdk_home / "bin" / ("jimage.exe" if os.name == "nt" else "jimage")
        modules = jdk_home / "lib" / "modules"
        if not jimage.is_file() or not modules.is_file():
            raise RuntimeError("The active JDK does not include its module image tools.")
        listing = subprocess.run(
            [str(jimage), "list", str(modules)],
            capture_output=True,
            text=True,
            timeout=COMPILE_TIMEOUT_SECONDS,
            check=False,
        )
        if listing.returncode != 0:
            raise RuntimeError(listing.stderr.strip() or "The JDK class index could not be read.")

        classes: dict[str, set[str]] = {}
        for entry in listing.stdout.splitlines():
            match = re.fullmatch(
                r"(?:java|javax|jdk|org)/[A-Za-z0-9_$./-]+/([A-Za-z_$][A-Za-z0-9_$]*)\.class",
                entry.strip(),
            )
            if match and "$" not in match.group(1):
                class_name = match.group(1)
                qualified_name = entry.strip()[:-6].replace("/", ".")
                classes.setdefault(class_name, set()).add(qualified_name)

        JDK_CLASS_INDEX = {
            name: tuple(sorted(qualified_names))
            for name, qualified_names in classes.items()
        }
        return JDK_CLASS_INDEX


def add_missing_jdk_imports(code: str, compiler_output: str) -> tuple[str, int, int]:
    missing_symbols = set(
        re.findall(r"symbol:\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)", compiler_output)
    )
    if not missing_symbols:
        return code, 0, 0

    masked_code = mask_java_non_code(code)
    declared_names = set(
        re.findall(
            rf"\b(?:class|interface|enum|record)\s+({JAVA_IDENTIFIER})\b",
            masked_code,
        )
    )
    explicit_imports = set(
        re.findall(
            rf"(?m)^\s*import\s+(?:static\s+)?[\w.$]+\.({JAVA_IDENTIFIER})\s*;",
            code,
        )
    )
    wildcard_packages = set(
        re.findall(r"(?m)^\s*import\s+([\w.]+)\.\*\s*;", code)
    )
    class_index = jdk_class_index()
    imports_to_add = []
    for name in sorted(missing_symbols - declared_names - explicit_imports):
        candidates = class_index.get(name, ())
        java_util_type = f"java.util.{name}"
        if java_util_type in candidates:
            candidates = (java_util_type,)
        if len(candidates) != 1:
            continue
        qualified_name = candidates[0]
        if any(qualified_name.startswith(f"{package}.") for package in wildcard_packages):
            continue
        imports_to_add.append(qualified_name)
    if not imports_to_add:
        return code, 0, 0

    declarations = list(
        re.finditer(
            r"(?m)^[ \t]*(?:package|import)\b[^;\r\n]*;[^\r\n]*(?:\r?\n|$)",
            code,
        )
    )
    insertion = declarations[-1].end() if declarations else 0
    insertion_after_line = code[:insertion].count("\n")
    added_imports = "".join(f"import {name};\n" for name in imports_to_add)
    return (
        code[:insertion] + added_imports + code[insertion:],
        len(imports_to_add),
        insertion_after_line,
    )


def mask_java_non_code(code: str) -> str:
    pattern = re.compile(
        r'"""[\s\S]*?"""|//[^\r\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\''
    )
    return pattern.sub(
        lambda match: "".join(
            character if character in "\r\n" else " "
            for character in match.group()
        ),
        code,
    )


def detect_main_class(code: str) -> tuple[str, str]:
    code = mask_java_non_code(code)
    package_match = re.search(rf"\bpackage\s+({JAVA_IDENTIFIER}(?:\.{JAVA_IDENTIFIER})*)\s*;", code)
    package_name = package_match.group(1) if package_match else ""
    declarations = list(re.finditer(
        rf"\b(?P<public>public\s+)?(?:(?:final|abstract|sealed|non-sealed|strictfp)\s+)*(?:class|record|enum|interface)\s+(?P<name>{JAVA_IDENTIFIER})\b",
        code,
    ))
    top_level_declarations = []
    for declaration in declarations:
        depth = 0
        for character in code[:declaration.start()]:
            if character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
        if depth == 0:
            top_level_declarations.append(declaration)
    if not top_level_declarations:
        return "Main", "Main"

    main_pattern = re.compile(r"\bstatic\s+void\s+main\s*\(")
    main_declarations = []
    for declaration in top_level_declarations:
        body_start = code.find("{", declaration.end())
        if body_start < 0:
            continue
        depth = 0
        body_end = None
        for index in range(body_start, len(code)):
            if code[index] == "{":
                depth += 1
            elif code[index] == "}":
                depth -= 1
                if depth == 0:
                    body_end = index
                    break
        if body_end is None:
            continue

        depth = 1
        position = body_start + 1
        for main_match in main_pattern.finditer(code, position, body_end):
            while position < main_match.start():
                if code[position] == "{":
                    depth += 1
                elif code[position] == "}":
                    depth -= 1
                position += 1
            if depth == 1:
                main_declarations.append(declaration)
                break

    public_declarations = [item for item in top_level_declarations if item.group("public")]
    selected = next((item for item in main_declarations if item.group("public")), None)
    selected = selected or (main_declarations[0] if main_declarations else None)
    selected = selected or (public_declarations[0] if public_declarations else top_level_declarations[0])
    source_name = (
        public_declarations[0].group("name")
        if public_declarations
        else selected.group("name")
    )
    main_class = selected.group("name")
    return (f"{package_name}.{main_class}" if package_name else main_class), source_name


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
        main_class, source_name = detect_main_class(code)
        source = Path(directory) / f"{source_name}.java"
        normalized_code = code.replace("\r\n", "\n").replace("\r", "\n")
        source.write_bytes(normalized_code.encode("utf-8"))
        synthetic_import_count = 0
        import_insertion_line = 0
        try:
            compiled = subprocess.run(
                [
                    "javac",
                    "-g",
                    "-proc:none",
                    "-encoding",
                    "UTF-8",
                    "--release",
                    "21",
                    "-d",
                    directory,
                    source.name,
                ],
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
            source_with_imports, synthetic_import_count, import_insertion_line = (
                add_missing_jdk_imports(normalized_code, compiled.stderr)
            )
            if synthetic_import_count:
                source.write_bytes(source_with_imports.encode("utf-8"))
                try:
                    compiled = subprocess.run(
                        [
                            "javac",
                            "-g",
                            "-proc:none",
                            "-encoding",
                            "UTF-8",
                            "--release",
                            "21",
                            "-d",
                            directory,
                            source.name,
                        ],
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
            if line is not None and line > import_insertion_line:
                line -= synthetic_import_count
            output.append(record_line({"type": "end", "schemaVersion": SCHEMA_VERSION, "end": {"status": "compile_error", "diagnostics": [diagnostic(message, line=line)]}}))
            return output

        ensure_tracer()
        stdin_file = Path(directory) / "stdin.txt"
        stdin_file.write_bytes(stdin.encode("utf-8"))
        environment = {
            **os.environ,
            "DRYRUN_MAIN_CLASS": main_class,
            "DRYRUN_SOURCE_FILE": source.name,
            "DRYRUN_SYNTHETIC_IMPORTS": str(synthetic_import_count),
            "DRYRUN_IMPORT_INSERTION_LINE": str(import_insertion_line),
        }
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
                    **(
                        {"returnValue": snapshot["returnValue"]}
                        if "returnValue" in snapshot
                        else {}
                    ),
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

        status = (terminal or {}).get(
            "status", "runtime_error" if traced.returncode else "ok"
        )
        diagnostics = []
        runtime_output = (terminal or {}).get("stderr", "").strip()
        if status == "runtime_error":
            exception_line = next(
                (line.strip() for line in runtime_output.splitlines() if line.strip()),
                "",
            )
            source_line = None
            if exception_line:
                match = re.search(
                    rf"\b{re.escape(source.name)}:(\d+)\)",
                    runtime_output,
                )
                source_line = int(match.group(1)) if match else None
                if source_line is not None and source_line > import_insertion_line:
                    source_line -= synthetic_import_count
                diagnostics.append(
                    diagnostic(exception_line, line=source_line)
                )
            elif terminal and terminal.get("exitCode") not in (None, 0):
                diagnostics.append(
                    diagnostic(
                        f"Program exited with status {terminal['exitCode']}."
                    )
                )
        if traced.returncode != 0 and not diagnostics:
            diagnostics.append(
                diagnostic(traced.stderr.strip() or "The JDI tracer failed.")
            )
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
