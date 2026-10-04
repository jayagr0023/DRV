import { Link } from 'wouter';
import {
  Braces, Check, ChevronLeft, ChevronRight, CircleHelp, Code2, Cpu,
  Database, FileCode2, Layers3, Moon, Play, Sun, Terminal, Workflow,
} from 'lucide-react';
import type { ThemeChoice } from '@/App';

function ThemeControls({ theme, setTheme }: { theme: ThemeChoice; setTheme: (theme: ThemeChoice) => void }) {
  return <div className="theme-switch" role="group" aria-label="Color theme">
    {([
      ['light', Sun, 'Light'],
      ['dark', Moon, 'Dark'],
      ['system', Cpu, 'System'],
    ] as const).map(([value, Icon, label]) => <button key={value} type="button" aria-pressed={theme === value} onClick={() => setTheme(value)} aria-label={`${label} theme`}><Icon size={14} /><span>{label}</span></button>)}
  </div>;
}

function SampleBoard({ mode, caption, mobile = false }: { mode: 'light' | 'dark'; caption: string; mobile?: boolean }) {
  const rows = [
    { name: 'n', value: '2', mark: 'changed' },
    { name: 'total', value: '3', mark: 'unchanged' },
  ];
  const frames = ['sumTo() · n = 0', 'sumTo() · n = 1', 'sumTo() · n = 2'];

  return (
    <section>
      <div className="design-caption"><span>{caption}</span><span className="pill">Sample trace · design only</span></div>
      <div className={`design-frame ${mobile ? 'mobile-frame' : ''} ${mode === 'dark' ? 'dark' : ''}`} data-testid={`sample-layout-${caption.toLowerCase().replaceAll(' ', '-')}`}>
        <div className="workspace">
          <div className="intro-row">
            <div><div className="eyebrow">Learn by stepping through</div><h2 className="page-title">See what Java is doing.</h2><p className="lede">Follow the exact execution, one event at a time.</p></div>
            <div className="health-pill"><span className="health-dot" />Sample service ready</div>
          </div>
          <div className="workspace-grid">
            <section>
              <div className="panel-head" style={{ paddingLeft: 3 }}><div><h3 className="panel-title"><FileCode2 size={16} /> Your program</h3><div className="panel-kicker">Java · sample source</div></div><span className="pill">.java</span></div>
              <div className="code-panel">
                <div className="code-top"><span className="code-badge"><span className="code-dot" /> Sum.java</span><span>Java source</span></div>
                <div className="editor-wrap">
                  <div className="line-numbers">1{'\n'}2{'\n'}3{'\n'}4</div>
                  <pre className="code-editor" style={{ margin: 0, whiteSpace: 'pre', overflow: 'auto' }}><span style={{ color: '#c7a8ff' }}>static int</span> sumTo(<span style={{ color: '#c7a8ff' }}>int</span> n) {'{'}{'\n'}    <span style={{ color: '#c7a8ff' }}>if</span> (n == 0) <span style={{ color: '#c7a8ff' }}>return</span> 0;{'\n'}    <span style={{ color: '#c7a8ff' }}>return</span> n + sumTo(n - 1);{'\n'}{'}'}</pre>
                </div>
                <div className="editor-foot"><span>Sample source — not executed</span><span>4 lines</span></div>
              </div>
              <div className="stdin-wrap"><span className="field-label">Standard input (optional)</span><div className="stdin-input mono" style={{ minHeight: 42 }}>No input for this example</div></div>
              <div className="form-actions"><span className="subtle-note">Example panel state<br />not from the trace API</span><button type="button" className="primary-button" disabled><Play size={14} fill="currentColor" />Sample run</button></div>
            </section>

            <div className="results-column">
              <section className="panel explain-panel">
                <div className="panel-head"><div><h3 className="panel-title"><CircleHelp size={16} /> What just happened?</h3><div className="panel-kicker">Explanation · sample trace</div></div><span className="semantic-tag call"><span aria-hidden="true">●</span>call</span></div>
                <div className="explain-body">The call <span className="mono">sumTo(1)</span> has returned 1. Now this frame adds its own <span className="mono">n</span> value (2), giving 3. The result travels back to the caller.<div className="trace-meta"><span>Step 7</span><span>·</span><span>Line 3</span><span>·</span><span>1 changed value</span></div></div>
              </section>
              <section className="panel">
                <div className="panel-head"><div><h3 className="panel-title"><Workflow size={16} /> Execution steps</h3><div className="panel-kicker">Stored events · illustrative sample</div></div><span className="pill">8 steps</span></div>
                <div className="trace-list" role="list" aria-label="Sample trace steps">
                  {[5, 6, 7, 8].map((number, index) => <button key={number} className="trace-step" type="button" disabled aria-current={index === 2} aria-label={`Sample step ${number}, ${index === 2 ? 'return' : 'line'}`}><b>{String(number).padStart(2, '0')}</b><small>{index === 2 ? 'return · keyframe' : `line · ${index === 1 ? 'delta' : 'keyframe'}`}</small></button>)}
                </div>
                <div className="trace-status"><Check size={14} color="#268a6c" /><span>Sample trace ended: <strong>ok</strong></span></div>
              </section>
              <div className="lower-grid">
                <section className="panel compact-panel">
                  <div className="panel-head"><div><h3 className="panel-title"><Braces size={16} /> Variables</h3><div className="panel-kicker">Selected keyframe · sample</div></div></div>
                  <div className="panel-content">{rows.map((row) => <div className="data-row" key={row.name}><span className="data-key">{row.name}</span><span className="data-value">{row.value}<span className="semantic-tag line" style={{ marginLeft: 8 }}>{row.mark}</span></span></div>)}</div>
                </section>
                <section className="panel compact-panel">
                  <div className="panel-head"><div><h3 className="panel-title"><Layers3 size={16} /> Call stack</h3><div className="panel-kicker">Recursive frames · sample</div></div></div>
                  <div className="panel-content">{frames.map((frame, index) => <div className="data-row" key={frame}><span className="data-key">#{3 - index}</span><span className="data-value">{frame}</span></div>)}</div>
                </section>
                <section className="panel compact-panel">
                  <div className="panel-head"><div><h3 className="panel-title"><Database size={16} /> Heap</h3><div className="panel-kicker">Objects · sample state</div></div></div>
                  <div className="panel-content"><div className="data-row"><span className="data-key">empty</span><span className="data-value">No heap objects in sample</span></div></div>
                </section>
                <section className="panel compact-panel">
                  <div className="panel-head"><div><h3 className="panel-title"><Terminal size={16} /> Program output</h3><div className="panel-kicker">Sample output</div></div></div>
                  <div className="panel-content"><pre className="output-pre">3{'\n'}Process finished</pre></div>
                </section>
              </div>
            </div>
          </div>
        </div>
        <div className="dock" style={{ position: 'static', borderRadius: 0 }} role="group" aria-label="Sample playback controls">
          <div className="dock-inner">
            <button type="button" className="dock-button" aria-label="Previous sample step" disabled><ChevronLeft size={18} /></button>
            <button type="button" className="dock-button play" aria-label="Play sample trace"><Play size={17} fill="currentColor" /></button>
            <button type="button" className="dock-button" aria-label="Next sample step" disabled><ChevronRight size={18} /></button>
            <span className="dock-position">7 / 8</span><span className="speed-control">Speed&nbsp; 1×</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function DesignReview({ theme, setTheme }: { theme: ThemeChoice; setTheme: (theme: ThemeChoice) => void }) {
  return (
    <main>
      <header className="topbar">
        <Link href="/" className="brand"><span className="brand-mark"><Workflow size={19} /></span><span>dryrun<span className="brand-sub"> / visualizer</span></span></Link>
        <div className="header-actions"><Link href="/" className="link-subtle">Back to workspace</Link><ThemeControls theme={theme} setTheme={setTheme} /></div>
      </header>
      <div className="design-page">
        <div className="intro-row">
          <div><div className="eyebrow">Visual system · v1</div><h1 className="page-title">Design review</h1><p className="lede">A complete panel inventory, rendered with representative trace fixtures for visual review only.</p></div>
          <span className="health-pill"><Code2 size={14} /> Java-only learning workspace</span>
        </div>
        <div className="sample-banner" role="note"><Code2 size={16} /><span><strong>Sample trace data — design review only.</strong> These example values are illustrative fixtures and were not returned by the API. The student workspace never shows fabricated execution output.</span></div>
        <div className="design-boards">
          <SampleBoard mode="light" caption="Light desktop" />
          <SampleBoard mode="dark" caption="Dark desktop" />
          <SampleBoard mode="light" caption="Mobile layout" mobile />
        </div>
        <p className="subtle-note" style={{ textAlign: 'center', marginTop: 25 }}>All panels shown: Java editor, explanation, step timeline, variables, recursive call stack, heap, stdout, trace status, and fixed playback controls.</p>
      </div>
    </main>
  );
}