"""Pydantic models mirroring the versioned OpenAPI trace contract."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

SCHEMA_VERSION = "1.0.0"


class FrozenDict(dict):
    """JSON-serializable mapping that rejects normal mutation operations."""

    def _immutable(self, *args: Any, **kwargs: Any) -> None:
        raise TypeError("Trace contract data is immutable")

    __setitem__ = _immutable
    __delitem__ = _immutable
    clear = _immutable
    pop = _immutable
    popitem = _immutable
    setdefault = _immutable
    update = _immutable
    __ior__ = _immutable


def _deep_freeze(value: Any) -> Any:
    if isinstance(value, dict):
        return FrozenDict({key: _deep_freeze(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_deep_freeze(item) for item in value)
    if isinstance(value, tuple):
        return tuple(_deep_freeze(item) for item in value)
    if isinstance(value, set):
        return frozenset(_deep_freeze(item) for item in value)
    return value


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )

    def model_post_init(self, context: Any) -> None:
        for name, value in self.__dict__.items():
            object.__setattr__(self, name, _deep_freeze(value))


class TraceRequest(ContractModel):
    schema_version: Literal["1.0.0"]
    language: str = Field(min_length=1, max_length=32)
    code: str = Field(max_length=20_000)
    stdin: str = Field(max_length=5_000)


class TraceLimits(ContractModel):
    max_steps: int = Field(ge=1)
    total_timeout_ms: int = Field(ge=1)
    compile_timeout_ms: int = Field(ge=1)
    trace_timeout_ms: int = Field(ge=1)
    max_output_bytes: int = Field(ge=1)
    max_stdin_bytes: int = Field(ge=0)
    max_code_bytes: int = Field(ge=1)


class RunnerJob(ContractModel):
    schema_version: Literal["1.0.0"]
    language: str = Field(min_length=1, max_length=32)
    code: str = Field(max_length=20_000)
    stdin: str = Field(max_length=5_000)
    limits: TraceLimits


class PrimitiveValueRef(ContractModel):
    kind: Literal["prim"]
    type: str
    value: StrictStr | StrictInt | StrictFloat | StrictBool


class ObjectValueRef(ContractModel):
    kind: Literal["ref"]
    id: str = Field(pattern=r"^o[1-9][0-9]*$")


class NullValueRef(ContractModel):
    kind: Literal["null"]


class UninitializedValueRef(ContractModel):
    kind: Literal["uninitialized"]


ValueRef: TypeAlias = Annotated[
    PrimitiveValueRef | ObjectValueRef | NullValueRef | UninitializedValueRef,
    Field(discriminator="kind"),
]


class HeapEntry(ContractModel):
    key: ValueRef
    value: ValueRef


class HeapObject(ContractModel):
    id: str = Field(pattern=r"^o[1-9][0-9]*$")
    type: str
    kind: Literal["array", "list", "map", "set", "string", "object", "boxed"]
    elements: tuple[ValueRef, ...] | None = None
    entries: tuple[HeapEntry, ...] | None = None
    fields: dict[str, ValueRef] | None = None
    size: int = Field(ge=0)
    truncated: bool | None = None

    @model_validator(mode="after")
    def validate_payload_shape(self) -> HeapObject:
        payloads = {
            "elements": self.elements,
            "entries": self.entries,
            "fields": self.fields,
        }
        present = [name for name, value in payloads.items() if value is not None]
        if len(present) != 1:
            raise ValueError("exactly one of elements, entries, or fields is required")

        expected = {
            "array": "elements",
            "list": "elements",
            "map": "entries",
            "set": "elements",
            "string": "elements",
            "object": "fields",
            "boxed": "fields",
        }[self.kind]
        if present[0] != expected:
            raise ValueError(f"{self.kind} heap objects require {expected}")
        return self


class StackFrame(ContractModel):
    method: str
    class_name: str = Field(alias="class")
    line: int | None
    locals: dict[str, ValueRef]


class TraceFrameRef(ContractModel):
    method: str
    class_name: str = Field(alias="class")


class TraceError(ContractModel):
    type: str
    message: str
    line: int | None
    stack_trace: tuple[str, ...]


class TraceDiagnostic(ContractModel):
    line: int | None
    column: int | None
    message: str
    severity: Literal["error", "warning", "info"]


class TraceStep(ContractModel):
    step: int = Field(ge=0)
    event: Literal["line", "call", "return", "exception", "exit"]
    line: int | None
    frame: TraceFrameRef
    stack: tuple[StackFrame, ...] = Field(max_length=50)
    stack_truncated: int = Field(ge=0)
    statics: dict[str, ValueRef]
    heap: dict[str, HeapObject] = Field(max_length=500)
    stdout: str
    stderr: str
    changed: tuple[str, ...]
    explanation: str = Field(min_length=1)
    error: TraceError | None


class JsonPatchOperation(ContractModel):
    op: Literal["add", "remove", "replace"]
    path: str = Field(pattern=r"^/(stack|statics|heap)(/.*)?$")
    value: Any = None

    @model_validator(mode="after")
    def validate_value_presence(self) -> JsonPatchOperation:
        has_value = "value" in self.model_fields_set
        if self.op in ("add", "replace") and not has_value:
            raise ValueError(f"{self.op} operations require value")
        if self.op == "remove" and has_value:
            raise ValueError("remove operations must not include value")
        return self


class KeyframeStep(ContractModel):
    storage: Literal["keyframe"]
    step: int = Field(ge=0)
    snapshot: TraceStep

    @model_validator(mode="after")
    def validate_snapshot_step(self) -> KeyframeStep:
        if self.snapshot.step != self.step:
            raise ValueError("keyframe step must match snapshot.step")
        return self


class DeltaStep(ContractModel):
    storage: Literal["delta"]
    step: int = Field(ge=0)
    event: Literal["line", "call", "return", "exception", "exit"]
    line: int | None
    frame: TraceFrameRef
    stack_truncated: int = Field(ge=0)
    patch: tuple[JsonPatchOperation, ...]
    stdout: str
    stderr: str
    changed: tuple[str, ...]
    explanation: str = Field(min_length=1)
    error: TraceError | None


StoredTraceStep: TypeAlias = Annotated[
    KeyframeStep | DeltaStep,
    Field(discriminator="storage"),
]


class TraceAnnotation(ContractModel):
    step_index: int = Field(ge=0)
    severity: Literal["info", "warning", "error"]
    code: str
    message: str


class TraceEnd(ContractModel):
    status: Literal["ok", "compile_error", "runtime_error", "truncated", "timeout"]
    diagnostics: tuple[TraceDiagnostic, ...]


class TraceDocument(ContractModel):
    trace_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    schema_version: Literal["1.0.0"]
    language: str
    language_version: str
    created_at: datetime
    source: str
    stdin: str
    meta: dict[str, Any]
    steps: tuple[StoredTraceStep, ...]
    annotations: tuple[TraceAnnotation, ...]
    end: TraceEnd

    @model_validator(mode="after")
    def validate_trace_identity_and_keyframes(self) -> TraceDocument:
        expected_id = compute_trace_id(
            language=self.language,
            code=self.source,
            stdin=self.stdin,
            schema_version=self.schema_version,
        )
        if self.trace_id != expected_id:
            raise ValueError("traceId does not match the trace input")

        for index, stored_step in enumerate(self.steps):
            if stored_step.step != index:
                raise ValueError("stored step numbers must be contiguous from zero")
            is_keyframe = isinstance(stored_step, KeyframeStep)
            if index % 50 == 0 and not is_keyframe:
                raise ValueError("a full keyframe is required every 50 steps")
            if index % 50 != 0 and is_keyframe:
                raise ValueError("keyframes are only allowed at steps divisible by 50")
        return self


class TraceMetaLine(ContractModel):
    type: Literal["meta"]
    schema_version: Literal["1.0.0"]
    trace_id: str = Field(pattern=r"^[a-f0-9]{64}$")
    language: str
    language_version: str
    meta: dict[str, Any]


class TraceStepLine(ContractModel):
    type: Literal["step"]
    schema_version: Literal["1.0.0"]
    data: StoredTraceStep


class TraceEndLine(ContractModel):
    type: Literal["end"]
    schema_version: Literal["1.0.0"]
    end: TraceEnd


NDJSONLine: TypeAlias = Annotated[
    TraceMetaLine | TraceStepLine | TraceEndLine,
    Field(discriminator="type"),
]


class LanguageExample(ContractModel):
    id: str
    title: str
    description: str
    code: str
    stdin: str


class LanguageAdapterDescriptor(ContractModel):
    id: str
    display_name: str
    version: str
    file_extension: str
    starter_template: str
    examples: tuple[LanguageExample, ...]
    limits: TraceLimits


class FeatureFlags(ContractModel):
    share_links: bool = False
    compare: bool = False
    ai_explain: bool = False


def compute_trace_id(
    language: str,
    code: str,
    stdin: str,
    schema_version: str = SCHEMA_VERSION,
) -> str:
    """Hash a length-prefixed UTF-8 tuple so inputs cannot collide at boundaries."""
    import hashlib

    parts = (
        language.encode("utf-8"),
        code.encode("utf-8"),
        stdin.encode("utf-8"),
        schema_version.encode("utf-8"),
    )
    digest = hashlib.sha256()
    for part in parts:
        digest.update(len(part).to_bytes(8, byteorder="big"))
        digest.update(part)
    return digest.hexdigest()