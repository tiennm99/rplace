'use client';

import CanvasRenderer from './components/canvas-renderer';
import ColorPicker from './components/color-picker';
import CanvasControls from './components/canvas-controls';
import UserInfo from './components/user-info';
import { useCanvasState } from './hooks/use-canvas-state';
import { useSSEUpdates } from './hooks/use-sse-updates';

export default function Home() {
  const {
    selectedColor, setSelectedColor,
    credits, setCredits,
    cursorPos, setCursorPos,
    zoom, setZoom, zoomIn, zoomOut, resetZoom,
  } = useCanvasState();

  // Apply SSE pixel updates to the canvas
  useSSEUpdates((pixels) => {
    if (!window.__rplaceUpdatePixel) return;
    for (const { x, y, color } of pixels) {
      window.__rplaceUpdatePixel(x, y, color);
    }
  });

  return (
    <main className="app">
      <CanvasRenderer
        selectedColor={selectedColor}
        credits={credits}
        setCredits={setCredits}
        zoom={zoom}
        setZoom={setZoom}
        setCursorPos={setCursorPos}
      />
      <CanvasControls
        zoom={zoom}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onResetZoom={resetZoom}
        cursorPos={cursorPos}
      />
      <ColorPicker
        selectedColor={selectedColor}
        onSelect={setSelectedColor}
      />
      <UserInfo credits={credits} setCredits={setCredits} />
    </main>
  );
}
