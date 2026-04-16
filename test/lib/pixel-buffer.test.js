import { describe, it, expect, beforeEach } from 'vitest';
import { createPixelBuffer } from '../../src/lib/pixel-buffer.js';

describe('createPixelBuffer', () => {
  let buffer;

  beforeEach(() => {
    buffer = createPixelBuffer();
  });

  describe('initial state', () => {
    it('starts empty', () => {
      expect(buffer.canUndo).toBe(false);
      expect(buffer.canRedo).toBe(false);
      expect(buffer.pixelCount).toBe(0);
      expect(buffer.getAllPixels()).toEqual([]);
    });
  });

  describe('addStroke', () => {
    it('adds pixels to buffer', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 5 }]);
      expect(buffer.pixelCount).toBe(1);
      expect(buffer.canUndo).toBe(true);
    });

    it('ignores empty strokes', () => {
      buffer.addStroke([]);
      expect(buffer.pixelCount).toBe(0);
      expect(buffer.canUndo).toBe(false);
    });

    it('clears redo stack on new stroke', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }]);
      buffer.undo();
      expect(buffer.canRedo).toBe(true);
      buffer.addStroke([{ x: 1, y: 1, color: 2 }]);
      expect(buffer.canRedo).toBe(false);
    });

    it('copies input array (does not hold reference)', () => {
      const stroke = [{ x: 0, y: 0, color: 1 }];
      buffer.addStroke(stroke);
      stroke.push({ x: 1, y: 1, color: 2 });
      expect(buffer.pixelCount).toBe(1);
    });
  });

  describe('undo / redo', () => {
    it('undo returns removed stroke', () => {
      const stroke = [{ x: 5, y: 10, color: 3 }];
      buffer.addStroke(stroke);
      const removed = buffer.undo();
      expect(removed).toEqual(stroke);
      expect(buffer.pixelCount).toBe(0);
    });

    it('undo on empty returns null', () => {
      expect(buffer.undo()).toBeNull();
    });

    it('redo returns re-applied stroke', () => {
      const stroke = [{ x: 5, y: 10, color: 3 }];
      buffer.addStroke(stroke);
      buffer.undo();
      const redone = buffer.redo();
      expect(redone).toEqual(stroke);
      expect(buffer.pixelCount).toBe(1);
    });

    it('redo on empty returns null', () => {
      expect(buffer.redo()).toBeNull();
    });

    it('supports multiple undo/redo cycles', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }]);
      buffer.addStroke([{ x: 1, y: 1, color: 2 }]);
      buffer.addStroke([{ x: 2, y: 2, color: 3 }]);
      expect(buffer.pixelCount).toBe(3);

      buffer.undo();
      buffer.undo();
      expect(buffer.pixelCount).toBe(1);
      expect(buffer.canRedo).toBe(true);

      buffer.redo();
      expect(buffer.pixelCount).toBe(2);
    });
  });

  describe('getAllPixels (deduplication)', () => {
    it('last stroke wins for same coordinate', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }]);
      buffer.addStroke([{ x: 0, y: 0, color: 5 }]);
      const pixels = buffer.getAllPixels();
      expect(pixels.length).toBe(1);
      expect(pixels[0].color).toBe(5);
    });

    it('merges pixels from multiple strokes', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 2 }]);
      buffer.addStroke([{ x: 2, y: 0, color: 3 }]);
      expect(buffer.getAllPixels().length).toBe(3);
    });
  });

  describe('getColorAt', () => {
    it('returns -1 for non-pending pixel', () => {
      expect(buffer.getColorAt(0, 0)).toBe(-1);
    });

    it('returns latest color for pending pixel', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 10 }]);
      buffer.addStroke([{ x: 0, y: 0, color: 20 }]);
      expect(buffer.getColorAt(0, 0)).toBe(20);
    });

    it('returns -1 after undo removes the pixel', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 10 }]);
      buffer.undo();
      expect(buffer.getColorAt(0, 0)).toBe(-1);
    });

    it('reveals earlier stroke after undo', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 10 }]);
      buffer.addStroke([{ x: 0, y: 0, color: 20 }]);
      buffer.undo();
      expect(buffer.getColorAt(0, 0)).toBe(10);
    });
  });

  describe('getAffectedKeys', () => {
    it('returns empty set for empty buffer', () => {
      expect(buffer.getAffectedKeys().size).toBe(0);
    });

    it('returns unique coordinate keys', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }, { x: 1, y: 0, color: 2 }]);
      buffer.addStroke([{ x: 0, y: 0, color: 3 }]);
      const keys = buffer.getAffectedKeys();
      expect(keys.size).toBe(2);
    });
  });

  describe('pixelCount', () => {
    it('counts unique coordinates across strokes', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }]);
      buffer.addStroke([{ x: 0, y: 0, color: 2 }, { x: 1, y: 0, color: 3 }]);
      // (0,0) counted once + (1,0) = 2 unique pixels
      expect(buffer.pixelCount).toBe(2);
    });
  });

  describe('clear', () => {
    it('resets all state', () => {
      buffer.addStroke([{ x: 0, y: 0, color: 1 }]);
      buffer.undo();
      buffer.clear();
      expect(buffer.canUndo).toBe(false);
      expect(buffer.canRedo).toBe(false);
      expect(buffer.pixelCount).toBe(0);
      expect(buffer.getAllPixels()).toEqual([]);
    });
  });
});
