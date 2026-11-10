export interface Cell {
  id: string;
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

export interface Notebook {
  nbformat: 4;
  nbformat_minor: number;
  metadata: Record<string, unknown>;
  cells: Cell[];
  [key: string]: unknown;
}

export type Choice = 'learner' | 'incoming';

export interface Conflict {
  id: string;
  index: number;
  base: string;
  learner: string;
  incoming: string;
}

export interface UpdatePlan {
  base: Notebook;
  learner: Notebook;
  incoming: Notebook;
  conflicts: Conflict[];
  /** Author-changed sources, including conflicts; not a count of applied edits. */
  changedCells: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, active = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Notebook data must contain finite JSON numbers.');
    }
    return JSON.stringify(value);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new Error('Notebook data must contain only JSON values.');
  }
  if (active.has(value)) {
    throw new Error('Notebook data must not contain cyclic references.');
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error('Notebook data must not contain symbol properties.');
  }

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new Error('Notebook arrays must not contain holes or extra properties.');
      }
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, index);
        if (!descriptor) {
          throw new Error('Notebook arrays must not contain missing values.');
        }
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new Error('Notebook data must not contain computed properties.');
        }
        entries.push(canonicalJson(descriptor.value, active));
      }
      return `[${entries.join(',')}]`;
    }

    const entries: string[] = [];
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new Error('Notebook data must not contain computed properties.');
      }
      entries.push(`${JSON.stringify(key)}:${canonicalJson(descriptor.value, active)}`);
    }
    return `{${entries.join(',')}}`;
  } finally {
    active.delete(value);
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

export function sourceText(source: unknown): string {
  if (typeof source === 'string') {
    return source;
  }
  if (Array.isArray(source)) {
    for (const line of source) {
      if (typeof line !== 'string') {
        throw new Error('Cell source must be a string or an array of strings.');
      }
    }
    return source.join('');
  }
  throw new Error('Cell source must be a string or an array of strings.');
}

/** A canonical comparison value, not a cryptographic identity or a CAS token. */
export function fingerprint(value: unknown): string {
  const normalized = cloneJson(value);
  if (isRecord(normalized) && normalized.nbformat === 4 && Array.isArray(normalized.cells)) {
    for (const cell of normalized.cells) {
      if (!isRecord(cell)) {
        throw new Error('Notebook cells must be objects.');
      }
      cell.source = sourceText(cell.source);
    }
  }
  return canonicalJson(normalized);
}

function readNotebook(value: unknown, label: string): Notebook {
  // Clone first so the complete value, including unknown fields, is checked as JSON.
  const copy = cloneJson(value);
  if (!isRecord(copy) || copy.nbformat !== 4) {
    throw new Error(`${label} must be a notebook in format 4.`);
  }
  if (!Number.isInteger(copy.nbformat_minor) || (copy.nbformat_minor as number) < 0) {
    throw new Error(`${label} has an invalid notebook format minor version.`);
  }
  if (!isRecord(copy.metadata) || !Array.isArray(copy.cells)) {
    throw new Error(`${label} must contain notebook metadata and a cell array.`);
  }

  const ids = new Set<string>();
  for (const [index, cell] of copy.cells.entries()) {
    if (!isRecord(cell)) {
      throw new Error(`${label} cell ${index + 1} must be an object.`);
    }
    if (typeof cell.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(cell.id)) {
      throw new Error(`${label} cell ${index + 1} needs a valid stable cell ID.`);
    }
    if (ids.has(cell.id)) {
      throw new Error(`${label} contains duplicate cell ID "${cell.id}".`);
    }
    ids.add(cell.id);
    if (typeof cell.cell_type !== 'string' ||
        !['code', 'markdown', 'raw'].includes(cell.cell_type)) {
      throw new Error(`${label} cell "${cell.id}" has an unsupported cell type.`);
    }
    if (!isRecord(cell.metadata)) {
      throw new Error(`${label} cell "${cell.id}" needs metadata.`);
    }
    sourceText(cell.source);
    if (cell.cell_type === 'code') {
      if (!Array.isArray(cell.outputs)) {
        throw new Error(`${label} code cell "${cell.id}" needs an output array.`);
      }
      if (cell.execution_count !== null &&
          (!Number.isInteger(cell.execution_count) || (cell.execution_count as number) < 0)) {
        throw new Error(`${label} code cell "${cell.id}" has an invalid execution count.`);
      }
    }
  }
  return copy as unknown as Notebook;
}

function sameLayout(base: Notebook, other: Notebook, label: string): void {
  if (base.cells.length !== other.cells.length ||
      base.cells.some((cell, index) =>
        cell.id !== other.cells[index]?.id || cell.cell_type !== other.cells[index]?.cell_type)) {
    throw new Error(`${label} changes cell IDs, order, count or types. This prototype supports a fixed cell layout.`);
  }
}

function without(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function freezeTree(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeTree(child);
    }
    Object.freeze(value);
  }
}

export function planUpdate(base: unknown, learner: unknown, incoming: unknown): UpdatePlan {
  const baseNotebook = readNotebook(base, 'Base notebook');
  const learnerNotebook = readNotebook(learner, 'Learner notebook');
  const incomingNotebook = readNotebook(incoming, 'Incoming notebook');
  sameLayout(baseNotebook, learnerNotebook, 'Learner notebook');
  sameLayout(baseNotebook, incomingNotebook, 'Incoming notebook');

  if (canonicalJson(without(baseNotebook, 'cells')) !==
      canonicalJson(without(incomingNotebook, 'cells'))) {
    throw new Error('Incoming notebook metadata or format changes are unsupported. Only cell source updates can be reviewed.');
  }

  const conflicts: Conflict[] = [];
  const changedCells: string[] = [];
  for (const [index, baseCell] of baseNotebook.cells.entries()) {
    const incomingCell = incomingNotebook.cells[index]!;
    const learnerCell = learnerNotebook.cells[index]!;
    if (canonicalJson(without(baseCell, 'source')) !==
        canonicalJson(without(incomingCell, 'source'))) {
      throw new Error(`Incoming cell "${baseCell.id}" changes metadata or other unsupported fields. Only source updates can be reviewed.`);
    }
    const original = sourceText(baseCell.source);
    const local = sourceText(learnerCell.source);
    const remote = sourceText(incomingCell.source);
    if (remote !== original) {
      changedCells.push(baseCell.id);
    }
    if (local !== original && remote !== original && local !== remote) {
      conflicts.push({ id: baseCell.id, index, base: original, learner: local, incoming: remote });
    }
  }

  const plan = {
    base: baseNotebook,
    learner: learnerNotebook,
    incoming: incomingNotebook,
    conflicts,
    changedCells
  };
  freezeTree(plan);
  return plan;
}

export function resolveUpdate(plan: UpdatePlan, choices: Record<string, Choice>): Notebook {
  if (!isRecord(plan) || !isRecord(choices)) {
    throw new Error('A reviewed update plan and explicit conflict choices are required.');
  }
  const selectedChoices = cloneJson(choices);
  // Recompute instead of trusting caller-supplied conflict or changed-cell lists.
  const current = planUpdate(plan.base, plan.learner, plan.incoming);
  if (canonicalJson(plan.conflicts) !== canonicalJson(current.conflicts) ||
      canonicalJson(plan.changedCells) !== canonicalJson(current.changedCells)) {
    throw new Error('The update plan has changed. Review the update again.');
  }
  const conflictIds = new Set(current.conflicts.map(conflict => conflict.id));
  for (const id of Object.keys(selectedChoices)) {
    if (!conflictIds.has(id) ||
        (selectedChoices[id] !== 'learner' && selectedChoices[id] !== 'incoming')) {
      throw new Error(`Invalid or outdated conflict choice for cell "${id}". Review the update again.`);
    }
  }
  for (const conflict of current.conflicts) {
    if (!Object.hasOwn(selectedChoices, conflict.id)) {
      throw new Error(`Choose the learner or incoming version for cell "${conflict.id}" before creating a copy.`);
    }
  }

  const result = cloneJson(current.learner);
  for (const [index, cell] of result.cells.entries()) {
    const original = sourceText(current.base.cells[index]!.source);
    const local = sourceText(current.learner.cells[index]!.source);
    const remote = sourceText(current.incoming.cells[index]!.source);
    let selected = local;
    if (conflictIds.has(cell.id)) {
      selected = selectedChoices[cell.id] === 'incoming' ? remote : local;
    } else if (local === original) {
      selected = remote;
    }
    if (selected !== local) {
      cell.source = selected;
      if (cell.cell_type === 'code') {
        cell.outputs = [];
        cell.execution_count = null;
        delete cell.metadata.trusted;
      }
    }
  }
  return result;
}
