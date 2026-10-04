"""Registry-driven language adapters for runner configuration."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol

from .contracts import (
    LanguageAdapterDescriptor,
    TraceDiagnostic,
    TraceLimits,
)


class LanguageAdapter(Protocol):
    id: str
    display_name: str
    version: str
    runner_image: str
    file_extension: str
    starter_template: str
    examples: tuple
    limits: TraceLimits

    def validate(self, code: str) -> list[TraceDiagnostic]: ...

    def descriptor(self) -> LanguageAdapterDescriptor: ...


JAVA_STARTER_TEMPLATE = """public class Main {
    public static void main(String[] args) {
        int total = 0;
        for (int i = 1; i <= 3; i++) {
            total += i;
        }
        System.out.println(total);
    }
}
"""


def default_java_limits() -> TraceLimits:
    return TraceLimits(
        max_steps=2_000,
        total_timeout_ms=10_000,
        compile_timeout_ms=3_000,
        trace_timeout_ms=7_000,
        max_output_bytes=10_000,
        max_stdin_bytes=5_000,
        max_code_bytes=20_000,
    )


@dataclass(frozen=True)
class JavaLanguageAdapter:
    id: str = "java"
    display_name: str = "Java"
    version: str = "21"
    runner_image: str = "dryrun-java:21"
    file_extension: str = ".java"
    starter_template: str = JAVA_STARTER_TEMPLATE
    examples: tuple = ()
    limits: TraceLimits = field(default_factory=default_java_limits)

    def validate(self, code: str) -> list[TraceDiagnostic]:
        if len(code.encode("utf-8")) <= self.limits.max_code_bytes:
            return []
        return [
            TraceDiagnostic(
                line=None,
                column=None,
                message=f"Code exceeds the {self.limits.max_code_bytes}-byte limit.",
                severity="error",
            )
        ]

    def descriptor(self) -> LanguageAdapterDescriptor:
        return LanguageAdapterDescriptor(
            id=self.id,
            display_name=self.display_name,
            version=self.version,
            file_extension=self.file_extension,
            starter_template=self.starter_template,
            examples=list(self.examples),
            limits=self.limits,
        )


class LanguageAdapterRegistry:
    def __init__(self, adapters: tuple[LanguageAdapter, ...]) -> None:
        self._adapters = {adapter.id: adapter for adapter in adapters}
        if len(self._adapters) != len(adapters):
            raise ValueError("language adapter IDs must be unique")

    def get(self, language_id: str) -> LanguageAdapter | None:
        return self._adapters.get(language_id)

    def descriptors(self) -> list[LanguageAdapterDescriptor]:
        return [adapter.descriptor() for adapter in self._adapters.values()]


language_adapters = LanguageAdapterRegistry((JavaLanguageAdapter(),))