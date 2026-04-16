'use client';

/**
 * Zoom controls and coordinate display.
 */
export default function CanvasControls({
  zoom, onZoomIn, onZoomOut, onResetZoom, cursorPos,
}) {
  return (
    <div className="canvas-controls">
      <div className="zoom-controls">
        <button onClick={onZoomOut} title="Zoom out">−</button>
        <span className="zoom-level">{zoom >= 1 ? `${zoom}x` : `1/${1 / zoom}x`}</span>
        <button onClick={onZoomIn} title="Zoom in">+</button>
        <button onClick={onResetZoom} title="Reset zoom">⟲</button>
      </div>
      <div className="coords">
        ({cursorPos.x}, {cursorPos.y})
      </div>
    </div>
  );
}
