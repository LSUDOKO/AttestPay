// Hand-drawn atmosphere: monoline marks in forest ink at low opacity, placed
// behind hero and transition zones. Sharp 1.5–2px strokes, no fill, deliberately
// imperfect — a designer's notebook margin, not iconography.

export function SketchArrow({ className = "", size = 120 }: { className?: string; size?: number }) {
  return (
    <svg className={`sketch ${className}`} width={size} height={size * 0.6} viewBox="0 0 120 72" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 58c22-24 46-32 78-30 12 1 20 4 28 9" />
      <path d="M100 26c4 3 8 7 12 11-6 1-11 3-16 6" />
      <path d="M22 62c3-5 7-9 12-12" opacity=".55" />
    </svg>
  );
}

export function SketchStar({ className = "", size = 64 }: { className?: string; size?: number }) {
  return (
    <svg className={`sketch ${className}`} width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M32 8c1.6 8.4 4.2 15 9 21 6-1.4 12-1.9 18-1.6-6 3.4-11 7.6-15 12.6 2.6 6 4 12 4.4 18.4-5.4-4-11-7-17.2-9-5.6 3.4-11 7.4-16 12 1.2-6.6 3.2-12.8 6-18.6C15.4 39 10.4 34.6 5 31c6.2-.6 12.2-.2 18.2 1.2C26.4 24.6 29.2 16.6 32 8Z" />
      <path d="M12 12c2 1 3.6 2.6 5 4.6" opacity=".55" />
    </svg>
  );
}

export function SketchLoop({ className = "", size = 140 }: { className?: string; size?: number }) {
  return (
    <svg className={`sketch ${className}`} width={size} height={size * 0.5} viewBox="0 0 140 70" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
      <path d="M4 44c12-26 26-32 34-20 8 12-4 34 8 38 12 4 22-26 34-30 12-4 18 12 30 8 10-3 16-14 26-20" />
    </svg>
  );
}

export function SketchUnderline({ className = "", width = 220 }: { className?: string; width?: number }) {
  return (
    <svg className={`sketch ${className}`} width={width} height={14} viewBox="0 0 220 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 9c40-6 80-7 118-4 30 2 60 3 96-2" />
      <path d="M10 12c50-3 100-4 150-1" opacity=".45" />
    </svg>
  );
}

export function SketchCircle({ className = "", size = 90 }: { className?: string; size?: number }) {
  return (
    <svg className={`sketch ${className}`} width={size} height={size * 0.6} viewBox="0 0 90 54" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M46 6C22 4 6 12 6 27c0 16 24 24 46 21 22-3 34-14 32-25C82 12 66 5 46 6c-8 .4-14 2-18 5" />
    </svg>
  );
}
