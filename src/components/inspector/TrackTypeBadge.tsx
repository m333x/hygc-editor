/**
 * A small badge indicating the clip's track type.
 *
 * Helps the user quickly identify whether they're editing a video, audio, or
 * caption clip, since the available properties differ between types. The
 * coloured dot matches the clip's color in the timeline (via the `--clip-*-bg`
 * tokens), but the pill itself uses neutral theme-aware tokens — the clip
 * fg/bg tokens are designed for the dark editor-chrome rail and produced
 * near-white text on a pastel pill in light mode.
 */
const TRACK_TYPE_DOT: Record<string, string> = {
  video: 'bg-clip-video-bg',
  audio: 'bg-clip-audio-bg',
  caption: 'bg-clip-caption-bg',
  clip_audio: 'bg-clip-clipaudio-bg',
}

export function TrackTypeBadge({ type }: { type: string }) {
  const dot = TRACK_TYPE_DOT[type] ?? 'bg-muted-foreground'
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground uppercase tracking-wide">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden />
      {type}
    </span>
  )
}
