import { useMemo } from 'react';
import type { StackFrame, TraceStep } from '@workspace/api-client-react';
import { CornerDownRight, GitBranch, RotateCcw } from 'lucide-react';

export interface CallTreeNode {
  id: string;
  parentId: string | null;
  frame: StackFrame;
  firstStep: number;
  lastStep: number;
  endedAt: number | null;
  children: CallTreeNode[];
}

function sameCall(left: StackFrame, right: StackFrame): boolean {
  return left.class === right.class && left.method === right.method;
}

export function buildCallTree(steps: TraceStep[], throughIndex: number): CallTreeNode[] {
  const roots: CallTreeNode[] = [];
  let active: CallTreeNode[] = [];
  let nextId = 1;

  steps.slice(0, throughIndex + 1).forEach((step) => {
    const frames = step.stack;
    let shared = 0;
    while (shared < active.length && shared < frames.length && sameCall(active[shared].frame, frames[shared])) {
      shared++;
    }
    for (let index = shared; index < active.length; index++) {
      active[index].endedAt = step.step;
    }
    active = active.slice(0, shared);

    for (let index = shared; index < frames.length; index++) {
      const node: CallTreeNode = {
        id: `call-${nextId++}`,
        parentId: active.at(-1)?.id ?? null,
        frame: frames[index],
        firstStep: step.step,
        lastStep: step.step,
        endedAt: null,
        children: [],
      };
      const parent = active.at(-1);
      if (parent) parent.children.push(node);
      else roots.push(node);
      active.push(node);
    }
    active.forEach((node, index) => {
      node.frame = frames[index];
      node.lastStep = step.step;
    });
  });
  return roots;
}

function localSummary(frame: StackFrame): string {
  const entries = Object.entries(frame.locals).slice(0, 3);
  return entries.map(([name, value]) => {
    if (value.kind === 'prim') return `${name}=${String(value.value)}`;
    if (value.kind === null) return `${name}=null`;
    if (value.kind === 'uninitialized') return `${name}=…`;
    return `${name}→${value.id}`;
  }).join(' · ');
}

function returnSummary(step: TraceStep): string {
  if (step.event !== 'return') return '';
  const value = step.returnValue;
  if (!value) return 'void (no value)';
  if (value.kind === 'prim') return `${value.type} ${String(value.value)}`;
  if (value.kind === null) return 'null';
  if (value.kind === 'uninitialized') return 'uninitialized';
  const type = step.heap[value.id]?.type ?? 'object';
  return `${type} @${value.id}`;
}

function CallNode({ node, currentPath, activeIndex, onSelect }: {
  node: CallTreeNode;
  currentPath: Set<string>;
  activeIndex: number;
  onSelect: (stepIndex: number) => void;
}) {
  const active = currentPath.has(node.id);
  const now = active && !node.children.some((child) => currentPath.has(child.id)) && node.frame.line !== null;
  return <li className={`call-tree-node${now ? ' is-current' : ''}${active ? ' is-active' : ''}${node.endedAt !== null && node.endedAt <= activeIndex ? ' is-ended' : ''}`}>
    <div className="call-tree-entry">
      <button type="button" className="call-tree-jump" onClick={() => onSelect(node.firstStep)} title={`Jump to the first observed frame at event ${node.firstStep + 1}`}>
        <span className="call-tree-marker">{active ? now ? 'NOW' : 'ACTIVE' : node.endedAt !== null && node.endedAt <= activeIndex ? 'INACTIVE' : 'CALL'}</span>
        <span className="call-tree-method">{node.frame.method}()<small>{node.frame.class}{node.frame.line === null ? '' : ` · line ${node.frame.line}`}</small></span>
      </button>
      {localSummary(node.frame) && <span className="call-tree-locals">{localSummary(node.frame)}</span>}
      {node.endedAt !== null && node.endedAt <= activeIndex && <button type="button" className="call-tree-return" onClick={() => onSelect(node.endedAt!)} title={`Jump to event ${node.endedAt + 1}, where this frame was no longer active`}><RotateCcw size={12} /> inactive at {node.endedAt + 1}</button>}
    </div>
    {node.children.length > 0 && <ul>{node.children.map((child) =>
      <CallNode key={child.id} node={child} currentPath={currentPath} activeIndex={activeIndex} onSelect={onSelect} />)}</ul>}
  </li>;
}

export function RecursionTree({ steps, activeIndex, onSelect }: {
  steps: TraceStep[];
  activeIndex: number;
  onSelect: (stepIndex: number) => void;
}) {
  const roots = useMemo(() => buildCallTree(steps, activeIndex), [steps, activeIndex]);
  const step = steps[activeIndex];
  const activePath = new Set<string>();
  function markActivePath(nodes: CallTreeNode[]): string | null {
    const current = nodes.find((node) => node.lastStep === activeIndex
      && (node.endedAt === null || node.endedAt > activeIndex));
    if (!current) return null;
    activePath.add(current.id);
    return markActivePath(current.children) ?? current.id;
  }
  markActivePath(roots);
  const frameCount = Math.max(0, ...steps.slice(0, activeIndex + 1).map((step) => step.stack.length + step.stackTruncated));
  if (frameCount < 2 && step?.event !== 'return') return null;

  return <section className="runtime-subpanel recursion-panel" aria-labelledby="recursion-heading">
    <div className="runtime-subhead"><h3 id="recursion-heading"><GitBranch size={15} /> Observed call tree</h3><span>max depth {frameCount}</span></div>
    <p className="runtime-muted">Frames and return values are captured from JVM debug events.</p>
    {step?.event === 'return' && <p className="runtime-return-value"><RotateCcw size={13} /> {step.frame.class}.{step.frame.method}() returned <strong>{returnSummary(step)}</strong></p>}
    {roots.length ? <ul className="call-tree" aria-label="Observed method call tree" tabIndex={0}>{roots.map((node) =>
      <CallNode key={node.id} node={node} currentPath={activePath} activeIndex={activeIndex} onSelect={onSelect} />)}</ul> : <p className="runtime-muted"><CornerDownRight size={12} /> No call frames were captured at this event.</p>}
  </section>;
}
