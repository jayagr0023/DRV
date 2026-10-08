import type { HeapObject, TraceStep, ValueRef } from '@workspace/api-client-react';
import { Braces, Database, Layers3, Link2, Network } from 'lucide-react';
import { RecursionTree } from '@/components/ExecutionNarrative';

type Heap = TraceStep['heap'];

function isReference(value: ValueRef | undefined): value is { kind: 'ref'; id: string } {
  return value?.kind === 'ref';
}

function primitiveNumber(value: ValueRef | undefined): number | null {
  if (value?.kind !== 'prim' || typeof value.value !== 'number') return null;
  return value.value;
}

export function inferSourceArrayAccesses(code: string, line: number | null, step: TraceStep): Map<string, Set<number>> {
  const accesses = new Map<string, Set<number>>();
  if (line === null) return accesses;
  const masked = code.replace(/\r\n?/gu, '\n').replace(
    /"""[\s\S]*?"""|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu,
    (match) => match.replace(/[^\r\n]/gu, ' '),
  );
  const source = masked.split('\n')[line - 1] ?? '';
  const locals = step.stack.at(-1)?.locals ?? {};
  const identifier = '[A-Za-z_$][A-Za-z0-9_$]*';

  for (const [name, value] of Object.entries(locals)) {
    if (!isReference(value)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const expression = new RegExp(`(?<![A-Za-z0-9_$.])${escaped}\\s*((?:\\[\\s*(?:${identifier}|\\d+)\\s*\\])+)`, 'gu');
    for (const match of source.matchAll(expression)) {
      const indexes = [...match[1].matchAll(/\[\s*([A-Za-z_$][A-Za-z0-9_$]*|\d+)\s*\]/gu)].map((item) => item[1]);
      let target: HeapObject | undefined = step.heap[value.id];
      for (const item of indexes) {
        if (target?.kind !== 'array') break;
        const numericIndex = /^\d+$/u.test(item) ? Number(item) : primitiveNumber(locals[item]);
        if (numericIndex === null || numericIndex < 0 || numericIndex >= (target.elements?.length ?? 0)) break;
        const indexesForObject = accesses.get(target.id) ?? new Set<number>();
        indexesForObject.add(numericIndex);
        accesses.set(target.id, indexesForObject);
        const nested: ValueRef | undefined = target.elements?.[numericIndex];
        target = isReference(nested) ? step.heap[nested.id] : undefined;
      }
    }
  }
  return accesses;
}

function referenceId(value: ValueRef | undefined): string | null {
  return isReference(value) ? value.id : null;
}

export function observedArrayCellChanges(current: TraceStep, previous: TraceStep | null): Array<{
  arrayId: string;
  index: number;
  before: ValueRef;
  after: ValueRef;
}> {
  if (!previous) return [];
  const changes: Array<{ arrayId: string; index: number; before: ValueRef; after: ValueRef }> = [];
  for (const [arrayId, object] of Object.entries(current.heap)) {
    if (object.kind !== 'array') continue;
    const oldObject = previous.heap[arrayId];
    if (oldObject?.kind !== 'array') continue;
    const priorElements = oldObject.elements ?? [];
    const currentElements = object.elements ?? [];
    const commonLength = Math.min(priorElements.length, currentElements.length);
    for (let index = 0; index < commonLength; index++) {
      const before = priorElements[index];
      const after = currentElements[index];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changes.push({ arrayId, index, before, after });
      }
    }
  }
  return changes;
}

export function arrayPathsFromRoots(values: Array<[string, ValueRef]>, heap: Heap): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  const visited = new Set<string>();
  const visit = (arrayId: string, path: string) => {
    const object = heap[arrayId];
    if (object?.kind !== 'array') return;
    paths.set(arrayId, [...(paths.get(arrayId) ?? []), path]);
    if (visited.has(arrayId)) return;
    visited.add(arrayId);
    for (const [index, value] of (object.elements ?? []).entries()) {
      const childId = referenceId(value);
      if (childId && heap[childId]?.kind === 'array') visit(childId, `${path}[${index}]`);
    }
  };

  for (const [name, value] of values) {
    const id = referenceId(value);
    if (id) visit(id, name);
  }
  return paths;
}

export function capturedMatrixRows(object: HeapObject, heap: Heap): Array<{
  rowIndex: number;
  arrayId: string | null;
  values: ValueRef[];
}> | null {
  if (object.kind !== 'array') return null;
  const rowValues = object.elements ?? [];
  const isMatrix = object.type.endsWith('[][]')
    || rowValues.some((value) => {
      const rowId = referenceId(value);
      return rowId !== null && heap[rowId]?.kind === 'array';
    });
  if (!isMatrix) return null;

  return rowValues.map((value, rowIndex) => {
    const rowId = referenceId(value);
    const row = rowId ? heap[rowId] : undefined;
    return {
      rowIndex,
      arrayId: row?.kind === 'array' ? row.id : null,
      values: row?.kind === 'array' ? row.elements ?? [] : [],
    };
  });
}

function label(value: ValueRef | undefined, heap: Heap): string {
  if (!value) return '—';
  if (value.kind === null) return 'null';
  if (value.kind === 'uninitialized') return 'not initialized';
  if (value.kind === 'prim') return String(value.value);
  if (value.kind !== 'ref') return '—';
  const object = heap[value.id];
  if (!object) return `${value.id} · not captured`;
  if (/^java\.lang\.(?:Boolean|Byte|Character|Double|Float|Integer|Long|Short)$/u.test(object.type)
    && object.fields?.value?.kind === 'prim') {
    return String(object.fields.value.value);
  }
  if (object.kind === 'string') {
    const content = object.elements?.[0];
    if (content?.kind === 'prim') return `"${String(content.value)}"`;
  }
  return `${object.type} · ${object.id}`;
}

function getBackingArray(object: HeapObject, heap: Heap): HeapObject | undefined {
  for (const name of ['elementData', 'queue', 'table', 'elements', 'array']) {
    const id = referenceId(object.fields?.[name]);
    const candidate = id ? heap[id] : undefined;
    if (candidate?.kind === 'array') return candidate;
  }
  return undefined;
}

export function sequenceState(object: HeapObject, type: string, heap: Heap): {
  values: ValueRef[];
  size: number;
  capacity: number;
} {
  const backing = type === 'array' ? object : getBackingArray(object, heap);
  const elements = backing?.elements ?? [];
  const capacity = backing?.size ?? elements.length;
  if (type === 'deque') {
    const head = primitiveNumber(object.fields?.head) ?? 0;
    const tail = primitiveNumber(object.fields?.tail) ?? head;
    const size = capacity > 0 ? (tail - head + capacity) % capacity : 0;
    return {
      values: Array.from({ length: size }, (_, index) => elements[(head + index) % capacity]),
      size,
      capacity,
    };
  }
  const size = type === 'stack'
    ? primitiveNumber(object.fields?.elementCount) ?? primitiveNumber(object.fields?.size) ?? object.size
    : type === 'array'
      ? object.size
      : primitiveNumber(object.fields?.size) ?? object.size;
  return { values: elements.slice(0, Math.max(0, size)), size, capacity };
}

export interface CapturedGraph {
  nodes: HeapObject[];
  edges: Array<{ from: string; to: string; via: string; weight: string | null }>;
}

export function capturedGraphChanges(current: CapturedGraph, previous: CapturedGraph | null): {
  newlyObserved: CapturedGraph['edges'];
  noLongerObserved: CapturedGraph['edges'];
} {
  if (!previous) return { newlyObserved: [], noLongerObserved: [] };
  const edgeKey = ({ from, to, via }: CapturedGraph['edges'][number]) => `${from}\u0000${to}\u0000${via}`;
  const currentEdges = new Set(current.edges.map(edgeKey));
  const previousEdges = new Set(previous.edges.map(edgeKey));
  return {
    newlyObserved: current.edges.filter((edge) => !previousEdges.has(edgeKey(edge))),
    noLongerObserved: previous.edges.filter((edge) => !currentEdges.has(edgeKey(edge))),
  };
}

export function capturedGraph(rootIds: string[], heap: Heap): CapturedGraph {
  const nodes = new Map<string, HeapObject>();
  const edges: CapturedGraph['edges'] = [];
  const pending = [...rootIds];
  const visited = new Set<string>();
  const adjacencyNames = /^(?:neighbors?|adj|adjacency|outgoing|edges)$/iu;

  while (pending.length && visited.size < 60) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    const node = heap[id];
    if (!node || !node.fields || node.kind === 'array') continue;
    visited.add(id);
    const adjacencyFields = Object.entries(node.fields).filter(([name]) => adjacencyNames.test(name));
    if (!adjacencyFields.length) continue;

    for (const [fieldName, reference] of adjacencyFields) {
      const target = heap[referenceId(reference) ?? ''];
      const directNode = target && target.kind !== 'array'
        && Object.keys(target.fields ?? {}).some((name) => adjacencyNames.test(name));
      const adjacent = directNode
        ? [reference]
        : target?.kind === 'array'
          ? target.elements ?? []
          : target
            ? sequenceState(target, category(target), heap).values
            : [];
      for (const neighborRef of adjacent) {
        const neighborId = referenceId(neighborRef);
        const neighbor = neighborId ? heap[neighborId] : undefined;
        if (!neighbor || neighbor.kind === 'array' || !neighbor.fields) continue;
        const weight = neighbor.fields.weight;
        const weightLabel = weight
          ? weight.kind === 'prim' ? String(weight.value) : weight.kind === null ? 'null' : null
          : null;
        nodes.set(node.id, node);
        nodes.set(neighbor.id, neighbor);
        edges.push({ from: id, to: neighbor.id, via: fieldName, weight: weightLabel });
        if (!visited.has(neighbor.id)) pending.push(neighbor.id);
      }
    }
  }

  return { nodes: [...nodes.values()], edges };
}

export interface BinaryTreeLayout {
  width: number;
  height: number;
  nodes: Array<{ id: string; x: number; y: number; value: ValueRef }>;
  edges: Array<{ from: string; to: string; via: 'left' | 'right' }>;
}

export function capturedBinaryTree(
  rootIds: string[],
  heap: Heap,
  capturedLinks: Array<{ from: HeapObject; path: string; to: HeapObject }> = [],
): BinaryTreeLayout | null {
  const isTreeNode = (object: HeapObject | undefined): object is HeapObject =>
    Boolean(object?.fields && ('left' in object.fields || 'right' in object.fields));
  const childLinks = new Map<string, Partial<Record<'left' | 'right', string>>>();
  for (const { from, path, to } of capturedLinks) {
    if ((path === 'left' || path === 'right') && isTreeNode(from) && isTreeNode(to)) {
      childLinks.set(from.id, { ...childLinks.get(from.id), [path]: to.id });
    }
  }
  const reachableIds = new Set<string>();
  const pending = [...rootIds];
  while (pending.length && reachableIds.size < 500) {
    const id = pending.shift()!;
    if (reachableIds.has(id)) continue;
    const object = heap[id];
    if (!object) continue;
    reachableIds.add(id);
    for (const value of [
      ...Object.values(object.fields ?? {}),
      ...(object.elements ?? []),
    ]) {
      const childId = referenceId(value);
      if (childId && !reachableIds.has(childId)) pending.push(childId);
    }
  }

  const candidateIds = new Set<string>();
  for (const id of reachableIds) if (isTreeNode(heap[id])) candidateIds.add(id);
  for (const [id, children] of childLinks) {
    candidateIds.add(id);
    if (children.left) candidateIds.add(children.left);
    if (children.right) candidateIds.add(children.right);
  }
  if (!candidateIds.size) return null;

  type Shape = {
    id: string;
    value: ValueRef;
    left: Shape | null;
    right: Shape | null;
    width: number;
  };
  const visited = new Set<string>();
  const build = (id: string, ancestors: Set<string>): Shape | null => {
    const object = heap[id];
    if (!isTreeNode(object) || ancestors.has(id) || visited.has(id) || visited.size >= 500) return null;
    visited.add(id);
    const nextAncestors = new Set(ancestors).add(id);
    const childId = (side: 'left' | 'right') =>
      childLinks.get(id)?.[side] ?? referenceId(object.fields?.[side]);
    const leftId = childId('left');
    const rightId = childId('right');
    const leftObject = leftId ? heap[leftId] : undefined;
    const rightObject = rightId ? heap[rightId] : undefined;
    const left = leftObject ? build(leftObject.id, nextAncestors) : null;
    const right = rightObject ? build(rightObject.id, nextAncestors) : null;
    const childWidth = (left?.width ?? 0) + (right?.width ?? 0);
    const width = left && right ? childWidth + 60 : Math.max(100, childWidth + (left || right ? 100 : 0));
    const value = object.fields?.key
      ?? object.fields?.item
      ?? object.fields?.value
      ?? object.fields?.data
      ?? object.fields?.val
      ?? object.fields?.element
      ?? object.fields?.payload
      ?? { kind: null };
    return { id, value, left, right, width };
  };

  const parentlessRoots = [...candidateIds]
    .filter((id) => ![...candidateIds].some((candidateId) => {
      const object = heap[candidateId];
      const links = childLinks.get(candidateId);
      return (links?.left ?? referenceId(object?.fields?.left)) === id
        || (links?.right ?? referenceId(object?.fields?.right)) === id;
    }));
  const roots = (parentlessRoots.length ? parentlessRoots : [...candidateIds])
    .map((id) => build(id, new Set()))
    .filter((shape): shape is Shape => shape !== null);
  if (!roots.length) return null;

  const nodes: BinaryTreeLayout['nodes'] = [];
  const edges: BinaryTreeLayout['edges'] = [];
  let maxDepth = 0;
  const place = (shape: Shape, offset: number, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    const leftWidth = shape.left?.width ?? 0;
    const rightWidth = shape.right?.width ?? 0;
    const x = shape.left && shape.right
      ? offset + leftWidth + 30
      : shape.left
        ? offset + leftWidth + 50
        : shape.right
          ? offset + 50
          : offset + 50;
    nodes.push({ id: shape.id, x, y: 54 + depth * 104, value: shape.value });
    if (shape.left) {
      edges.push({ from: shape.id, to: shape.left.id, via: 'left' });
      place(shape.left, offset, depth + 1);
    }
    if (shape.right) {
      edges.push({ from: shape.id, to: shape.right.id, via: 'right' });
      place(shape.right, offset + (shape.left ? leftWidth + 60 : 100), depth + 1);
    }
  };
  let rootOffset = 0;
  for (const root of roots) {
    place(root, rootOffset, 0);
    rootOffset += root.width + 80;
  }

  return {
    width: Math.max(320, rootOffset - 80),
    height: Math.max(150, 108 + maxDepth * 104),
    nodes,
    edges,
  };
}

function mapBuckets(object: HeapObject, heap: Heap): Array<{ index: number; entries: Array<{ key: ValueRef; value: ValueRef }> }> {
  let table = getBackingArray(object, heap);
  if (!table && object.fields) {
    for (const value of Object.values(object.fields)) {
      const nested = heap[referenceId(value) ?? ''];
      if (nested && nested !== object) {
        table = getBackingArray(nested, heap);
        if (table) break;
      }
    }
  }
  if (!table?.elements) return [];

  return table.elements.flatMap((head, index) => {
    let nodeId = referenceId(head);
    const entries: Array<{ key: ValueRef; value: ValueRef }> = [];
    const seen = new Set<string>();
    while (nodeId && !seen.has(nodeId)) {
      seen.add(nodeId);
      const node = heap[nodeId];
      if (!node?.fields) break;
      const key = node.fields.key;
      const value = node.fields.value;
      if (key && value) entries.push({ key, value });
      nodeId = referenceId(node.fields.next);
    }
    return entries.length ? [{ index, entries }] : [];
  });
}

function linkedNodes(object: HeapObject, heap: Heap): Array<{ id: string; value: ValueRef; previous: string | null }> {
  let nodeId = referenceId(object.fields?.first);
  const nodes: Array<{ id: string; value: ValueRef; previous: string | null }> = [];
  const seen = new Set<string>();
  let previous: string | null = null;
  while (nodeId && !seen.has(nodeId) && nodes.length < 50) {
    seen.add(nodeId);
    const node = heap[nodeId];
    if (!node?.fields?.item) break;
    nodes.push({ id: nodeId, value: node.fields.item, previous: referenceId(node.fields.prev) });
    previous = nodeId;
    nodeId = referenceId(node.fields.next);
  }
  if (previous && previous !== referenceId(object.fields?.last)) return nodes;
  return nodes;
}

function category(object: HeapObject): 'array' | 'string' | 'list' | 'linked' | 'stack' | 'queue' | 'deque' | 'heap' | 'map' | 'set' | 'tree' | 'object' {
  const name = object.type.split('.').at(-1) ?? object.type;
  if (object.kind === 'array') return 'array';
  if (object.kind === 'string') return 'string';
  if (/^(TreeMap|TreeSet)$/u.test(name) || (object.fields && 'left' in object.fields && 'right' in object.fields)) return 'tree';
  if (/^(HashMap|LinkedHashMap|Hashtable|ConcurrentHashMap)$/u.test(name)) return 'map';
  if (/^(HashSet|LinkedHashSet)$/u.test(name)) return 'set';
  if (name === 'PriorityQueue') return 'heap';
  if (name === 'LinkedList') return 'linked';
  if (name === 'Stack') return 'stack';
  if (name === 'ArrayDeque') return 'deque';
  if (/^(ArrayList|Vector)$/u.test(name)) return 'list';
  return 'object';
}

function ValueChip({ value, heap }: { value: ValueRef | undefined; heap: Heap }) {
  if (isReference(value) && heap[value.id]) {
    return <a className="runtime-ref" href={`#runtime-object-${value.id}`} onClick={(event) => {
      const target = document.getElementById(`runtime-object-${value.id}`) ?? document.getElementById(`heap-object-${value.id}`);
      if (!target) return;
      event.preventDefault();
      if (target instanceof HTMLDetailsElement) target.open = true;
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }}>{label(value, heap)} <Link2 size={12} /></a>;
  }
  return <span className={value?.kind === 'prim' ? 'runtime-primitive' : 'runtime-null'}>{label(value, heap)}</span>;
}

function StructureCard({ object, heap, previous, accesses, nameHints }: {
  object: HeapObject;
  heap: Heap;
  previous: Heap | null;
  accesses: Map<string, Set<number>>;
  nameHints: string[];
}) {
  const type = category(object);
  const previousObject = previous?.[object.id];
  const array = type === 'array' ? object : getBackingArray(object, heap);
  const sequence = sequenceState(object, type, heap);
  const values = sequence.values;
  const size = sequence.size;
  const matrixRows = type === 'array' && object.type.endsWith('[][]')
    ? values.map((value) => heap[referenceId(value) ?? ''] ?? null)
    : [];
  const changedIndexes = new Set<number>();
  if (array && previousObject) {
    const previousArray = type === 'array' ? previousObject : getBackingArray(previousObject, previous ?? {});
    for (let index = 0; index < Math.max(values.length, previousArray?.elements?.length ?? 0); index++) {
      if (JSON.stringify(values[index]) !== JSON.stringify(previousArray?.elements?.[index])) changedIndexes.add(index);
    }
  }
  const buckets = type === 'map' || type === 'set' ? mapBuckets(object, heap) : [];
  const nodes = type === 'linked' ? linkedNodes(object, heap) : [];
  const dpHint = nameHints.some((name) => /\b(?:dp|memo|table)\b/iu.test(name));
  const displayName = {
    array: 'Array', string: 'String', list: 'Dynamic array', linked: 'Linked list',
    stack: 'Stack', queue: 'Queue', deque: 'Deque', heap: 'Priority queue',
    map: 'Hash map buckets', set: 'Set membership', tree: 'Tree links', object: 'Object fields',
  }[type];

  return <article className="runtime-structure" id={`runtime-object-${object.id}`}>
    <div className="runtime-structure-head">
      <div><span className="runtime-type">{object.type}</span><span className="runtime-id">{object.id}</span></div>
      <span className="runtime-kind">{displayName}</span>
    </div>

    {dpHint && (type === 'array' || type === 'list') && <div className="runtime-hint">Table-shaped variable name hint · values and shape are from the trace; DP meaning is not assumed.</div>}

    {matrixRows.some((row) => row?.kind === 'array') && <div className="runtime-matrix" role="grid" aria-label="Two-dimensional array">
      {matrixRows.map((row, rowIndex) => <div className="runtime-matrix-row" role="row" key={row?.id ?? rowIndex}>
        <small>{rowIndex}</small>{row?.elements ? row.elements.map((value, columnIndex) => {
          const oldRow = previous?.[row.id];
          const modified = JSON.stringify(value) !== JSON.stringify(oldRow?.elements?.[columnIndex]);
          const accessed = accesses.get(row.id)?.has(columnIndex) ?? false;
          return <span className={`runtime-cell${modified ? ' is-changed' : ''}${accessed ? ' is-accessed' : ''}`} role="gridcell" key={columnIndex}><ValueChip value={value} heap={heap} /></span>;
        }) : <span className="runtime-null">null row</span>}
      </div>)}
      <small className="runtime-size">{matrixRows.length} rows · captured row lengths (rows may be jagged)</small>
    </div>}

    {!matrixRows.some((row) => row?.kind === 'array') && (type === 'array' || type === 'list' || type === 'stack' || type === 'queue' || type === 'deque' || type === 'heap') && array && (
      <div className={`runtime-sequence runtime-sequence-${type}`} aria-label={`${displayName}, ${size} items`}>
        {(type === 'queue' || type === 'deque') && <span className="runtime-end-label">{type === 'deque' ? 'FRONT ⇄' : 'FRONT →'}</span>}
        {(type === 'stack') && <span className="runtime-end-label">TOP ↓</span>}
        {(type === 'stack' ? values.slice(0, size).reverse() : values.slice(0, size)).map((value, index) => <div className="runtime-cell-wrap" key={index}>
          {type === 'array' && <small>{index}</small>}
          {type === 'heap' && <small>#{index}</small>}
          <div className={`runtime-cell${changedIndexes.has(index) ? ' is-changed' : ''}${accesses.get(array.id)?.has(index) ? ' is-accessed' : ''}`}><ValueChip value={value} heap={heap} /></div>
        </div>)}
        {(type === 'queue' || type === 'deque') && <span className="runtime-end-label">{type === 'deque' ? '⇄ REAR' : '← REAR'}</span>}
        {type === 'heap' && values.length > 0 && <div className="runtime-heap-tree">
          {Array.from({ length: Math.ceil(Math.log2(size + 1)) }, (_, level) => {
            const start = 2 ** level - 1;
            return <div className="runtime-heap-level" key={level}>{values.slice(start, Math.min(start + 2 ** level, size)).map((value, offset) =>
              <span className="runtime-heap-node" key={start + offset}>{label(value, heap)}</span>)}</div>;
          })}
        </div>}
        <small className="runtime-size">size {size}{['list', 'stack', 'queue', 'deque', 'heap'].includes(type) ? ` · capacity ${sequence.capacity}` : ''}{object.truncated || array.truncated ? ' · trace truncated' : ''}</small>
      </div>
    )}

    {type === 'string' && <div className="runtime-string"><ValueChip value={object.elements?.[0]} heap={heap} /></div>}

    {(type === 'map' || type === 'set') && (buckets.length ? <div className="runtime-buckets">
      {buckets.map((bucket) => <div className="runtime-bucket" key={bucket.index}>
        <span>bucket {bucket.index}</span>
        <div>{bucket.entries.map((entry, index) => <span className="runtime-entry" key={index}>
          {type === 'map' ? <><ValueChip value={entry.key} heap={heap} /><span className="runtime-arrow">→</span><ValueChip value={entry.value} heap={heap} /></> : <ValueChip value={entry.key} heap={heap} />}
        </span>)}</div>
      </div>)}
      <small className="runtime-size">{type === 'set' ? 'Membership from captured backing map' : `${buckets.reduce((sum, bucket) => sum + bucket.entries.length, 0)} captured entries`}</small>
    </div> : <p className="runtime-muted">Bucket details were not present in this trace; showing captured fields below.</p>)}

    {type === 'linked' && nodes.length > 0 && <div className="runtime-linked-chain">
      <span>HEAD ↓</span>{nodes.map((node, index) => <span className="runtime-linked-node" key={node.id}><small>NODE {node.id} · prev {node.previous ?? 'null'}</small><ValueChip value={node.value} heap={heap} />{index < nodes.length - 1 ? ' → ' : ''}</span>)}<span> → null</span>
      <small>TAIL · {referenceId(object.fields?.last) ?? 'not captured'}</small>
    </div>}

    {type === 'tree' && <div className="runtime-fields"><span className="runtime-muted">Tree links and values come from captured fields; traversal state is not inferred.</span>
      {object.fields && Object.entries(object.fields).map(([name, value]) =>
        <div className="runtime-field" key={name}><span>{name}</span><ValueChip value={value} heap={heap} /></div>)}
    </div>}

    {(type === 'object' || (type === 'linked' && nodes.length === 0) || (type === 'map' && buckets.length === 0) || (type === 'set' && buckets.length === 0) || (type !== 'array' && !array && type !== 'string' && type !== 'tree')) && (
      <div className="runtime-fields">{object.fields && Object.entries(object.fields).length ? Object.entries(object.fields).map(([name, value]) =>
        <div className="runtime-field" key={name}><span>{name}</span><ValueChip value={value} heap={heap} /></div>) : <span className="runtime-muted">{object.truncated ? 'Fields were truncated in the trace.' : 'No fields were captured.'}</span>}</div>
    )}
  </article>;
}

function referenceEdges(rootIds: string[], heap: Heap): Array<{ from: HeapObject; path: string; to: HeapObject }> {
  const pending = [...rootIds];
  const visited = new Set<string>();
  const edges: Array<{ from: HeapObject; path: string; to: HeapObject }> = [];
  while (pending.length && visited.size < 60 && edges.length < 120) {
    const id = pending.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const object = heap[id];
    if (!object) continue;

    const references: Array<{ path: string; value: ValueRef }> = [
      ...Object.entries(object.fields ?? {}).map(([name, value]) => ({ path: name, value })),
      ...(object.elements ?? []).map((value, index) => ({ path: `[${index}]`, value })),
      ...(object.entries ?? []).flatMap((entry, index) => [
        { path: `entry ${index} key`, value: entry.key },
        { path: `entry ${index} value`, value: entry.value },
      ]),
    ];
    for (const { path, value } of references) {
      const targetId = referenceId(value);
      if (!targetId) continue;
      const target = heap[targetId];
      if (!target) continue;
      edges.push({ from: object, path, to: target });
      if (!visited.has(targetId)) pending.push(targetId);
    }
  }
  return edges;
}

export function RuntimeVisualizer({ step, previous, steps, activeIndex, onSelect, code }: {
  step: TraceStep | null;
  previous: TraceStep | null;
  steps: TraceStep[];
  activeIndex: number;
  onSelect: (stepIndex: number) => void;
  code: string;
}) {
  if (!step) return <section className="panel runtime-workbench"><div className="runtime-empty"><Database size={18} /><span>Run a Java program to inspect arrays, collections, objects, and references from its actual trace.</span></div></section>;

  const roots: Array<{ name: string; object: HeapObject }> = [];
  const seenRoots = new Set<string>();
  const values: Array<[string, ValueRef]> = [
    ...step.stack.flatMap((frame) => Object.entries(frame.locals).map(([name, value]) => [`${frame.method}.${name}`, value] as [string, ValueRef])),
    ...Object.entries(step.statics),
  ];
  for (const [name, value] of values) {
    const id = referenceId(value);
    const object = id ? step.heap[id] : undefined;
    if (object && !seenRoots.has(id!)) {
      roots.push({ name, object });
      seenRoots.add(id!);
    }
  }
  const structures = roots.map(({ object }) => object);
  const namesById = new Map<string, string[]>();
  for (const { name, object } of roots) {
    namesById.set(object.id, [...(namesById.get(object.id) ?? []), name]);
  }
  const accesses = inferSourceArrayAccesses(code, step.line, step);
  const arrayCellChanges = observedArrayCellChanges(step, previous);
  const arrayPaths = arrayPathsFromRoots(values, step.heap);
  const edges = referenceEdges(structures.map((object) => object.id), step.heap);
  const binaryTree = capturedBinaryTree(structures.map((object) => object.id), step.heap, edges);
  const graphNodes = [...new Map(edges.flatMap(({ from, to }) => [[from.id, from], [to.id, to]])).values()];
  const graph = capturedGraph(structures.map((object) => object.id), step.heap);
  const previousGraph = previous
    ? capturedGraph(
      [
        ...previous.stack.flatMap((frame) => Object.values(frame.locals)),
        ...Object.values(previous.statics),
      ].map(referenceId).filter((id): id is string => id !== null),
      previous.heap,
    )
    : null;
  const graphChanges = capturedGraphChanges(graph, previousGraph);
  const newlyObservedEdges = new Set(graphChanges.newlyObserved.map(({ from, to, via }) => `${from}\u0000${to}\u0000${via}`));
  const graphWidth = 720;
  const graphHeight = Math.max(220, Math.ceil(graph.nodes.length / 5) * 145);
  const topologyPositions = new Map(graph.nodes.map((object, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, graph.nodes.length) - Math.PI / 2;
    return [object.id, {
      x: graphWidth / 2 + Math.cos(angle) * Math.max(100, graphWidth * 0.38),
      y: graphHeight / 2 + Math.sin(angle) * Math.max(70, graphHeight * 0.38),
    }];
  }));
  const referenceHeight = Math.max(220, Math.ceil(graphNodes.length / 5) * 145);
  const referencePositions = new Map(graphNodes.map((object, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, graphNodes.length) - Math.PI / 2;
    return [object.id, {
      x: graphWidth / 2 + Math.cos(angle) * Math.max(100, graphWidth * 0.38),
      y: referenceHeight / 2 + Math.sin(angle) * Math.max(70, referenceHeight * 0.38),
    }];
  }));
  const currentLocals = step.stack.at(-1)?.locals ?? {};
  const activeNodeIds = new Set(Object.values(currentLocals).map(referenceId).filter((id): id is string => id !== null));
  const tableRoots = roots.filter(({ name, object }) =>
    /\b(?:dp|memo|table)\b/iu.test(name) && object.kind === 'array');
  const output = step.stdout;

  return <section className="panel runtime-workbench has-step" aria-labelledby="runtime-workbench-heading">
    <div className="runtime-workbench-head">
      <div><span className="section-index">04</span><div><h2 className="panel-title" id="runtime-workbench-heading"><Network size={17} /> Runtime visualization</h2><div className="panel-kicker">Derived only from objects and values captured at this event</div></div></div>
      <span className="runtime-count">{structures.length} root object{structures.length === 1 ? '' : 's'} · {Object.keys(step.heap).length} captured</span>
    </div>
    <div className="runtime-workbench-content" role="region" aria-label="Captured runtime details" tabIndex={0}>
    <section className="runtime-subpanel runtime-stack-roots" aria-labelledby="references-heading">
      <div className="runtime-subhead"><h3 id="references-heading"><Braces size={15} /> Stack roots</h3><span>{values.length}</span></div>
      {values.length ? <div className="runtime-root-list">{values.map(([name, value], index) =>
        <div className="runtime-root" key={`${name}-${index}`}><code>{name}</code><ValueChip value={value} heap={step.heap} /></div>)}</div> : <p className="runtime-muted">No captured references in locals or static fields.</p>}
    </section>
    <RecursionTree steps={steps} activeIndex={activeIndex} onSelect={onSelect} />
    {arrayCellChanges.length > 0 && <section className="runtime-subpanel runtime-array-changes" aria-labelledby="array-changes-heading">
      <div className="runtime-subhead"><h3 id="array-changes-heading"><Layers3 size={15} /> Observed array cell changes</h3><span>{arrayCellChanges.length}</span></div>
      <p className="runtime-muted">These values differ from the immediately previous snapshot. The active source line is not necessarily the cause of the change.</p>
      <div className="runtime-change-list">{arrayCellChanges.slice(0, 12).map(({ arrayId, index, before, after }) => {
        const path = arrayPaths.get(arrayId)?.[0] ?? arrayId;
        return <div className="runtime-change" key={`${arrayId}-${index}`}>
          <code>{path}[{index}]</code>
          <span>{label(before, previous?.heap ?? {})}</span><b>→</b><strong>{label(after, step.heap)}</strong>
        </div>;
      })}{arrayCellChanges.length > 12 && <small className="runtime-muted">and {arrayCellChanges.length - 12} more changed cells</small>}</div>
    </section>}
    {tableRoots.length > 0 && <section className="runtime-subpanel runtime-table-panel" aria-labelledby="array-table-heading">
      <div className="runtime-subhead"><h3 id="array-table-heading"><Braces size={15} /> Table-shaped arrays</h3><span>Name is a hint, not a DP claim</span></div>
      <p className="runtime-muted">Indexes, values, changes, and current-line accesses come from captured array state. Dependencies and algorithm meaning are not inferred.</p>
      {tableRoots.map(({ name, object }) => {
        const values = object.elements ?? [];
        const oldObject = previous?.heap[object.id];
        const matrixRows = capturedMatrixRows(object, step.heap);
        if (matrixRows) {
          const columnCount = Math.max(0, ...matrixRows.map((row) => row.values.length));
          return <div className="runtime-table" key={object.id}>
            <div className="runtime-table-title"><code>{name}</code><span>{object.type} · {matrixRows.length} captured rows × {columnCount} max captured columns{object.truncated ? ' · truncated' : ''}</span></div>
            <div className="runtime-matrix-grid">
              <div className="runtime-matrix-row runtime-matrix-header"><span className="runtime-table-cell runtime-table-index">row / col</span>
                {Array.from({ length: columnCount }, (_, columnIndex) =>
                  <span className="runtime-table-cell runtime-table-index" key={columnIndex}>{columnIndex}</span>)}
              </div>
              {matrixRows.map(({ rowIndex, arrayId, values: rowValues }) => {
                const oldRow = arrayId ? previous?.heap[arrayId] : undefined;
                return <div className="runtime-matrix-row" key={rowIndex}>
                  <span className="runtime-table-cell runtime-table-index">{rowIndex}</span>
                  {rowValues.map((value, columnIndex) => {
                    const modified = oldRow?.kind === 'array'
                      && JSON.stringify(oldRow.elements?.[columnIndex]) !== JSON.stringify(value);
                    const accessed = arrayId ? accesses.get(arrayId)?.has(columnIndex) ?? false : false;
                    return <span className={`runtime-table-cell${modified ? ' is-changed' : ''}${accessed ? ' is-accessed' : ''}`} key={columnIndex}>
                      <ValueChip value={value} heap={step.heap} />
                    </span>;
                  })}
                  {arrayId === null && <span className="runtime-matrix-unavailable">Row value unavailable or not captured</span>}
                </div>;
              })}
            </div>
          </div>;
        }
        return <div className="runtime-table" key={object.id}>
          <div className="runtime-table-title"><code>{name}</code><span>{object.type} · {object.size} cells{object.truncated ? ' · truncated' : ''}</span></div>
          <div className="runtime-table-row"><span className="runtime-table-axis">index</span>{values.map((value, index) =>
            <span className="runtime-table-cell runtime-table-index" key={index}>{index}</span>)}</div>
          <div className="runtime-table-row"><span className="runtime-table-axis">value</span>{values.map((value, index) => {
            const modified = JSON.stringify(value) !== JSON.stringify(oldObject?.elements?.[index]);
            const accessed = accesses.get(object.id)?.has(index) ?? false;
            return <span className={`runtime-table-cell${modified ? ' is-changed' : ''}${accessed ? ' is-accessed' : ''}`} key={index}><ValueChip value={value} heap={step.heap} /></span>;
          })}</div>
        </div>;
      })}
    </section>}
    {structures.length ? <div className="runtime-structures" aria-label="Captured runtime objects" tabIndex={0}>
      {structures.map((object) => <StructureCard key={object.id} object={object} heap={step.heap} previous={previous?.heap ?? null} accesses={accesses} nameHints={namesById.get(object.id) ?? []} />)}
    </div> : <div className="runtime-empty"><Database size={16} /><span>No heap objects are reachable from the recorded locals or static fields at this step.</span></div>}
    {accesses.size > 0 && <p className="runtime-note">Outlined array cells match simple literal/local indexes on the current source line. Complex index expressions are not inferred.</p>}
    <section className="runtime-subpanel runtime-reference-graph" aria-labelledby="reference-graph-heading">
      <div className="runtime-subhead"><h3 id="reference-graph-heading"><Network size={15} /> {binaryTree ? 'Binary tree hierarchy' : 'Object reference graph'}</h3><span>{binaryTree ? `${binaryTree.nodes.length} nodes · ${binaryTree.edges.length} branches` : `${edges.length} captured links`}</span></div>
      {binaryTree
        ? <p className="runtime-muted">Captured node values and left/right references; no traversal order is inferred.</p>
        : edges.length
          ? <div className="runtime-edge-list">{edges.map((edge, index) =>
            <div className="runtime-edge" key={`${edge.from.id}-${edge.path}-${index}`}>
              <span className="runtime-edge-node"><code>{edge.from.id}</code><small>{edge.from.type}</small></span>
              <span className="runtime-edge-label">{edge.path} →</span>
              <span className="runtime-edge-node"><code>{edge.to.id}</code><small>{edge.to.type}</small></span>
            </div>)}
            {(edges.length >= 120 || structures.length >= 60) && <small className="runtime-muted">Reference view is capped at 60 objects and 120 links.</small>}
          </div>
          : <p className="runtime-muted">No object-to-object references were captured from the current stack roots.</p>}
      {binaryTree ? <div className="runtime-graph-canvas runtime-tree-canvas" tabIndex={0} aria-label="Scrollable binary tree hierarchy">
        <svg className="runtime-tree-svg" width={binaryTree.width} height={binaryTree.height} style={{ width: `${binaryTree.width}px`, maxWidth: 'none' }} viewBox={`0 0 ${binaryTree.width} ${binaryTree.height}`} role="img" aria-label="Captured binary tree hierarchy">
          <defs><marker id="runtime-tree-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker></defs>
          {binaryTree.edges.map((edge) => {
            const from = binaryTree.nodes.find((node) => node.id === edge.from);
            const to = binaryTree.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            return <g key={`${edge.from}-${edge.via}-${edge.to}`}>
              <line x1={from.x} y1={from.y + 28} x2={to.x} y2={to.y - 28} markerEnd="url(#runtime-tree-arrow)" />
              <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2}>{edge.via}</text>
            </g>;
          })}
          {binaryTree.nodes.map((node) => {
            const object = step.heap[node.id];
            const isActive = activeNodeIds.has(node.id);
            return <g key={node.id} className={`runtime-graph-node${isActive ? ' is-active' : ''}`}>
              <circle cx={node.x} cy={node.y} r="28" />
              <text x={node.x} y={node.y - 3} className="runtime-graph-id">{label(node.value, step.heap).slice(0, 16)}</text>
              <text x={node.x} y={node.y + 10} className="runtime-graph-type">{object?.id}</text>
            </g>;
          })}
        </svg>
      </div> : edges.length > 0 && <div className="runtime-graph-canvas">
        <svg viewBox={`0 0 ${graphWidth} ${graphHeight}`} role="img" aria-label="Directed object references from captured Java fields and array elements">
          <defs><marker id="runtime-reference-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker></defs>
          {edges.map((edge, index) => {
            const from = referencePositions.get(edge.from.id)!;
            const to = referencePositions.get(edge.to.id)!;
            return <g key={`${edge.from.id}-${edge.path}-${edge.to.id}-${index}`}>
              <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#runtime-reference-arrow)" />
              <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4}>{edge.path}</text>
            </g>;
          })}
          {graphNodes.map((object) => {
            const point = referencePositions.get(object.id)!;
            const type = object.type.split('.').at(-1) ?? object.type;
            return <g key={object.id} className="runtime-graph-node">
              <circle cx={point.x} cy={point.y} r="31" />
              <text x={point.x} y={point.y - 3} className="runtime-graph-id">{object.id}</text>
              <text x={point.x} y={point.y + 10} className="runtime-graph-type">{type.slice(0, 14)}</text>
            </g>;
          })}
        </svg>
      </div>}
    </section>
    {graph.nodes.length > 0 && graph.edges.length > 0 && <section className="runtime-subpanel runtime-graph-topology" aria-labelledby="graph-topology-heading">
      <div className="runtime-subhead"><h3 id="graph-topology-heading"><Network size={15} /> Captured adjacency graph</h3><span>{graph.nodes.length} nodes · {graph.edges.length} directed links</span></div>
      <p className="runtime-muted">Edges are drawn only from captured adjacency fields. No visited state or algorithm phase is inferred.</p>
      {previous && <p className="runtime-graph-delta">Since the prior event: {graphChanges.newlyObserved.length} links first observed · {graphChanges.noLongerObserved.length} prior links no longer captured. Reachability and trace truncation can affect these counts.</p>}
      <div className="runtime-graph-canvas">
        <svg viewBox={`0 0 ${graphWidth} ${graphHeight}`} role="img" aria-label="Graph topology from captured adjacency references">
          <defs><marker id="runtime-adjacency-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 z" fill="currentColor" /></marker></defs>
          {graph.edges.map((edge, index) => {
            const from = topologyPositions.get(edge.from);
            const to = topologyPositions.get(edge.to);
            if (!from || !to) return null;
            const firstObserved = newlyObservedEdges.has(`${edge.from}\u0000${edge.to}\u0000${edge.via}`);
            return <g key={`${edge.from}-${edge.to}-${index}`}>
              <line className={firstObserved ? 'is-first-observed' : undefined} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd="url(#runtime-adjacency-arrow)">
                {firstObserved && <title>First observed in this event; this does not prove the edge was created now.</title>}
              </line>
              {edge.weight !== null && <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4}>{edge.weight}</text>}
            </g>;
          })}
          {graph.nodes.map((object) => {
            const point = topologyPositions.get(object.id)!;
            const value = object.fields?.value ?? object.fields?.data ?? object.fields?.key;
            const isActive = activeNodeIds.has(object.id);
            return <g key={object.id} className={`runtime-graph-node${isActive ? ' is-active' : ''}`}>
              <circle cx={point.x} cy={point.y} r="32" />
              <text x={point.x} y={point.y - 3} className="runtime-graph-id">{label(value, step.heap).slice(0, 14)}</text>
              <text x={point.x} y={point.y + 10} className="runtime-graph-type">{object.id}</text>
            </g>;
          })}
        </svg>
      </div>
    </section>}
    {Object.values(step.heap).some((object) => object.truncated) && <p className="runtime-note">Some values are summarized or truncated by the trace service; unavailable details are not inferred.</p>}
    {output && <div className="runtime-output"><span>Output at this event</span><pre>{output}</pre></div>}
    </div>
  </section>;
}
