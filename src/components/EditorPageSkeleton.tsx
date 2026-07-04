/**
 * Full-editor loading skeleton — mirrors EditorPage chrome (toolbar, asset
 * rail, preview stage, inspector, playback bar, timeline) so the surface
 * does not pop when the project finishes loading.
 *
 * Used by EditorPage while persistence.loading is true.
 */

const PULSE = 'animate-pulse motion-reduce:animate-none motion-reduce:opacity-90'

export function EditorPageSkeleton({ label = 'Opening project' }: { label?: string }) {
  return (
    <div
      className="h-screen flex flex-col bg-background select-none overflow-hidden"
      aria-busy="true"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {label}
      </span>

      {/* ── Toolbar (mirrors EditorToolbar h-12) ── */}
      <div className="flex items-center gap-2 h-12 px-3 border-b border-border/60 bg-background/95 backdrop-blur-md shrink-0">
        <SkeletonBlock className={`h-6 w-16 ${PULSE}`} />
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <SkeletonBlock className={`h-6 w-40 ${PULSE}`} />
        <div className="flex-1" />
        <SkeletonBlock className={`h-7 w-7 rounded-md ${PULSE} [animation-delay:120ms]`} />
        <SkeletonBlock className={`h-7 w-7 rounded-md ${PULSE} [animation-delay:160ms]`} />
        <div className="mx-1 h-5 w-px bg-border" aria-hidden />
        <SkeletonBlock className={`h-7 w-20 rounded-md ${PULSE} [animation-delay:200ms]`} />
      </div>

      {/* ── Desktop layout ── */}
      <div className="flex-1 min-h-0 hidden md:flex flex-col">
        {/* Main area: asset rail | preview | inspector */}
        <div className="flex-[0.65] min-h-0 flex">
          <AssetRailSkeleton />
          <div className="w-px bg-border/60 shrink-0" aria-hidden />
          <PreviewStageSkeleton />
          <div className="w-px bg-border/60 shrink-0" aria-hidden />
          <InspectorRailSkeleton />
        </div>

        <div className="h-px bg-border/60 shrink-0" aria-hidden />

        {/* Timeline panel: playback bar + tracks */}
        <div className="flex-[0.35] min-h-0 flex flex-col">
          <PlaybackBarSkeleton />
          <TimelineSkeleton />
        </div>
      </div>

      {/* ── Mobile layout ── */}
      <div className="flex-1 min-h-0 flex flex-col md:hidden">
        <div className="flex-[2] min-h-0">
          <PreviewStageSkeleton compact />
        </div>
        <PlaybackBarSkeleton />
        <div className="flex-[1.5] min-h-0 border-t border-border">
          <TimelineSkeleton compact />
        </div>
        <div className="flex-[1.5] min-h-0 border-t border-border bg-card">
          <InspectorRailSkeleton mobile />
        </div>
      </div>

      {/* Bottom-left status pill, calm and non-shouty */}
      <div className="pointer-events-none absolute bottom-3 left-3 hidden md:flex items-center gap-2 text-xs text-muted-foreground/80">
        <span
          className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/40 animate-pulse motion-reduce:animate-none"
          aria-hidden
        />
        <span aria-hidden>{label}</span>
      </div>
    </div>
  )
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`rounded-sm bg-muted/55 ${className}`} />
}

function AssetRailSkeleton() {
  return (
    <div className="hidden md:flex w-[280px] shrink-0 bg-card">
      {/* Vertical icon rail */}
      <div className="flex flex-col items-center gap-2 py-3 w-12 border-r border-border/60">
        {[0, 60, 120, 180].map((delay) => (
          <SkeletonBlock
            key={delay}
            className={`h-7 w-7 rounded-md ${PULSE}`}
          />
        ))}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0 flex flex-col p-3 gap-3">
        <SkeletonBlock className={`h-5 w-24 ${PULSE}`} />
        <SkeletonBlock className={`h-8 w-full rounded-md ${PULSE} [animation-delay:80ms]`} />

        {/* Asset thumbnail grid (2 cols × 3 rows) */}
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[0, 90, 180, 60, 150, 30].map((delay, i) => (
            <div
              key={i}
              aria-hidden
              className={`aspect-[3/4] w-full rounded-md bg-muted/50 ${PULSE}`}
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function PreviewStageSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex-1 min-w-0 bg-editor-stage relative flex items-center justify-center overflow-hidden">
      {/* 9:16 frame outline — the focal point users expect */}
      <div
        aria-hidden
        className={`relative ${compact ? 'h-[78%]' : 'h-[82%]'} aspect-[9/16] rounded-xl border border-white/8 bg-black/40 overflow-hidden shadow-[0_30px_60px_-30px_rgba(0,0,0,0.6)]`}
      >
        {/* Subtle diagonal shimmer sweep */}
        <div
          className="absolute inset-0 motion-reduce:hidden"
          style={{
            background:
              'linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.05) 50%, transparent 70%)',
            backgroundSize: '220% 100%',
            animation: 'editor-skeleton-sweep 2.4s linear infinite',
          }}
        />
        {/* Center mark — almost invisible, just enough to seat the eye */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-10 w-10 rounded-full border border-white/10" aria-hidden />
        </div>
      </div>

      {/* Local keyframes — scoped via <style> so we don't touch globals.css */}
      <style>{`
        @keyframes editor-skeleton-sweep {
          0%   { background-position: 100% 0; }
          100% { background-position: -100% 0; }
        }
      `}</style>
    </div>
  )
}

function InspectorRailSkeleton({ mobile = false }: { mobile?: boolean }) {
  return (
    <div className={`${mobile ? 'w-full' : 'w-[300px] shrink-0'} bg-card flex flex-col p-4 gap-4`}>
      <SkeletonBlock className={`h-5 w-28 ${PULSE}`} />

      {/* Property group */}
      <div className="flex flex-col gap-2">
        <SkeletonBlock className={`h-3 w-20 ${PULSE}`} />
        <SkeletonBlock className={`h-9 w-full rounded-md ${PULSE} [animation-delay:60ms]`} />
      </div>

      {/* Two-up numeric inputs (e.g. X / Y) */}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className={`h-3 w-8 ${PULSE}`} />
          <SkeletonBlock className={`h-9 rounded-md ${PULSE} [animation-delay:90ms]`} />
        </div>
        <div className="flex flex-col gap-1.5">
          <SkeletonBlock className={`h-3 w-8 ${PULSE}`} />
          <SkeletonBlock className={`h-9 rounded-md ${PULSE} [animation-delay:120ms]`} />
        </div>
      </div>

      {/* Slider stub */}
      <div className="flex flex-col gap-2 mt-1">
        <div className="flex items-center justify-between">
          <SkeletonBlock className={`h-3 w-16 ${PULSE}`} />
          <SkeletonBlock className={`h-3 w-8 ${PULSE} [animation-delay:140ms]`} />
        </div>
        <div className="relative h-1.5 w-full rounded-full bg-muted/40">
          <div
            className={`h-full w-2/5 rounded-full bg-muted-foreground/30 ${PULSE} [animation-delay:160ms]`}
            aria-hidden
          />
        </div>
      </div>

      {/* Color/preset row */}
      <div className="flex items-center gap-2 mt-1">
        {[0, 80, 160, 240, 320].map((delay) => (
          <SkeletonBlock
            key={delay}
            className={`h-7 w-7 rounded-full ${PULSE}`}
          />
        ))}
      </div>
    </div>
  )
}

function PlaybackBarSkeleton() {
  return (
    <div className="flex items-center gap-2 h-12 px-3 border-b border-border/60 bg-background/95 backdrop-blur-md shrink-0">
      {/* Tool cluster */}
      <div className="hidden md:flex items-center gap-1">
        {[0, 40, 80, 120].map((delay) => (
          <SkeletonBlock
            key={delay}
            className={`h-7 w-7 rounded-md ${PULSE}`}
          />
        ))}
      </div>
      <div className="hidden md:block mx-1 h-5 w-px bg-border" aria-hidden />

      {/* Transport */}
      <div className="flex items-center gap-1">
        <SkeletonBlock className={`h-7 w-7 rounded-full ${PULSE} [animation-delay:60ms]`} />
        <SkeletonBlock className={`h-8 w-8 rounded-full ${PULSE} [animation-delay:100ms]`} />
        <SkeletonBlock className={`h-7 w-7 rounded-full ${PULSE} [animation-delay:140ms]`} />
      </div>

      {/* Timecode pill */}
      <SkeletonBlock className={`mx-2 h-6 w-24 rounded-md ${PULSE} [animation-delay:180ms]`} />

      <div className="flex-1" />

      {/* Zoom cluster */}
      <div className="hidden md:flex items-center gap-1">
        <SkeletonBlock className={`h-7 w-7 rounded-md ${PULSE} [animation-delay:200ms]`} />
        <SkeletonBlock className={`h-1.5 w-24 rounded-full ${PULSE} [animation-delay:220ms]`} />
        <SkeletonBlock className={`h-7 w-7 rounded-md ${PULSE} [animation-delay:240ms]`} />
      </div>
    </div>
  )
}

function TimelineSkeleton({ compact = false }: { compact?: boolean }) {
  // Three tracks: video, audio, captions — each with a couple of clip silhouettes.
  const tracks: Array<{ clips: Array<{ x: string; w: string; delay: number }>; tone: string }> = [
    {
      tone: 'bg-muted/55',
      clips: [
        { x: 'left-[4%]', w: 'w-[32%]', delay: 0 },
        { x: 'left-[40%]', w: 'w-[22%]', delay: 120 },
        { x: 'left-[66%]', w: 'w-[28%]', delay: 240 },
      ],
    },
    {
      tone: 'bg-muted/45',
      clips: [
        { x: 'left-[8%]', w: 'w-[48%]', delay: 60 },
        { x: 'left-[60%]', w: 'w-[34%]', delay: 180 },
      ],
    },
    {
      tone: 'bg-muted/40',
      clips: [
        { x: 'left-[12%]', w: 'w-[18%]', delay: 90 },
        { x: 'left-[34%]', w: 'w-[14%]', delay: 150 },
        { x: 'left-[52%]', w: 'w-[22%]', delay: 210 },
      ],
    },
  ]

  const trackHeight = compact ? 'h-10' : 'h-12'

  return (
    <div className="flex-1 min-h-0 bg-background overflow-hidden">
      {/* Ruler */}
      <div className="h-6 border-b border-border/60 flex items-end px-3 gap-6">
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            aria-hidden
            className="h-2 w-px bg-muted-foreground/30"
          />
        ))}
      </div>

      {/* Track rows */}
      <div className="flex flex-col">
        {tracks.map((track, ti) => (
          <div
            key={ti}
            className={`relative flex items-center ${trackHeight} border-b border-border/40`}
          >
            {/* Track header */}
            <div className="w-32 shrink-0 flex items-center gap-2 px-3 border-r border-border/60 h-full">
              <SkeletonBlock className={`h-4 w-4 rounded ${PULSE}`} />
              <SkeletonBlock className={`h-3 w-16 ${PULSE} [animation-delay:80ms]`} />
            </div>

            {/* Clip lane */}
            <div className="relative flex-1 h-full">
              {track.clips.map((clip, ci) => (
                <div
                  key={ci}
                  aria-hidden
                  className={`absolute top-1/2 -translate-y-1/2 h-[70%] rounded-md ${clip.x} ${clip.w} ${track.tone} ${PULSE}`}
                  style={{ animationDelay: `${clip.delay}ms` }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
