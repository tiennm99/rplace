'use client';

import { useEffect, useState } from 'react';
import { MAX_CREDITS } from '@/lib/constants';

/**
 * Displays credit count with client-side regeneration animation.
 */
export default function UserInfo({ credits, setCredits }) {
  // Animate credit regeneration client-side (1 per second)
  useEffect(() => {
    if (credits >= MAX_CREDITS) return;

    const timer = setInterval(() => {
      setCredits((c) => Math.min(c + 1, MAX_CREDITS));
    }, 1000);

    return () => clearInterval(timer);
  }, [credits >= MAX_CREDITS, setCredits]);

  return (
    <div className="user-info">
      <div className="credits">
        <span className="credits-label">Pixels</span>
        <span className="credits-value">{credits}</span>
        <span className="credits-max">/ {MAX_CREDITS}</span>
      </div>
    </div>
  );
}
