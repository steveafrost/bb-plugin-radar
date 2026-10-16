// Inline lucide-style glyphs: bb's host icon set is curated, so plugin-specific
// icons are drawn here instead of resolved by name.
const PATHS: Record<string, string[]> = {
  pr: ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9v3a3 3 0 0 1-3 3H6"],
  issue: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"],
  refresh: ["M21 12a9 9 0 1 1-9-9c2.5 0 4.9 1 6.7 2.7L21 8", "M21 3v5h-5"],
  up: ["m5 12 7-7 7 7", "M12 19V5"],
  down: ["M12 5v14", "m19 12-7 7-7-7"],
  edit: ["M12 20h9", "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M19 6l-1 14H6L5 6"],
  seen: ["M18 6 7 17l-5-5", "m22 10-7.5 7.5L13 16"],
  // lucide sparkles (same glyph as Pulse).
  sparkles: [
    "M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z",
    "M20 3v4", "M22 5h-4", "M4 17v2", "M5 18H3",
  ],
  spinner: ["M21 12a9 9 0 1 1-6.2-8.6"],
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 18 6-6-6-6"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"],
  eyeOff: ["M9.9 4.2A10.4 10.4 0 0 1 12 4c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2", "M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6", "M9.9 9.9a3 3 0 0 0 4.2 4.2", "m2 2 20 20"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  // lucide bot: start an agent thread (same glyph as Pulse).
  bot: ["M12 8V4H8", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2", "M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z"],
  // lucide external-link: open the thread already started.
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  // lucide git-pull-request-arrow: rebase onto base.
  rebase: ["M5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M5 9v12", "M19 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "m15 9-3-3 3-3", "M12 6h5a2 2 0 0 1 2 2v7"],
  scope: ["M22 3H2l8 9.5V19l4 2v-8.5z"],
  // lucide scan-eye: the Reviews view.
  review: [
    "M3 7V5a2 2 0 0 1 2-2h2",
    "M17 3h2a2 2 0 0 1 2 2v2",
    "M21 17v2a2 2 0 0 1-2 2h-2",
    "M7 21H5a2 2 0 0 1-2-2v-2",
    "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
    "M18.9 12.3a1 1 0 0 0 0-.7 7.5 7.5 0 0 0-13.8 0 1 1 0 0 0 0 .7 7.5 7.5 0 0 0 13.8 0",
  ],
  // lucide layers: the All view.
  stack: [
    "M12.8 2.2a2 2 0 0 0-1.7 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.7 0l8.6-3.9a1 1 0 0 0 0-1.8z",
    "M2 12a1 1 0 0 0 .6.9l8.6 3.9a2 2 0 0 0 1.7 0l8.5-3.9A1 1 0 0 0 22 12",
    "M2 17a1 1 0 0 0 .6.9l8.6 3.9a2 2 0 0 0 1.7 0l8.5-3.9A1 1 0 0 0 22 17",
  ],
  // Seated figure, legs crossed, hands on knees: Focus.
  zen: [
    "M12 7a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z",
    "M8 10.5c1-1 2.4-1.5 4-1.5s3 .5 4 1.5l1.5 4.5",
    "M8 10.5 6.5 15",
    "M6.5 15c1.6 1 3.5 1.4 5.5 1.4s3.9-.4 5.5-1.4",
    "M3 19.5c2.5-1.6 5.8-2.4 9-2.4s6.5.8 9 2.4c-2.5 1.2-5.8 1.6-9 1.6s-6.5-.4-9-1.6z",
  ],
};

export type GlyphName = keyof typeof PATHS;

/**
 * Optical sizing for glyphs shown side by side (the view tabs): each drawing is scaled about
 * its own ink centre so they read as one size, with stroke weight held constant. Geometric
 * extents differ a lot (sparkles ~16x14, stack ~20x20), and open or round shapes read smaller.
 */
const OPTICAL: Partial<Record<string, { scale: number; cx: number; cy: number }>> = {
  stack: { scale: 0.86, cx: 12, cy: 12 },
  issue: { scale: 1.04, cx: 12, cy: 12 },
  pr: { scale: 1.06, cx: 12, cy: 12 },
  review: { scale: 1.0, cx: 12, cy: 12 },
  sparkles: { scale: 0.96, cx: 12, cy: 12 },
  zen: { scale: 1.02, cx: 12, cy: 11.85 },
};

export function Glyph({ name, className, optical = false }: { name: GlyphName; className?: string; optical?: boolean }) {
  const o = optical ? OPTICAL[name] : undefined;
  const size = 24 / (o?.scale ?? 1);
  const viewBox = o === undefined ? "0 0 24 24" : `${o.cx - size / 2} ${o.cy - size / 2} ${size} ${size}`;
  return (
    <svg
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={2 / (o?.scale ?? 1)}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]!.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
