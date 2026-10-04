"""Extension seams for trace storage, explanations, analyzers, and flags."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Protocol

from .contracts import TraceAnnotation, TraceDocument, TraceStep


class TraceStore(Protocol):
    def put(self, document: TraceDocument) -> None: ...

    def get(self, trace_id: str) -> TraceDocument | None: ...


class NoOpTraceStore:
    """The v1 store intentionally retains no traces."""

    def put(self, document: TraceDocument) -> None:
        return None

    def get(self, trace_id: str) -> TraceDocument | None:
        return None


class Explainer(Protocol):
    def explain(
        self,
        step: TraceStep,
        prev_step: TraceStep | None,
        source_model: object,
    ) -> str: ...


class ExplainerRegistry:
    def __init__(self) -> None:
        self._factories: dict[str, Callable[[], Explainer]] = {}

    def register(self, name: str, factory: Callable[[], Explainer]) -> None:
        if name in self._factories:
            raise ValueError(f"explainer already registered: {name}")
        self._factories[name] = factory

    def create(self, name: str) -> Explainer:
        try:
            return self._factories[name]()
        except KeyError as error:
            raise KeyError(f"unknown explainer: {name}") from error


class TraceAnalyzer(Protocol):
    def analyze(self, document: TraceDocument) -> list[TraceAnnotation]: ...


class AnalyzerPipeline:
    def __init__(self, analyzers: Sequence[TraceAnalyzer] = ()) -> None:
        self._analyzers = tuple(analyzers)

    def run(self, document: TraceDocument) -> list[TraceAnnotation]:
        annotations: list[TraceAnnotation] = []
        for analyzer in self._analyzers:
            annotations.extend(analyzer.analyze(document))
        return annotations


empty_analyzer_pipeline = AnalyzerPipeline()