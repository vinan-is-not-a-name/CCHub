import { test, expect } from '@playwright/test';
import { computeDropIndex, type PaneRect, type PaneRectEntry } from '../src/client/views/paneReorder.js';

// Rect helpers. Widths are 100px for readable arithmetic; centers land at
// (left + right) / 2 = left + 50.
function rect(left: number, top: number, width = 100, height = 80): PaneRect {
  return { left, top, right: left + width, bottom: top + height };
}
function row(...lefts: number[]): PaneRectEntry[] {
  return lefts.map((l, i) => ({ id: String.fromCharCode(65 + i), rect: rect(l, 0) }));
}

test.describe('computeDropIndex', () => {
  test('single pane → always returns fromIndex', () => {
    const panes = row(0);
    expect(computeDropIndex(panes, 0, 50, 40)).toBe(0);
    expect(computeDropIndex(panes, 0, 9999, 40)).toBe(0);
  });

  test('mouse on source pane center → no-op (returns fromIndex)', () => {
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 50, 40)).toBe(0);
  });

  test('two panes, drag A onto B left half → still 0 (no move)', () => {
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 120, 40)).toBe(0);
  });

  test('two panes, drag A onto B right half → 1 (order becomes B A)', () => {
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 0, 180, 40)).toBe(1);
  });

  test('two panes, drag B onto A left half → 0 (order becomes B A)', () => {
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 1, 20, 40)).toBe(0);
  });

  test('two panes, drag B onto A right half → 1 (self, no move)', () => {
    const panes = row(0, 100);
    expect(computeDropIndex(panes, 1, 80, 40)).toBe(1);
  });

  test('three panes, drag middle to far right → 2 (last)', () => {
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 1, 280, 40)).toBe(2);
  });

  test('three panes, drag middle to far left → 0 (first)', () => {
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 1, 20, 40)).toBe(0);
  });

  test('mouse beyond right edge → nearest pane is last; drops at end', () => {
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 0, 500, 40)).toBe(2);
  });

  test('mouse beyond left edge → nearest pane is first; drops at start', () => {
    const panes = row(0, 100, 200);
    expect(computeDropIndex(panes, 2, -500, 40)).toBe(0);
  });

  test('cols-3 multirow: drop into second-row pane picks the second-row pane, not the one directly above', () => {
    const panes: PaneRectEntry[] = [
      { id: 'A', rect: rect(0, 0) },
      { id: 'B', rect: rect(100, 0) },
      { id: 'C', rect: rect(200, 0) },
      { id: 'D', rect: rect(0, 80) },
      { id: 'E', rect: rect(100, 80) },
      { id: 'F', rect: rect(200, 80) },
    ];
    expect(computeDropIndex(panes, 0, 140, 120)).toBe(3);
    expect(computeDropIndex(panes, 0, 160, 120)).toBe(4);
  });

  test('cols-3 multirow: hover exactly on the last pane in second row → tail placement', () => {
    const panes: PaneRectEntry[] = [
      { id: 'A', rect: rect(0, 0) },
      { id: 'B', rect: rect(100, 0) },
      { id: 'C', rect: rect(200, 0) },
      { id: 'D', rect: rect(0, 80) },
      { id: 'E', rect: rect(100, 80) },
      { id: 'F', rect: rect(200, 80) },
    ];
    expect(computeDropIndex(panes, 0, 280, 120)).toBe(5);
    expect(computeDropIndex(panes, 0, 220, 120)).toBe(4);
  });

  test('empty pane list → returns fromIndex unchanged', () => {
    expect(computeDropIndex([], 0, 50, 40)).toBe(0);
  });

  test('axis=y vertical stack, drag A onto B top half → still 0 (no move)', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 0, 100, 65, 'y')).toBe(0);
  });

  test('axis=y drag A onto B bottom half → 1 (order becomes B A C)', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 0, 100, 95, 'y')).toBe(1);
  });

  test('axis=y drag last tab to first tab top half → 0 (move to front)', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 2, 100, 5, 'y')).toBe(0);
  });

  test('axis=y horizontal cursor coord is ignored for before/after decision', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
    ];
    expect(computeDropIndex(stack, 0, 9999, 95, 'y')).toBe(1);
    expect(computeDropIndex(stack, 0, -9999, 65, 'y')).toBe(0);
  });

  test('axis=y mouse above the whole stack → nearest is top, drops at 0', () => {
    const stack: PaneRectEntry[] = [
      { id: 'A', rect: { left: 0, right: 200, top: 0, bottom: 40 } },
      { id: 'B', rect: { left: 0, right: 200, top: 60, bottom: 100 } },
      { id: 'C', rect: { left: 0, right: 200, top: 120, bottom: 160 } },
    ];
    expect(computeDropIndex(stack, 2, 100, -500, 'y')).toBe(0);
  });
});
