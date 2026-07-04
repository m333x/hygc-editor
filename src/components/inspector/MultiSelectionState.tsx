export function MultiSelectionState({ count, onDelete }: { count: number; onDelete: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-4 text-center">
      <svg
        width="36"
        height="36"
        viewBox="0 0 36 36"
        fill="none"
        aria-hidden
        className="text-muted-foreground/40"
      >
        <rect x="4" y="8" width="22" height="22" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="4" width="22" height="22" rx="3" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
      </svg>
      <div>
        <p className="text-xs font-medium text-foreground mb-1">
          {count} clips selected
        </p>
        <p className="text-[10px] text-muted-foreground mb-3">
          Select a single clip to edit its properties
        </p>
        <button
          onClick={onDelete}
          className="text-[11px] px-3 py-1 rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
        >
          Delete {count} clips
        </button>
      </div>
    </div>
  )
}
