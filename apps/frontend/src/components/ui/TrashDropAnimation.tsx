/*
 * Delete-success animation: the lid swings open, a crumpled paper is tossed in
 * along an arc, then the lid snaps shut with a small bounce and the can settles.
 * Pure SVG + CSS keyframes (see "Trash drop" in globals.css), ~1.2s total so it
 * finishes inside the 1.3s delete-success overlays. Reduced-motion users get the
 * closed can with no movement.
 */
export default function TrashDropAnimation({
  className = 'bg-red-50 border-red-200',
  color = '#EF4444',
}: {
  /** Background/border classes for the circle behind the can. */
  className?: string;
  /** Can color. */
  color?: string;
}) {
  return (
    <div
      className={`trash-drop w-16 h-16 rounded-full border flex items-center justify-center ${className}`}
      role="img"
      aria-label="Deleted"
    >
      <svg viewBox="0 0 64 64" className="w-12 h-12 overflow-visible" aria-hidden>
        {/* Paper — drawn first so the can's body covers it as it drops in */}
        <g className="trash-drop-paper">
          <path
            d="M-4.5 -3.5 L-1 -5 L2.5 -4 L5 -1 L4 3 L1 5 L-3 4.5 L-5 1 Z M-2 -1.5 L1.5 0.5 M-1 2.5 L2 -2"
            fill="#94A3B8"
            stroke="#64748B"
            strokeWidth="1"
            strokeLinejoin="round"
          />
        </g>

        <g className="trash-drop-can">
          {/* Body */}
          <path d="M18 27 H46 L43.2 55 Q43 57 41 57 H23 Q21 57 20.8 55 Z" fill={color} />
          <path d="M26 32 V51 M32 32 V51 M38 32 V51" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity="0.9" />

          {/* Lid — hinged at its right end */}
          <g className="trash-drop-lid">
            <rect x="14" y="20" width="36" height="5" rx="2" fill={color} />
            <rect x="26.5" y="15" width="11" height="6.5" rx="2.5" fill="none" stroke={color} strokeWidth="2.6" />
          </g>
        </g>
      </svg>
    </div>
  );
}
