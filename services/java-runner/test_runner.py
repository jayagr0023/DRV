import json
import subprocess
import sys
import urllib.request

process = subprocess.Popen(
    [sys.executable, "services/java-runner/server.py"],
    env={**__import__("os").environ, "PORT": "7001"},
)
try:
    request = urllib.request.Request(
        "http://127.0.0.1:7001/trace",
        data=json.dumps({
            "schemaVersion": "1.0.0",
            "language": "java",
            "code": "public class Main { public static void main(String[] args) { System.out.println(42); } }",
            "stdin": "",
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request) as response:
        records = [json.loads(line) for line in response.read().splitlines()]
    assert [record["type"] for record in records][0] == "meta"
    assert [record["type"] for record in records][-1] == "end"
    assert sum(record["type"] == "step" for record in records) >= 1
    assert records[-1]["end"]["status"] == "ok"
    steps = [record for record in records if record["type"] == "step"]
    assert any(
        record["data"].get("snapshot", {}).get("stdout") == "42\n"
        or record["data"].get("stdout") == "42\n"
        for record in steps
    )

    recursive_request = urllib.request.Request(
        "http://127.0.0.1:7001/trace",
        data=json.dumps({
            "schemaVersion": "1.0.0",
            "language": "java",
            "code": "public class Main { static int factorial(int n) { if (n <= 1) return 1; return n * factorial(n - 1); } public static void main(String[] args) { System.out.println(factorial(3)); } }",
            "stdin": "",
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(recursive_request) as response:
        recursive_records = [json.loads(line) for line in response.read().splitlines()]
    recursive_stacks = []
    for record in recursive_records:
        if record["type"] != "step":
            continue
        data = record["data"]
        stack = data.get("snapshot", {}).get("stack")
        if stack is None:
            stack = next(p["value"] for p in data["patch"] if p["path"] == "/stack")
        recursive_stacks.append([frame["method"] for frame in stack])
    assert ["main", "factorial", "factorial"] in recursive_stacks
    print("java runner smoke test passed")
finally:
    process.terminate()
    process.wait()
