'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { CANVAS_WIDTH, CANVAS_HEIGHT, COLORS_RGBA } from '@/lib/constants';
import { decodeCanvas, indicesToRgba } from '@/lib/canvas-decoder';

/**
 * Main canvas component with zoom/pan and pixel placement.
 */
export default function CanvasRenderer({
  selectedColor, credits, setCredits,
  zoom, setZoom, setCursorPos,
}) {
  const canvasRef = useRef(null);
  const imageDataRef = useRef(null);
  const panRef = useRef({ x: 0, y: 0 });
  const draggingRef = useRef(false);
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const [loading, setLoading] = useState(true);

  /** Render the ImageData onto the visible canvas with current zoom/pan */
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    const imageData = imageDataRef.current;
    if (!canvas || !imageData) return;

    const ctx = canvas.getContext('2d');
    const { width, height } = canvas;
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Create offscreen canvas with the pixel data
    const offscreen = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    const offCtx = offscreen.getContext('2d');
    offCtx.putImageData(imageData, 0, 0);

    ctx.save();
    ctx.translate(panRef.current.x, panRef.current.y);
    ctx.scale(zoom, zoom);
    ctx.drawImage(offscreen, 0, 0);
    ctx.restore();
  }, [zoom]);

  /** Load full canvas from API on mount */
  useEffect(() => {
    async function loadCanvas() {
      try {
        const res = await fetch('/api/canvas');
        const buffer = await res.arrayBuffer();
        const indices = decodeCanvas(buffer);
        const rgba = indicesToRgba(indices);
        imageDataRef.current = new ImageData(rgba, CANVAS_WIDTH, CANVAS_HEIGHT);
        render();
      } catch (err) {
        console.error('Failed to load canvas:', err);
      } finally {
        setLoading(false);
      }
    }
    loadCanvas();
  }, [render]);

  /** Re-render when zoom changes */
  useEffect(() => { render(); }, [render]);

  /** Resize canvas to fill viewport */
  useEffect(() => {
    function resize() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      render();
    }
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [render]);

  /** Convert screen coords to canvas pixel coords */
  const screenToCanvas = useCallback((clientX, clientY) => {
    const x = Math.floor((clientX - panRef.current.x) / zoom);
    const y = Math.floor((clientY - panRef.current.y) / zoom);
    return { x, y };
  }, [zoom]);

  /** Update a single pixel in the local ImageData */
  const updateLocalPixel = useCallback((x, y, colorIndex) => {
    if (!imageDataRef.current) return;
    const color = COLORS_RGBA[colorIndex];
    const offset = (y * CANVAS_WIDTH + x) * 4;
    imageDataRef.current.data[offset] = color[0];
    imageDataRef.current.data[offset + 1] = color[1];
    imageDataRef.current.data[offset + 2] = color[2];
    imageDataRef.current.data[offset + 3] = color[3];
  }, []);

  /** Place a pixel via API */
  const placePixel = useCallback(async (x, y) => {
    if (x < 0 || x >= CANVAS_WIDTH || y < 0 || y >= CANVAS_HEIGHT) return;
    if (credits <= 0) return;

    // Optimistic update
    updateLocalPixel(x, y, selectedColor);
    render();

    try {
      const res = await fetch('/api/canvas/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pixels: [{ x, y, color: selectedColor }] }),
      });
      const data = await res.json();
      if (data.ok) {
        setCredits(data.credits);
      }
    } catch (err) {
      console.error('Failed to place pixel:', err);
    }
  }, [selectedColor, credits, setCredits, updateLocalPixel, render]);

  /** Mouse handlers for pan and place */
  const handleMouseDown = useCallback((e) => {
    if (e.button === 0) {
      draggingRef.current = false;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }
  }, []);

  const handleMouseMove = useCallback((e) => {
    const pos = screenToCanvas(e.clientX, e.clientY);
    setCursorPos({ x: Math.max(0, pos.x), y: Math.max(0, pos.y) });

    if (e.buttons === 1) {
      const dx = e.clientX - lastMouseRef.current.x;
      const dy = e.clientY - lastMouseRef.current.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        draggingRef.current = true;
      }
      panRef.current.x += dx;
      panRef.current.y += dy;
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
      render();
    }
  }, [screenToCanvas, setCursorPos, render]);

  const handleMouseUp = useCallback((e) => {
    if (e.button === 0 && !draggingRef.current) {
      const pos = screenToCanvas(e.clientX, e.clientY);
      placePixel(pos.x, pos.y);
    }
    draggingRef.current = false;
  }, [screenToCanvas, placePixel]);

  /** Scroll wheel zoom centered on cursor */
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 2 : 0.5;
    const newZoom = Math.max(0.25, Math.min(64, zoom * factor));

    // Zoom toward cursor position
    const cx = e.clientX;
    const cy = e.clientY;
    panRef.current.x = cx - (cx - panRef.current.x) * (newZoom / zoom);
    panRef.current.y = cy - (cy - panRef.current.y) * (newZoom / zoom);

    setZoom(newZoom);
  }, [zoom, setZoom]);

  /** Expose updateLocalPixel for SSE updates */
  useEffect(() => {
    window.__rplaceUpdatePixel = (x, y, color) => {
      updateLocalPixel(x, y, color);
      render();
    };
    return () => { delete window.__rplaceUpdatePixel; };
  }, [updateLocalPixel, render]);

  return (
    <div className="canvas-container">
      {loading && <div className="loading">Loading canvas...</div>}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        style={{ cursor: draggingRef.current ? 'grabbing' : 'crosshair' }}
      />
    </div>
  );
}
