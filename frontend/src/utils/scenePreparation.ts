import type { ExcalidrawElement } from '@excalidraw/excalidraw/types/element/types';
import {
  cleanElementForExcalidraw,
  isImageElement,
  normalizeImageElement,
  restoreBindings,
  validateAndFixBindings,
} from './elementHelpers';
import type { ServerElement } from './elementHelpers';

type SceneConverter = (
  elements: readonly any[],
  options?: { regenerateIds?: boolean }
) => Partial<ExcalidrawElement>[];

const LABEL_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);

export function convertElementsPreservingImageProps(
  cleanedElements: any[],
  converter: SceneConverter
): any[] {
  const imageElements = cleanedElements.filter(isImageElement);
  const nonImageElements = cleanedElements.filter(el => !isImageElement(el));

  let convertedNonImage: any[] = [];
  if (nonImageElements.length > 0) {
    convertedNonImage = converter(nonImageElements, { regenerateIds: false }) as any[];
    convertedNonImage = restoreBindings(convertedNonImage, nonImageElements);
  }

  const normalizedImages = imageElements.map(normalizeImageElement);
  return [...convertedNonImage, ...normalizedImages];
}

// Expand server-format label.text into native Excalidraw bound text elements.
// Without this, labels stored as label.text on containers vanish on page reload
// because convertToExcalidrawElements silently drops them.
export function expandLabelsToNative(elements: any[]): any[] {
  const expanded: any[] = [];
  for (const el of elements) {
    if (el.label?.text && LABEL_TYPES.has(el.type)) {
      const boundTextId = `${el.id}_label`;
      const { label, ...rest } = el;
      const existingBindings = (rest.boundElements || []).filter((b: any) => b.type !== 'text');
      expanded.push({
        ...rest,
        boundElements: [...existingBindings, { id: boundTextId, type: 'text' }]
      });
      expanded.push({
        id: boundTextId, type: 'text', containerId: el.id,
        x: (el.x ?? 0) + ((el.width ?? 100) / 2) - 20,
        y: (el.y ?? 0) + ((el.height ?? 40) / 2) - 10,
        width: el.width ?? 100, height: 25, angle: 0,
        text: label.text, originalText: label.text,
        fontSize: el.fontSize ?? 20, fontFamily: el.fontFamily ?? 5,
        textAlign: 'center', verticalAlign: 'middle',
        strokeColor: el.strokeColor ?? '#1e1e1e',
        backgroundColor: 'transparent', fillStyle: 'solid',
        strokeWidth: 1, strokeStyle: 'solid',
        roughness: el.roughness ?? 1, opacity: el.opacity ?? 100,
        groupIds: [], roundness: null, isDeleted: false,
        autoResize: true, lineHeight: 1.25,
      });
    } else {
      expanded.push(el);
    }
  }
  return expanded;
}

// Prepare DB elements for the Excalidraw scene.
// Browser-synced elements (have seed + versionNonce) load as-is — no metric
// recalculation, no position drift. MCP-created stubs (no internals) are
// expanded from label.text and converted to get proper Excalidraw internals.
export function prepareElementsForScene(
  rawElements: ServerElement[],
  converter: SceneConverter
): any[] {
  const cleaned = rawElements.map(cleanElementForExcalidraw);
  const expanded = expandLabelsToNative(cleaned);
  const validated = validateAndFixBindings(expanded as any[]);

  const nativeReady: any[] = [];
  const needsConversion: any[] = [];
  for (const el of validated) {
    if ((el as any).seed !== undefined && (el as any).versionNonce !== undefined) {
      nativeReady.push(el);
    } else {
      needsConversion.push(el);
    }
  }

  const converted = needsConversion.length > 0
    ? convertElementsPreservingImageProps(needsConversion, converter)
    : [];
  return [...nativeReady, ...converted];
}
