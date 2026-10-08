import assert from 'node:assert/strict';
import test from 'node:test';
import type { TraceStep } from '@workspace/api-client-react';
import {
  arrayPathsFromRoots,
  capturedBinaryTree,
  capturedGraph,
  capturedGraphChanges,
  capturedMatrixRows,
  inferSourceArrayAccesses,
  observedArrayCellChanges,
  sequenceState,
} from '../src/components/RuntimeVisualizer';

const step: TraceStep = {
  step: 0,
  event: 'line',
  line: 2,
  frame: { class: 'Main', method: 'main' },
  stack: [{
    class: 'Main',
    method: 'main',
    line: 2,
    locals: {
      values: { kind: 'ref', id: 'o1' },
      matrix: { kind: 'ref', id: 'o2' },
      index: { kind: 'prim', type: 'int', value: 1 },
      row: { kind: 'prim', type: 'int', value: 0 },
      column: { kind: 'prim', type: 'int', value: 1 },
    },
  }],
  stackTruncated: 0,
  statics: {},
  heap: {
    o1: { id: 'o1', type: 'int[]', kind: 'array', elements: [{ kind: 'prim', type: 'int', value: 4 }, { kind: 'prim', type: 'int', value: 7 }], size: 2 },
    o2: { id: 'o2', type: 'int[][]', kind: 'array', elements: [{ kind: 'ref', id: 'o3' }], size: 1 },
    o3: { id: 'o3', type: 'int[]', kind: 'array', elements: [{ kind: 'prim', type: 'int', value: 2 }, { kind: 'prim', type: 'int', value: 3 }], size: 2 },
  },
  stdout: '',
  stderr: '',
  changed: [],
  explanation: 'Observed test event.',
  error: null,
};

test('identifies simple literal and local-variable array indexes from the selected source line', () => {
  const accesses = inferSourceArrayAccesses(
    'int unused = 0;\nvalues[index] = matrix[row][column];',
    2,
    step,
  );

  assert.deepEqual([...accesses.get('o1') ?? []], [1]);
  assert.deepEqual([...accesses.get('o2') ?? []], [0]);
  assert.deepEqual([...accesses.get('o3') ?? []], [1]);
});

test('does not guess array indexes from expressions it cannot evaluate', () => {
  const accesses = inferSourceArrayAccesses('values[index + 1] = 8;', 1, step);
  assert.equal(accesses.size, 0);
});

test('does not infer indexes from comments, strings, or qualified field names', () => {
  const source = [
    'String note = "values[1]";',
    'holder.values[index] = 8; // values[index]',
  ].join('\n');

  assert.equal(inferSourceArrayAccesses(source, 1, step).size, 0);
  assert.equal(inferSourceArrayAccesses(source, 2, step).size, 0);
});

test('reads ArrayDeque values in captured circular-buffer order', () => {
  const deque: TraceStep['heap'][string] = {
    id: 'o4',
    type: 'java.util.ArrayDeque',
    kind: 'object',
    size: 3,
    fields: {
      elements: { kind: 'ref', id: 'o5' },
      head: { kind: 'prim', type: 'int', value: 3 },
      tail: { kind: 'prim', type: 'int', value: 1 },
    },
  };
  const backing: TraceStep['heap'][string] = {
    id: 'o5',
    type: 'java.lang.Object[]',
    kind: 'array',
    size: 5,
    elements: [
      { kind: 'prim', type: 'int', value: 30 },
      { kind: 'null' },
      { kind: 'null' },
      { kind: 'prim', type: 'int', value: 10 },
      { kind: 'prim', type: 'int', value: 20 },
    ],
  };

  const state = sequenceState(deque, 'deque', { o4: deque, o5: backing });
  assert.equal(state.size, 3);
  assert.equal(state.capacity, 5);
  assert.deepEqual(state.values.map((value) => value.kind === 'prim' ? value.value : null), [10, 20, 30]);
});

test('limits Stack contents to the captured element count', () => {
  const stack: TraceStep['heap'][string] = {
    id: 'o6',
    type: 'java.util.Stack',
    kind: 'object',
    size: 4,
    fields: {
      elementData: { kind: 'ref', id: 'o7' },
      elementCount: { kind: 'prim', type: 'int', value: 2 },
      capacityIncrement: { kind: 'prim', type: 'int', value: 0 },
      modCount: { kind: 'prim', type: 'int', value: 2 },
    },
  };
  const backing: TraceStep['heap'][string] = {
    id: 'o7',
    type: 'java.lang.Object[]',
    kind: 'array',
    size: 4,
    elements: [
      { kind: 'prim', type: 'int', value: 10 },
      { kind: 'prim', type: 'int', value: 30 },
      { kind: 'null' },
      { kind: 'null' },
    ],
  };

  const state = sequenceState(stack, 'stack', { o6: stack, o7: backing });
  assert.equal(state.size, 2);
  assert.equal(state.capacity, 4);
  assert.deepEqual(state.values.map((value) => value.kind === 'prim' ? value.value : null), [10, 30]);
});

test('builds directed graph topology only from captured neighbor fields', () => {
  const heap: TraceStep['heap'] = {
    o1: {
      id: 'o1', type: 'Node', kind: 'object', size: 2,
      fields: { value: { kind: 'prim', type: 'int', value: 1 }, neighbors: { kind: 'ref', id: 'o3' } },
    },
    o2: {
      id: 'o2', type: 'Node', kind: 'object', size: 2,
      fields: { value: { kind: 'prim', type: 'int', value: 2 }, neighbors: { kind: 'ref', id: 'o4' } },
    },
    o3: {
      id: 'o3', type: 'java.util.ArrayList', kind: 'object', size: 1,
      fields: { size: { kind: 'prim', type: 'int', value: 1 }, elementData: { kind: 'ref', id: 'o5' } },
    },
    o4: {
      id: 'o4', type: 'java.util.ArrayList', kind: 'object', size: 1,
      fields: { size: { kind: 'prim', type: 'int', value: 1 }, elementData: { kind: 'ref', id: 'o6' } },
    },
    o5: {
      id: 'o5', type: 'Object[]', kind: 'array', size: 1,
      elements: [{ kind: 'ref', id: 'o2' }],
    },
    o6: {
      id: 'o6', type: 'Object[]', kind: 'array', size: 1,
      elements: [{ kind: 'ref', id: 'o1' }],
    },
  };

  const graph = capturedGraph(['o1'], heap);
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['o1', 'o2']);
  assert.deepEqual(graph.edges.map(({ from, to }) => `${from}->${to}`).sort(), ['o1->o2', 'o2->o1']);
});

test('does not infer graph topology from arbitrary reference fields', () => {
  const graph = capturedGraph(['o1'], {
    o1: { id: 'o1', type: 'Pair', kind: 'object', size: 1, fields: { child: { kind: 'ref', id: 'o2' } } },
    o2: { id: 'o2', type: 'Pair', kind: 'object', size: 1, fields: { value: { kind: 'prim', type: 'int', value: 1 } } },
  });
  assert.deepEqual(graph, { nodes: [], edges: [] });
});

test('lays out a tree reachable through a nested object hierarchy', () => {
  const heap: TraceStep['heap'] = {
    wrapper: {
      id: 'wrapper', type: 'Wrapper', kind: 'object', size: 1,
      fields: { tree: { kind: 'ref', id: 'tree' } },
    },
    tree: {
      id: 'tree', type: 'Tree', kind: 'object', size: 1,
      fields: { root: { kind: 'ref', id: 'root' } },
    },
    root: {
      id: 'root', type: 'Node', kind: 'object', size: 3,
      fields: {
        value: { kind: 'prim', type: 'int', value: 2 },
        left: { kind: 'ref', id: 'left' },
        right: { kind: 'ref', id: 'right' },
      },
    },
    left: {
      id: 'left', type: 'Node', kind: 'object', size: 1,
      fields: { value: { kind: 'prim', type: 'int', value: 1 }, left: { kind: null }, right: { kind: null } },
    },
    right: {
      id: 'right', type: 'Node', kind: 'object', size: 1,
      fields: { value: { kind: 'prim', type: 'int', value: 3 }, left: { kind: null }, right: { kind: null } },
    },
  };

  const layout = capturedBinaryTree(['wrapper'], heap);
  assert.ok(layout);
  assert.deepEqual(layout.nodes.map(({ id }) => id), ['root', 'left', 'right']);
  assert.deepEqual(layout.edges.map(({ from, to, via }) => `${from}.${via}->${to}`).sort(), ['root.left->left', 'root.right->right']);
  const positions = new Map(layout.nodes.map(({ id, x, y }) => [id, { x, y }]));
  assert.equal(positions.get('root')?.y, 54);
  assert.ok(positions.get('left')!.x < positions.get('root')!.x);
  assert.ok(positions.get('right')!.x > positions.get('root')!.x);
  assert.equal(positions.get('left')?.y, positions.get('right')?.y);
  assert.equal(layout.width, 320);
});

test('uses captured left/right reference links to recover a missed tree root', () => {
  const heap: TraceStep['heap'] = {
    root: {
      id: 'root', type: 'Node', kind: 'object', size: 3,
      fields: { value: { kind: 'prim', type: 'int', value: 2 }, left: { kind: null }, right: { kind: null } },
    },
    left: {
      id: 'left', type: 'Node', kind: 'object', size: 2,
      fields: { value: { kind: 'prim', type: 'int', value: 1 }, left: { kind: null }, right: { kind: null } },
    },
  };
  const layout = capturedBinaryTree([], heap, [
    { from: heap.root, path: 'left', to: heap.left },
  ]);

  assert.ok(layout);
  assert.deepEqual(layout.nodes.map(({ id }) => id), ['root', 'left']);
  assert.deepEqual(layout.edges.map(({ from, to, via }) => `${from}.${via}->${to}`), ['root.left->left']);
});

test('reports full canvas dimensions for deep and wide trees', () => {
  const heap: TraceStep['heap'] = {};
  for (let index = 0; index < 7; index++) {
    heap[`node-${index}`] = {
      id: `node-${index}`, type: 'Node', kind: 'object', size: 3,
      fields: {
        value: { kind: 'prim', type: 'int', value: index },
        left: { kind: null },
        right: index < 6 ? { kind: 'ref', id: `node-${index + 1}` } : { kind: null },
      },
    };
  }

  const layout = capturedBinaryTree(['node-0'], heap);
  assert.ok(layout);
  assert.equal(layout.nodes.length, 7);
  assert.ok(layout.height > 420);

  const wideHeap: TraceStep['heap'] = {};
  for (let index = 0; index < 7; index++) {
    wideHeap[`node-${index}`] = {
      id: `node-${index}`, type: 'Node', kind: 'object', size: 3,
      fields: {
        value: { kind: 'prim', type: 'int', value: index },
        left: index < 3 ? { kind: 'ref', id: `node-${index * 2 + 1}` } : { kind: null },
        right: index < 3 ? { kind: 'ref', id: `node-${index * 2 + 2}` } : { kind: null },
      },
    };
  }
  const wideLayout = capturedBinaryTree(['node-0'], wideHeap);
  assert.ok(wideLayout);
  assert.ok(wideLayout.width > 500);
});

test('does not truncate a captured tree at the prior sixty-node display limit', () => {
  const heap: TraceStep['heap'] = {};
  for (let index = 0; index < 75; index++) {
    heap[`node-${index}`] = {
      id: `node-${index}`, type: 'Node', kind: 'object', size: 2,
      fields: {
        val: { kind: 'prim', type: 'int', value: index },
        left: { kind: null },
        right: index < 74 ? { kind: 'ref', id: `node-${index + 1}` } : { kind: null },
      },
    };
  }

  const layout = capturedBinaryTree(['node-0'], heap);
  assert.ok(layout);
  assert.equal(layout.nodes.length, 75);
  assert.equal(layout.nodes.at(-1)?.value.kind, 'prim');
});

test('safely limits cycles and shared children in captured tree links', () => {
  const heap: TraceStep['heap'] = {
    root: {
      id: 'root', type: 'Node', kind: 'object', size: 2,
      fields: { value: { kind: 'prim', type: 'int', value: 1 }, left: { kind: 'ref', id: 'child' }, right: { kind: 'ref', id: 'child' } },
    },
    child: {
      id: 'child', type: 'Node', kind: 'object', size: 2,
      fields: { value: { kind: 'prim', type: 'int', value: 2 }, left: { kind: 'ref', id: 'root' }, right: { kind: null } },
    },
  };

  const layout = capturedBinaryTree(['root'], heap);
  assert.ok(layout);
  assert.deepEqual(layout.nodes.map(({ id }) => id), ['root', 'child']);
  assert.ok(layout.nodes.length <= Object.keys(heap).length);
});

test('reports captured adjacency links first observed or no longer captured between events', () => {
  const earlier = capturedGraph(['o1'], {
    o1: {
      id: 'o1', type: 'Node', kind: 'object', size: 1,
      fields: { neighbors: { kind: 'ref', id: 'o2' } },
    },
    o2: {
      id: 'o2', type: 'Node', kind: 'object', size: 1,
      fields: { neighbors: { kind: 'ref', id: 'o3' } },
    },
    o3: { id: 'o3', type: 'Node', kind: 'object', size: 1, fields: { neighbors: { kind: 'null' } } },
  });
  const later = capturedGraph(['o1'], {
    o1: {
      id: 'o1', type: 'Node', kind: 'object', size: 1,
      fields: { neighbors: { kind: 'ref', id: 'o2' } },
    },
    o2: {
      id: 'o2', type: 'Node', kind: 'object', size: 1,
      fields: { neighbors: { kind: 'ref', id: 'o3' } },
    },
    o3: { id: 'o3', type: 'Node', kind: 'object', size: 1, fields: { neighbors: { kind: 'null' } } },
  });
  later.edges.push({ from: 'o1', to: 'o3', via: 'neighbors', weight: null });

  const changes = capturedGraphChanges(later, earlier);
  assert.deepEqual(changes.newlyObserved.map(({ from, to }) => `${from}->${to}`), ['o1->o3']);
  assert.deepEqual(changes.noLongerObserved, []);
  assert.deepEqual(capturedGraphChanges(earlier, later).noLongerObserved.map(({ from, to }) => `${from}->${to}`), ['o1->o3']);
  assert.deepEqual(capturedGraphChanges(later, null), { newlyObserved: [], noLongerObserved: [] });
});

test('reports changed values only for array cells present in both snapshots', () => {
  const previous: TraceStep = {
    ...step,
    heap: {
      ...step.heap,
      o1: { ...step.heap.o1, elements: [
        { kind: 'prim', type: 'int', value: 4 },
        { kind: 'prim', type: 'int', value: 7 },
      ] },
      o9: { id: 'o9', type: 'int[]', kind: 'array', elements: [{ kind: 'prim', type: 'int', value: 1 }], size: 1 },
    },
  };
  const current: TraceStep = {
    ...step,
    step: 1,
    heap: {
      ...previous.heap,
      o1: { ...previous.heap.o1, elements: [
        { kind: 'prim', type: 'int', value: 4 },
        { kind: 'prim', type: 'int', value: 9 },
      ] },
      o9: { id: 'o9', type: 'int[]', kind: 'array', elements: [{ kind: 'prim', type: 'int', value: 2 }], size: 1 },
      o10: { id: 'o10', type: 'int[]', kind: 'array', elements: [{ kind: 'prim', type: 'int', value: 0 }], size: 1 },
    },
  };

  assert.deepEqual(observedArrayCellChanges(current, previous), [
    {
      arrayId: 'o1',
      index: 1,
      before: { kind: 'prim', type: 'int', value: 7 },
      after: { kind: 'prim', type: 'int', value: 9 },
    },
    {
      arrayId: 'o9',
      index: 0,
      before: { kind: 'prim', type: 'int', value: 1 },
      after: { kind: 'prim', type: 'int', value: 2 },
    },
  ]);
  assert.deepEqual(observedArrayCellChanges(current, null), []);
});

test('tracks readable paths through captured nested arrays', () => {
  const paths = arrayPathsFromRoots([
    ['dp', { kind: 'ref', id: 'o10' }],
  ], {
    o10: {
      id: 'o10', type: 'int[][]', kind: 'array', size: 2,
      elements: [{ kind: 'ref', id: 'o11' }, { kind: 'ref', id: 'o12' }],
    },
    o11: {
      id: 'o11', type: 'int[]', kind: 'array', size: 2,
      elements: [{ kind: 'prim', type: 'int', value: 1 }, { kind: 'prim', type: 'int', value: 2 }],
    },
    o12: {
      id: 'o12', type: 'int[]', kind: 'array', size: 1,
      elements: [{ kind: 'prim', type: 'int', value: 3 }],
    },
  });

  assert.deepEqual(paths.get('o10'), ['dp']);
  assert.deepEqual(paths.get('o11'), ['dp[0]']);
  assert.deepEqual(paths.get('o12'), ['dp[1]']);
});

test('renders captured ragged matrix rows and preserves null or uncaptured rows', () => {
  const heap: TraceStep['heap'] = {
    o20: {
      id: 'o20', type: 'int[][]', kind: 'array', size: 3,
      elements: [
        { kind: 'ref', id: 'o21' },
        { kind: 'null' },
        { kind: 'ref', id: 'missing' },
      ],
    },
    o21: {
      id: 'o21', type: 'int[]', kind: 'array', size: 2,
      elements: [
        { kind: 'prim', type: 'int', value: 1 },
        { kind: 'prim', type: 'int', value: 2 },
      ],
    },
  };
  const rows = capturedMatrixRows(heap.o20, heap);

  assert.deepEqual(rows, [
    {
      rowIndex: 0,
      arrayId: 'o21',
      values: [
        { kind: 'prim', type: 'int', value: 1 },
        { kind: 'prim', type: 'int', value: 2 },
      ],
    },
    { rowIndex: 1, arrayId: null, values: [] },
    { rowIndex: 2, arrayId: null, values: [] },
  ]);
  assert.equal(capturedMatrixRows(heap.o21, heap), null);
});
