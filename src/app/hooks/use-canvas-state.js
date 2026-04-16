'use client';

import { useState, useCallback } from 'react';

/**
 * Shared canvas UI state: selected color, credits, coordinates.
 */
export function useCanvasState() {
  const [selectedColor, setSelectedColor] = useState(27); // black
  const [credits, setCredits] = useState(256);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(z * 2, 64));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(z / 2, 0.25));
  }, []);

  const resetZoom = useCallback(() => setZoom(1), []);

  return {
    selectedColor, setSelectedColor,
    credits, setCredits,
    cursorPos, setCursorPos,
    zoom, setZoom, zoomIn, zoomOut, resetZoom,
  };
}
