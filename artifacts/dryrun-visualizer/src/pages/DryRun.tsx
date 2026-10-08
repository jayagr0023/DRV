import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import CodeMirror from '@uiw/react-codemirror';
import { java } from '@codemirror/lang-java';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import {
  AlertCircle, ArrowDown, Braces, Check, ChevronLeft, ChevronRight, CircleHelp,
  Cpu, Database, FileCode2, Layers3, Moon, Play, RotateCcw, SkipForward, Sun, Terminal, Upload,
  Workflow, Zap,
} from 'lucide-react';
import {
  getGetDryRunHealthQueryKey, getHealthCheckQueryKey, getListLanguagesQueryKey,
  useCreateTrace, useGetDryRunHealth, useHealthCheck, useListLanguages,
} from '@workspace/api-client-react';
import type {
  HeapObject, TraceDiagnostic, TraceEnd,
  TraceAnnotation, TraceStep, ValueRef,
} from '@workspace/api-client-react';
import type { ThemeChoice } from '@/App';
import { RuntimeVisualizer } from '@/components/RuntimeVisualizer';
import { consumeTraceResponse, stdoutThroughStep } from '@/lib/trace-response';
import { useWorkspace } from '@/state/workspace';

const setActiveLine = StateEffect.define<number>();
const activeLineField = StateField.define({
  create: () => Decoration.none,
  update(decorations, transaction) {
    decorations = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setActiveLine)) {
        const line = effect.value;
        decorations = line > 0 && line <= transaction.state.doc.lines
          ? Decoration.set([Decoration.line({ class: 'cm-trace-active-line' }).range(transaction.state.doc.line(line).from)])
          : Decoration.none;
      }
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatValue(value: ValueRef | unknown): string {
  if (!record(value)) return String(value ?? '—');
  if (value.kind === 'prim') return `${String(value.type ?? '')} ${String(value.value)}`.trim();
  if (value.kind === 'ref') return `ref → ${String(value.id)}`;
  if (value.kind === null) return 'null';
  if (value.kind === 'uninitialized') return 'not initialized';
  return JSON.stringify(value);
}

function ValueDisplay({ value, heap }: { value: ValueRef | unknown; heap?: Record<string, HeapObject> }) {
  if (record(value) && value.kind === 'ref' && typeof value.id === 'string') {
    const object = heap?.[value.id];
    if (object) {
      return <a className="heap-reference-link" href={`#heap-object-${object.id}`} title={`Jump to ${object.type}`} onClick={(event) => {
        event.preventDefault();
        const target = window.document.getElementById(`heap-object-${object.id}`);
        if (target instanceof HTMLDetailsElement) target.open = true;
        target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }}>
        ref → {object.id} <span>{object.type}</span>
      </a>;
    }
  }
  return formatValue(value);
}

function Header({ theme, setTheme }: { theme: ThemeChoice; setTheme: (theme: ThemeChoice) => void }) {
  return <header className="topbar">
    <Link href="/" className="brand" aria-label="DryRun Visualizer home"><span className="brand-mark"><Workflow size={18} /></span><span>dryrun<span className="brand-sub"> / execution lab</span></span></Link>
    <div className="header-actions">
      <div className="theme-switch" role="group" aria-label="Color theme">
        {([['light', Sun, 'Light'], ['dark', Moon, 'Dark'], ['system', Cpu, 'System']] as const).map(([value, Icon, label]) =>
          <button key={value} type="button" onClick={() => setTheme(value)} aria-pressed={theme === value} aria-label={`${label} theme`} data-testid={`theme-${value}`}><Icon size={14} /><span>{label}</span></button>)}
      </div>
    </div>
  </header>;
}

function Empty({ icon: Icon, children }: { icon: typeof CircleHelp; children: string }) {
  return <div className="empty-panel"><Icon size={15} aria-hidden="true" /><span>{children}</span></div>;
}

function ValueRows({ values, heap }: { values: Record<string, ValueRef>; heap?: Record<string, HeapObject> }) {
  const entries = Object.entries(values);
  return entries.length ? <div>{entries.map(([name, value]) =>
    <div className="data-row" key={name}><span className="data-key">{name}</span><span className="data-value"><ValueDisplay value={value} heap={heap} /></span></div>)}</div> : <Empty icon={Braces}>No values are recorded in this section.</Empty>;
}

function Inspector({ step, stdout }: { step: TraceStep | null; stdout: string }) {
  const frame = step?.stack.at(-1);
  const locals = frame?.locals ?? {};
  const showLocals = Object.keys(locals).length > 0;
  const showStack = Boolean(step?.stack.length);
  const showStatics = Boolean(step && Object.keys(step.statics).length);
  const showHeap = Boolean(step && Object.values(step.heap).some((object) => object.type !== 'java.lang.String[]'));
  const showStdout = Boolean(stdout);
  const showStderr = Boolean(step?.stderr || step?.error);

  if (!step) return <div className="lower-grid inspector-empty-state"><Empty icon={Braces}>Run a trace to reveal the state used by the current execution step.</Empty></div>;

  return <div className="lower-grid">
    {showLocals && <section className="panel compact-panel inspector-panel inspector-locals panel-active" aria-labelledby="locals-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="locals-heading"><Braces size={16} /> Locals</h2><div className="panel-kicker">Current frame · {frame ? `${frame.class}.${frame.method}` : 'awaiting state'}</div></div></div>
      <div className="panel-content" role="region" aria-label="Current-frame local values" tabIndex={0}><ValueRows values={locals} heap={step.heap} /></div>
    </section>}
    {showStack && <section className="panel compact-panel inspector-panel inspector-stack panel-active" aria-labelledby="stack-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="stack-heading"><Layers3 size={16} /> Call stack</h2><div className="panel-kicker">Active method calls</div></div>{step?.stackTruncated ? <span className="pill">+{step.stackTruncated} hidden</span> : null}</div>
      <div className="panel-content" role="region" aria-label="Active call stack frames" tabIndex={0}>{[...step.stack].reverse().map((item, index) =>
        <div className="data-row" key={`${item.class}.${item.method}-${index}`}><span className="data-key">#{step.stack.length - index}</span><span className="data-value">{item.class}.{item.method}()<small className="row-detail">{item.line === null ? 'source line unavailable' : `line ${item.line}`}</small></span></div>)}</div>
    </section>}
    {showStatics && <section className="panel compact-panel inspector-panel inspector-statics panel-active" aria-labelledby="statics-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="statics-heading"><Zap size={16} /> Static fields</h2><div className="panel-kicker">Class-level state</div></div></div>
      <div className="panel-content" role="region" aria-label="Captured static fields" tabIndex={0}><ValueRows values={step.statics} heap={step.heap} /></div>
    </section>}
    {showHeap && <section className="panel compact-panel inspector-panel inspector-heap panel-active" aria-labelledby="heap-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="heap-heading"><Database size={16} /> Heap</h2><div className="panel-kicker">Objects and references</div></div></div>
      <div className="panel-content" role="region" aria-label="Captured heap objects" tabIndex={0}>{Object.values(step.heap).filter((object) => object.type !== 'java.lang.String[]').map((object: HeapObject) =>
        <details className="heap-object" id={`heap-object-${object.id}`} key={object.id}><summary><span className="mono">{object.id}</span><span>{object.type}</span><span className="pill">{object.size}</span></summary>
          {object.truncated && <small className="row-detail">Object detail is truncated by the trace service.</small>}
          {object.fields && Object.entries(object.fields).map(([key, value]) => <div className="data-row" key={key}><span className="data-key">{key}</span><span className="data-value"><ValueDisplay value={value} heap={step.heap} /></span></div>)}
          {object.elements?.map((value, index) => <div className="data-row" key={index}><span className="data-key">[{index}]</span><span className="data-value"><ValueDisplay value={value} heap={step.heap} /></span></div>)}
          {object.entries?.map((entry, index) => <div className="data-row" key={index}><span className="data-key"><ValueDisplay value={entry.key} heap={step.heap} /></span><span className="data-value"><ValueDisplay value={entry.value} heap={step.heap} /></span></div>)}
          {!object.fields && !object.elements && !object.entries && <small className="row-detail">No member detail was included.</small>}
        </details>)}</div>
    </section>}
    {showStdout && <section className="panel compact-panel output-panel inspector-panel inspector-stdout panel-active" aria-labelledby="output-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="output-heading"><Terminal size={16} /> Program output</h2><div className="panel-kicker">Accumulated through this event</div></div></div>
      <div className="panel-content"><pre className="output-pre">{stdout}</pre></div>
    </section>}
    {showStderr && <section className="panel compact-panel output-panel inspector-panel inspector-stderr panel-active" aria-labelledby="stderr-heading">
      <div className="panel-head"><div><h2 className="panel-title" id="stderr-heading"><AlertCircle size={16} /> Standard error</h2><div className="panel-kicker">Errors reported at this event</div></div></div>
      <div className="panel-content"><pre className="output-pre stderr-output">{step.stderr || step.error?.message}</pre></div>
    </section>}
  </div>;
}

function errorStatus(error: unknown): number | undefined {
  if (record(error) && typeof error.status === 'number') return error.status;
  if (error instanceof Error) return Number(error.message.match(/\b(503|502|501)\b/u)?.[0]) || undefined;
  return undefined;
}

export default function DryRun({ theme, setTheme }: { theme: ThemeChoice; setTheme: (theme: ThemeChoice) => void }) {
  const healthz = useHealthCheck({ query: { queryKey: getHealthCheckQueryKey() } });
  const health = useGetDryRunHealth({ query: { queryKey: getGetDryRunHealthQueryKey() } });
  const languages = useListLanguages({ query: { queryKey: getListLanguagesQueryKey() } });
  const createTrace = useCreateTrace({ request: { headers: { Accept: 'application/x-ndjson' } } });
  const code = useWorkspace((state) => state.code);
  const stdin = useWorkspace((state) => state.stdin);
  const activeIndex = useWorkspace((state) => state.activeIndex);
  const playing = useWorkspace((state) => state.playing);
  const speed = useWorkspace((state) => state.speed);
  const setCode = useWorkspace((state) => state.setCode);
  const setStdin = useWorkspace((state) => state.setStdin);
  const setActiveIndex = useWorkspace((state) => state.setActiveIndex);
  const setPlaying = useWorkspace((state) => state.setPlaying);
  const setSpeed = useWorkspace((state) => state.setSpeed);
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [end, setEnd] = useState<TraceEnd | null>(null);
  const [diagnostics, setDiagnostics] = useState<TraceDiagnostic[]>([]);
  const [annotations, setAnnotations] = useState<TraceAnnotation[]>([]);
  const [partial, setPartial] = useState(false);
  const [requestError, setRequestError] = useState('');
  const [sourceName, setSourceName] = useState('Main.java');
  const [uploadError, setUploadError] = useState('');
  const [runnerUnavailable, setRunnerUnavailable] = useState(false);
  const [readingTrace, setReadingTrace] = useState(false);
  const view = useRef<EditorView | null>(null);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const language = languages.data?.languages?.find((item) => item.id.toLowerCase() === 'java' || item.displayName.toLowerCase() === 'java');
  const selected = steps[activeIndex] ?? null;
  const visibleStdout = useMemo(() => stdoutThroughStep(steps, activeIndex), [steps, activeIndex]);
  const sourceLine = selected?.line ?? null;
  const codeSizeBytes = useMemo(() => new TextEncoder().encode(code).byteLength, [code]);
  const usesStdin = /\b(?:System\.in|Scanner|readLine\s*\(|next(?:Line|Int|Double|Float|Long|Boolean|Byte|Short)\s*\()/u.test(code) || Boolean(stdin.trim());
  const canRun = Boolean(language && !languages.isLoading && !languages.isError && !createTrace.isPending && !readingTrace && code.trim() && codeSizeBytes <= 20000 && stdin.length <= 5000);
  const extensions = useMemo(() => [java(), activeLineField, EditorView.lineWrapping], []);

  async function uploadSource(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    setUploadError('');
    if (!file.name.toLowerCase().endsWith('.java')) {
      setUploadError('Choose a Java source file with a .java extension.');
      return;
    }
    if (file.size > 20000) {
      setUploadError('Source file exceeds the trace service limit of 20,000 bytes.');
      return;
    }

    try {
      const source = (await file.text()).replace(/^\uFEFF/u, '');
      if (new TextEncoder().encode(source).byteLength > 20000) {
        setUploadError('Source file exceeds the trace service limit of 20,000 bytes.');
        return;
      }
      setCode(source);
      setSourceName(file.name);
    } catch {
      setUploadError('The selected Java source file could not be read.');
    }
  }

  const move = useCallback((index: number) => {
    setActiveIndex(Math.max(0, Math.min(steps.length - 1, index)));
    setPlaying(false);
  }, [setActiveIndex, setPlaying, steps.length]);

  useEffect(() => {
    if (!view.current) return;
    if (sourceLine && sourceLine <= view.current.state.doc.lines) {
      const position = view.current.state.doc.line(sourceLine).from;
      view.current.dispatch({ effects: setActiveLine.of(sourceLine) });
      const lineBlock = view.current.lineBlockAt(position);
      const editorScroller = view.current.scrollDOM;
      if (lineBlock.top < editorScroller.scrollTop || lineBlock.top + lineBlock.height > editorScroller.scrollTop + editorScroller.clientHeight) {
        editorScroller.scrollTop = Math.max(0, lineBlock.top - (editorScroller.clientHeight - lineBlock.height) / 2);
      }
    } else {
      view.current.dispatch({ effects: setActiveLine.of(0) });
    }
  }, [sourceLine, code]);

  useEffect(() => {
    if (!playing || steps.length < 1) return;
    const timer = window.setInterval(() => {
      const next = useWorkspace.getState().activeIndex + 1;
      if (next >= steps.length) setPlaying(false);
      else setActiveIndex(next);
    }, Math.max(240, 900 / speed));
    return () => window.clearInterval(timer);
  }, [playing, setActiveIndex, setPlaying, speed, steps.length]);

  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input,textarea,select,[contenteditable="true"],.cm-content')) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(activeIndex - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(activeIndex + 1); }
      if (event.code === 'Space' && steps.length) { event.preventDefault(); setPlaying(!useWorkspace.getState().playing); }
      if (event.key === 'Home' && steps.length) move(0);
      if (event.key === 'End' && steps.length) move(steps.length - 1);
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [activeIndex, move, setPlaying, steps.length]);

  async function runTrace() {
    if (!canRun || !language) return;
    const latestWorkspace = useWorkspace.getState();
    const requestCode = latestWorkspace.code;
    const requestStdin = latestWorkspace.stdin;
    if (!requestCode.trim() || new TextEncoder().encode(requestCode).byteLength > 20000 || requestStdin.length > 5000) return;
    setRequestError('');
    setRunnerUnavailable(false);
    setSteps([]);
    setEnd(null);
    setDiagnostics([]);
    setAnnotations([]);
    setPartial(false);
    setActiveIndex(0);
    setPlaying(false);
    setReadingTrace(true);
    try {
      const response = await createTrace.mutateAsync({ data: { schemaVersion: '1.0.0', language: language.id, code: requestCode, stdin: requestStdin } });
      if (!response.ok) {
        if (response.status === 503) setRunnerUnavailable(true);
        throw new Error(response.status === 503 ? 'Runner unavailable. Your code was not executed.' : `Trace request failed with HTTP ${response.status}.`);
      }
      const finalPayload = await consumeTraceResponse(response, (payload) => {
        setSteps(payload.steps);
        setEnd(payload.end);
        setDiagnostics(payload.diagnostics);
        setAnnotations(payload.annotations);
        setPartial(payload.partial);
      });
      setSteps(finalPayload.steps);
      setEnd(finalPayload.end);
      setDiagnostics(finalPayload.diagnostics);
      setAnnotations(finalPayload.annotations);
      setPartial(finalPayload.partial);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 503) setRunnerUnavailable(true);
      setRequestError(error instanceof Error ? error.message : 'The trace request could not be completed.');
    } finally {
      setReadingTrace(false);
    }
  }

  const traceHealth = health.data?.status ?? healthz.data?.status;

  return <div className="app-shell">
    <Header theme={theme} setTheme={setTheme} />
    <main className="workspace">
      <div className="intro-row">
        <div><div className="eyebrow">Java execution</div><h1 className="page-title">Make every state visible.</h1><p className="lede">Run your code, then step through what actually happened.</p></div>
        <div className="health-stack">
          <div className="health-pill" role="status" data-testid="status-api-health"><span className={`health-dot${traceHealth === 'ok' ? '' : ' warn'}`} />{health.isLoading && healthz.isLoading ? 'Checking trace services' : traceHealth === 'ok' ? 'API responding' : traceHealth === 'degraded' ? 'API degraded' : 'Service status unavailable'}</div>
        </div>
      </div>
      {health.isError && healthz.isError && <div className="error-banner" role="alert">Health checks could not reach the API. You can still edit, but no execution data is available. <button type="button" className="retry-link" onClick={() => { void health.refetch(); void healthz.refetch(); }}>Retry health checks</button></div>}
      {languages.isError && <div className="error-banner" role="alert">Language registry could not be loaded. Java availability is unknown; tracing remains disabled until the registry responds. <button type="button" className="retry-link" onClick={() => { void languages.refetch(); }}>Retry language registry</button></div>}
      {!languages.isLoading && !languages.isError && !language && <div className="runner-banner" role="status"><span className="runner-mark"><AlertCircle size={18} /></span><div><strong>Java runner not available</strong><p>The live language registry does not advertise Java. Run is disabled; source remains editable. Code will not be sent to a service that cannot execute it.</p></div><span className="registry-tag">REGISTRY · {languages.data?.languages?.length ?? 0} LANGUAGES</span></div>}
      {runnerUnavailable && <div className="error-banner" role="alert">The server reported that an isolated Java runner is unavailable. Your code was not executed. No trace has been generated.</div>}

      <div className="workspace-grid">
        <section aria-labelledby="editor-heading">
          <div className="editor-heading"><div><span className="section-index">01</span><div><h2 className="panel-title" id="editor-heading"><FileCode2 size={17} /> Source file</h2><div className="panel-kicker">Java · edit your program and standard input</div></div></div><div className="source-file-actions"><input ref={uploadInput} className="source-file-input" type="file" accept=".java,text/x-java-source,text/plain" onChange={uploadSource} aria-label="Choose a Java source file" /><button className="file-upload-button" type="button" onClick={() => uploadInput.current?.click()}><Upload size={14} /> Upload .java</button><span className="file-chip" title={sourceName}>{sourceName}</span></div></div>
          <div className="code-panel">
            <div className="code-top"><span className="code-badge"><span className="code-dot" /> Main.java</span><span>JAVA SOURCE <span className="code-lang-dot" /></span></div>
            <CodeMirror value={code} height="360px" extensions={extensions} onChange={(value) => { setCode(value); setUploadError(''); }} onCreateEditor={(editor) => { view.current = editor; }} basicSetup={{ foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false }} aria-label="Java source code" data-testid="input-java-code" />
            <div className="editor-foot"><span>Source</span><span>{codeSizeBytes.toLocaleString()} / 20,000 bytes</span></div>
          </div>
          {uploadError && <div className="error-banner" role="alert" data-testid="error-source-upload">{uploadError}</div>}
          {usesStdin && <div className="stdin-wrap"><label htmlFor="stdin" className="field-label">Standard input</label><p className="input-help" id="stdin-help">Enter all input before running. It is sent to System.in when the program starts; separate values with spaces or new lines.</p><textarea id="stdin" className="stdin-input" value={stdin} onChange={(event) => setStdin(event.target.value)} rows={3} maxLength={5000} placeholder={'5\n1 2 3 4 5\n2\n1 3\n2 5'} aria-describedby="stdin-help" data-testid="input-stdin" /><div className="field-foot">{stdin.length.toLocaleString()} / 5,000</div></div>}
          <div className="form-actions"><button className="primary-button" type="button" onClick={runTrace} disabled={!canRun} data-testid="button-run-trace">{createTrace.isPending ? 'Requesting trace…' : readingTrace ? 'Receiving trace…' : <><Play size={15} fill="currentColor" /> Visualize</>}</button></div>
          {codeSizeBytes > 20000 && <div className="error-banner" role="alert">Source exceeds the trace service limit of 20,000 bytes.</div>}
          {createTrace.isError && <div className="error-banner" role="alert" data-testid="error-trace-request"><AlertCircle size={14} /> {String((createTrace.error as { message?: string } | null)?.message || 'The trace request failed. The service did not provide execution data.')}</div>}
          {requestError && !createTrace.isError && <div className="error-banner" role="alert" data-testid="error-trace-response">{requestError}</div>}
        </section>

        <div className="results-column" aria-label="Captured state inspection">
          {end && <div className={`trace-status final-status final-status-${end.status}`} role="status" data-testid="status-trace-end"><Check size={14} /><span>Trace complete: <strong>{end.status.replaceAll('_', ' ')}</strong></span><span>· {diagnostics.length} diagnostics</span></div>}
          {partial && !readingTrace && <div className="trace-status partial-status" role="status"><AlertCircle size={14} /><span>Partial trace · end record not received</span></div>}
          {diagnostics.map((item, index) => <div className={`diagnostic diagnostic-${item.severity}`} key={`diagnostic-${item.line ?? 'unknown'}-${item.column ?? 'unknown'}-${index}`} role={item.severity === 'error' ? 'alert' : 'status'}><span className="diagnostic-code">{item.column === null ? 'Diagnostic' : `Column ${item.column}`}</span><span>{item.line === null ? '' : `Line ${item.line} · `}{item.message}</span></div>)}
          {annotations.filter((annotation) => annotation.stepIndex === activeIndex).map((annotation, index) => <div className={`diagnostic diagnostic-${annotation.severity}`} key={`${annotation.code}-${index}`} role={annotation.severity === 'error' ? 'alert' : 'status'}><span className="diagnostic-code">{annotation.code}</span><span>Event {annotation.stepIndex + 1} · {annotation.message}</span></div>)}
          {selected?.error && <div className="diagnostic diagnostic-error" role="alert"><strong>{selected.error.type}</strong><span>{selected.error.message}{selected.error.line === null ? '' : ` · line ${selected.error.line}`}</span></div>}
          <Inspector step={selected} stdout={visibleStdout} />
        </div>
      </div>
      <RuntimeVisualizer
        step={selected}
        previous={activeIndex > 0 ? steps[activeIndex - 1] ?? null : null}
        steps={steps}
        activeIndex={activeIndex}
        onSelect={move}
        code={code}
      />
    </main>
    <div className="dock" role="group" aria-label="Trace playback controls">
      <div className="dock-inner"><span className="dock-hint">STEP THROUGH <kbd>←</kbd><kbd>→</kbd></span>
        <button className="dock-button" type="button" aria-label="Previous event" disabled={!steps.length || activeIndex === 0} onClick={() => move(activeIndex - 1)} data-testid="button-previous"><ChevronLeft size={18} /></button>
        <button className="dock-button play" type="button" aria-label={playing ? 'Pause trace' : 'Play trace'} disabled={!steps.length} onClick={() => setPlaying(!playing)} data-testid="button-play-pause">{playing ? <span aria-hidden="true">Ⅱ</span> : <Play size={17} fill="currentColor" />}</button>
        <button className="dock-button" type="button" aria-label="Next event" disabled={!steps.length || activeIndex >= steps.length - 1} onClick={() => move(activeIndex + 1)} data-testid="button-next"><ChevronRight size={18} /></button>
        <span className="dock-position" aria-live="polite" data-testid="text-current-position">{steps.length ? `${activeIndex + 1} / ${steps.length}` : '— / —'}</span>
        <label className="speed-control"><span>PACE</span><select aria-label="Playback speed" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} data-testid="select-playback-speed"><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option></select></label>
        <button className="dock-button dock-first" type="button" aria-label="Jump to first event" disabled={!steps.length || activeIndex === 0} onClick={() => move(0)} data-testid="button-first"><RotateCcw size={16} /></button>
        <button className="dock-button dock-last" type="button" aria-label="Jump to last event" disabled={!steps.length || activeIndex >= steps.length - 1} onClick={() => move(steps.length - 1)} data-testid="button-last"><SkipForward size={16} /></button>
        <span className="dock-line">{sourceLine ? <><ArrowDown size={13} /> source line {sourceLine}</> : 'source line —'}</span>
      </div>
    </div>
  </div>;
}