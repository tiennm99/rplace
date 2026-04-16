'use client';

import { COLORS } from '@/lib/constants';

/**
 * 32-color palette grid. Click to select a color.
 */
export default function ColorPicker({ selectedColor, onSelect }) {
  return (
    <div className="color-picker">
      {COLORS.map((hex, i) => (
        <button
          key={i}
          className={`color-swatch ${i === selectedColor ? 'selected' : ''}`}
          style={{ backgroundColor: hex }}
          onClick={() => onSelect(i)}
          title={`Color ${i}: ${hex}`}
          aria-label={`Select color ${hex}`}
        />
      ))}
    </div>
  );
}
