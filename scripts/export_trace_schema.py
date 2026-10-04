"""Export the trace-v1 JSON Schema from the OpenAPI contract."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import yaml


ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "lib" / "api-spec" / "openapi.yaml"
SCHEMA_PATH = ROOT / "schemas" / "trace-v1.schema.json"


def rewrite_schema_refs(value: Any) -> Any:
    if isinstance(value, dict):
        rewritten: dict[str, Any] = {}
        for key, child in value.items():
            if key == "discriminator":
                continue
            rewritten[key] = rewrite_schema_refs(child)
        return rewritten
    if isinstance(value, list):
        return [rewrite_schema_refs(item) for item in value]
    if isinstance(value, str):
        return re.sub(
            r"#/components/schemas/([^/]+)",
            r"#/$defs/\1",
            value,
        )
    return value


def export_schema() -> dict[str, Any]:
    openapi = yaml.safe_load(OPENAPI_PATH.read_text(encoding="utf-8"))
    definitions = openapi["components"]["schemas"]
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://dryrun-visualizer.local/schemas/trace-v1.schema.json",
        "title": "DryRun Visualizer TraceDocument v1",
        "$ref": "#/$defs/TraceDocument",
        "$defs": rewrite_schema_refs(definitions),
    }
    return schema


def main() -> None:
    SCHEMA_PATH.parent.mkdir(parents=True, exist_ok=True)
    SCHEMA_PATH.write_text(
        json.dumps(export_schema(), indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {SCHEMA_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()