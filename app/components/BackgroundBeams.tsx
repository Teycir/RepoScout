'use client';
// app/components/BackgroundBeams.tsx
// Ambient animated SVG beam lines behind the dashboard — ported from ArxivExplorer.
// Renders as a fixed full-viewport layer; entirely CSS-driven, zero JS after mount.

export function BackgroundBeams({ className = '' }: { className?: string }) {
  // 12 beam lines radiating from a point above the viewport centre
  const beams = Array.from({ length: 12 }, (_, i) => {
    const angle   = -60 + i * 11;                    // -60° … +71°
    const opacity = 0.03 + (i % 3) * 0.015;          // 0.030 – 0.060
    const dur     = 6 + (i % 4) * 2;                 // 6 – 12 s
    const delay   = -(i * 1.1);                       // stagger
    return { angle, opacity, dur, delay };
  });

  return (
    <div
      className={`fixed inset-0 pointer-events-none overflow-hidden z-0 ${className}`}
      aria-hidden="true"
    >
      <svg
        className="absolute w-full h-full"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {beams.map((b, i) => (
            <linearGradient
              key={i}
              id={`beam-grad-${i}`}
              x1="0%" y1="0%" x2="0%" y2="100%"
            >
              <stop offset="0%"   stopColor="#ff1a1a" stopOpacity="0" />
              <stop offset="40%"  stopColor="#ff1a1a" stopOpacity={b.opacity} />
              <stop offset="100%" stopColor="#ff1a1a" stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {beams.map((b, i) => {
          const cx  = 720;   // origin X (centre of viewport)
          const cy  = -120;  // origin Y (above viewport)
          const rad = (b.angle * Math.PI) / 180;
          const len = 1400;
          const x2  = cx + Math.sin(rad) * len;
          const y2  = cy + Math.cos(rad) * len;

          return (
            <line
              key={i}
              x1={cx} y1={cy} x2={x2} y2={y2}
              stroke={`url(#beam-grad-${i})`}
              strokeWidth="1"
              style={{
                animationName:     'beamPulse',
                animationDuration:  `${b.dur}s`,
                animationDelay:     `${b.delay}s`,
                animationTimingFunction: 'ease-in-out',
                animationIterationCount: 'infinite',
              }}
            />
          );
        })}
      </svg>

      <style>{`
        @keyframes beamPulse {
          0%, 100% { opacity: 0.4; }
          50%       { opacity: 1;   }
        }
      `}</style>
    </div>
  );
}
