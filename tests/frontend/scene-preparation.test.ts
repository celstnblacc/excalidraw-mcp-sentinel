import { describe, it, expect, vi } from 'vitest';
import {
  expandLabelsToNative,
  prepareElementsForScene,
} from '../../frontend/src/utils/scenePreparation.js';
import type { ServerElement } from '../../frontend/src/utils/elementHelpers.js';

describe('expandLabelsToNative', () => {
  it('creates a native bound text element at container center', () => {
    const input = [{
      id: 'box-1',
      type: 'rectangle',
      x: 100,
      y: 200,
      width: 300,
      height: 120,
      label: { text: 'Title' },
      boundElements: [{ id: 'arrow-1', type: 'arrow' }],
    }];

    const out = expandLabelsToNative(input as any[]);
    expect(out).toHaveLength(2);

    const container = out.find((el) => el.id === 'box-1') as any;
    const text = out.find((el) => el.id === 'box-1_label') as any;

    expect(container.boundElements).toEqual([
      { id: 'arrow-1', type: 'arrow' },
      { id: 'box-1_label', type: 'text' },
    ]);
    expect(text.containerId).toBe('box-1');
    expect(text.text).toBe('Title');
    expect(text.x).toBe(230);
    expect(text.y).toBe(250);
  });

  it('passes through elements with no label.text unchanged', () => {
    const a = { id: 'a', type: 'rectangle', x: 0, y: 0, width: 100, height: 40 };
    const b = { id: 'b', type: 'text', x: 10, y: 10, text: 'Hello' };
    const out = expandLabelsToNative([a, b] as any[]);
    expect(out).toEqual([a, b]);
  });
});

describe('prepareElementsForScene', () => {
  it('routes native browser-synced elements without conversion', () => {
    const native = {
      id: 'native-1',
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      seed: 123,
      versionNonce: 456,
      version: 1,
    } as any as ServerElement;

    const converter = vi.fn((elements: readonly any[]) =>
      elements.map((el) => ({ ...el, converted: true }))
    );

    const out = prepareElementsForScene([native], converter as any);
    expect(converter).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect((out[0] as any).id).toBe('native-1');
    expect((out[0] as any).converted).toBeUndefined();
  });

  it('routes MCP stubs through converter', () => {
    const stub = {
      id: 'stub-1',
      type: 'rectangle',
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      label: { text: 'Stub' },
      version: 1,
    } as ServerElement;

    const converter = vi.fn((elements: readonly any[]) =>
      elements.map((el) => ({ ...el, converted: true }))
    );

    const out = prepareElementsForScene([stub], converter as any);
    expect(converter).toHaveBeenCalledTimes(1);
    expect(out.some((el) => (el as any).id === 'stub-1' && (el as any).converted)).toBe(true);
  });
});
