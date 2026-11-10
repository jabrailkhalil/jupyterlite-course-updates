export type Change = 'added' | 'removed' | 'unchanged';
export interface DiffLine { text: string; change: Change; }
export type CellState = 'unchanged' | 'course' | 'learner' | 'conflict';

export function cellState(base: string, learner: string, incoming: string): CellState {
  if (learner === base && incoming === base) return 'unchanged';
  if (incoming === base) return 'learner';
  if (learner === base || learner === incoming) return 'course';
  return 'conflict';
}

/** Whole-line comparison for presentation only; resolution uses the merge engine. */
export function diffLines(before: string, after: string): { before: DiffLine[]; after: DiffLine[] } {
  const left = before.split('\n');
  const right = after.split('\n');
  const oldLines: DiffLine[] = left.map(text => ({ text, change: 'removed' }));
  const newLines: DiffLine[] = right.map(text => ({ text, change: 'added' }));
  const same = (a: number, b: number): void => {
    oldLines[a].change = 'unchanged'; newLines[b].change = 'unchanged';
  };
  if (left.length * right.length > 40_000) {
    // Bound browser work for long cells. Preserve common ends; mark the middle.
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) { same(start, start); start++; }
    let a = left.length - 1, b = right.length - 1;
    while (a >= start && b >= start && left[a] === right[b]) { same(a, b); a--; b--; }
  } else {
    const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
    for (let a = left.length - 1; a >= 0; a--) {
      for (let b = right.length - 1; b >= 0; b--) {
        lengths[a][b] = left[a] === right[b] ? lengths[a + 1][b + 1] + 1 : Math.max(lengths[a + 1][b], lengths[a][b + 1]);
      }
    }
    let a = 0, b = 0;
    while (a < left.length && b < right.length) {
      if (left[a] === right[b]) { same(a, b); a++; b++; }
      else if (lengths[a + 1][b] >= lengths[a][b + 1]) a++;
      else b++;
    }
  }
  return { before: oldLines, after: newLines };
}
