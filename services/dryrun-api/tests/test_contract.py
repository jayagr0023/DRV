from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "services" / "dryrun-api"))

from dryrun_api.contracts import (  # noqa: E402
    FeatureFlags,
    RunnerJob,
    TraceDocument,
    compute_trace_id,
)
from dryrun_api.extensions import AnalyzerPipeline, NoOpTraceStore  # noqa: E402
from dryrun_api.registry import language_adapters  # noqa: E402
from scripts.export_trace_schema import export_schema  # noqa: E402

SAMPLE_TRACE_ID = "2a4ae6c501d883083c3da23b735305053172a47856d900e7f6948901a836947d"


def sample_document() -> dict:
    source = (
        "public class Main { public static void main(String[] args) { "
        "System.out.println(1); } }"
    )
    return {
        "traceId": compute_trace_id("java", source, ""),
        "schemaVersion": "1.0.0",
        "language": "java",
        "languageVersion": "21",
        "createdAt": "2026-10-04T12:00:00Z",
        "source": source,
        "stdin": "",
        "meta": {},
        "steps": [
            {
                "storage": "keyframe",
                "step": 0,
                "snapshot": {
                    "step": 0,
                    "event": "line",
                    "line": 1,
                    "frame": {"method": "main", "class": "Main"},
                    "stack": [
                        {
                            "method": "main",
                            "class": "Main",
                            "line": 1,
                            "locals": {},
                        }
                    ],
                    "stackTruncated": 0,
                    "statics": {},
                    "heap": {},
                    "stdout": "",
                    "stderr": "",
                    "changed": [],
                    "explanation": "Started main; no variables changed yet.",
                    "error": None,
                },
            }
        ],
        "annotations": [],
        "end": {"status": "ok", "diagnostics": []},
    }


class TraceContractTests(unittest.TestCase):
    def test_sample_validates_against_json_schema_and_pydantic(self) -> None:
        schema = json.loads(
            (ROOT / "schemas" / "trace-v1.schema.json").read_text(encoding="utf-8")
        )
        Draft202012Validator.check_schema(schema)
        sample = sample_document()
        Draft202012Validator(schema).validate(sample)
        parsed = TraceDocument.model_validate(sample)
        self.assertEqual(parsed.trace_id, sample["traceId"])
        with self.assertRaises(ValidationError):
            parsed.schema_version = "2.0.0"
        with self.assertRaises(TypeError):
            parsed.meta["mutable"] = True
        with self.assertRaises(TypeError):
            parsed.steps[0].snapshot.stack[0].locals["mutable"] = {
                "kind": "prim",
                "type": "int",
                "value": 1,
            }
        with self.assertRaises(AttributeError):
            parsed.steps[0].snapshot.changed.append("mutable")
        parsed.model_dump(mode="json")

    def test_runner_job_validates_against_json_schema_and_pydantic(self) -> None:
        schema = json.loads(
            (ROOT / "schemas" / "trace-v1.schema.json").read_text(encoding="utf-8")
        )
        runner_job = {
            "schemaVersion": "1.0.0",
            "language": "java",
            "code": "public class Main {}",
            "stdin": "",
            "limits": {
                "maxSteps": 2000,
                "totalTimeoutMs": 10000,
                "compileTimeoutMs": 3000,
                "traceTimeoutMs": 7000,
                "maxOutputBytes": 10000,
                "maxStdinBytes": 5000,
                "maxCodeBytes": 20000,
            },
        }
        runner_schema = {
            "$schema": schema["$schema"],
            "$defs": schema["$defs"],
            "$ref": "#/$defs/RunnerJob",
        }
        Draft202012Validator(runner_schema).validate(runner_job)
        parsed = RunnerJob.model_validate(runner_job)
        self.assertEqual(parsed.language, "java")

    def test_exported_json_schema_matches_openapi(self) -> None:
        schema = json.loads(
            (ROOT / "schemas" / "trace-v1.schema.json").read_text(encoding="utf-8")
        )
        self.assertEqual(schema, export_schema())

    def test_trace_id_is_stable_and_changes_with_input(self) -> None:
        sample_source = (
            "public class Main { public static void main(String[] args) { "
            "System.out.println(1); } }"
        )
        first = compute_trace_id("java", sample_source, "")
        second = compute_trace_id("java", sample_source, "")
        changed_code = compute_trace_id("java", "class B {}", "")
        changed_stdin = compute_trace_id("java", "class A {}", "input")
        self.assertEqual(first, second)
        self.assertEqual(first, SAMPLE_TRACE_ID)
        self.assertNotEqual(first, changed_code)
        self.assertNotEqual(first, changed_stdin)

    def test_v1_extension_defaults_are_inert(self) -> None:
        flags = FeatureFlags()
        self.assertFalse(flags.share_links)
        self.assertFalse(flags.compare)
        self.assertFalse(flags.ai_explain)
        self.assertEqual(AnalyzerPipeline().run(TraceDocument.model_validate(sample_document())), [])
        self.assertIsNone(NoOpTraceStore().get("0" * 64))

    def test_registry_contains_only_java(self) -> None:
        self.assertEqual([item.id for item in language_adapters.descriptors()], ["java"])
        self.assertIsNone(language_adapters.get("python"))

    def test_trace_id_rejects_ambiguous_unseparated_inputs(self) -> None:
        self.assertNotEqual(
            compute_trace_id("java", "ab", "c"),
            compute_trace_id("java", "a", "bc"),
        )


if __name__ == "__main__":
    unittest.main()