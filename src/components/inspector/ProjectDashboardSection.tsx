import { useState, useRef, useEffect, useMemo } from 'react'
import { useParams } from 'react-router'
import { Volume2, VolumeX } from 'lucide-react'

import { useEditorStore } from '../../store/editor-store'
import { useUIStore } from '../../store/ui-store'
import { useCaptionGeneration } from '../../hooks/useCaptionGeneration'
import { computeCompositionDuration } from '../../engine/composition-utils'
import type { Track } from '../../types'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'

/**
 * Format an ms duration as a friendly summary string.
 *   0–59.9s   → "27s"
 *   60s+      → "1:24"
 *   60min+    → "1:02:14"
 *
 * Distinct from `formatTime` in usePlayback (MM:SS.mmm) — that's playhead
 * precision; this is dashboard skim-readable.
 */
function formatDurationShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`
  const hours = Math.floor(minutes / 60)
  const remMinutes = minutes % 60
  return `${hours}:${String(remMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

interface ProjectStats {
  /** Total composition duration in ms (max of content end vs. configured min). */
  totalDurationMs: number
  /** Number of clips on `type === 'video'` tracks. */
  videoClipCount: number
  /** Number of clips on `type === 'audio'` tracks labelled like voiceover. */
  voiceClipCount: number
  /** Number of clips on `type === 'audio'` tracks that are music (everything else). */
  musicClipCount: number
  /** Number of clips on `type === 'caption'` tracks. */
  captionClipCount: number
  /** True when no clips of any kind exist on the timeline. */
  isEmpty: boolean
  /** True when there is at least one video clip but zero caption clips. */
  videoMissingCaptions: boolean
}

/**
 * Derive at-a-glance project stats from the current tracks.
 *
 * Voice vs. music split: both live on `type === 'audio'` tracks, so we use a
 * label heuristic. Anything matching /voice|vo|narrat|dialog/i counts as
 * voice; the rest counts as music. The default tracks (`Voiceover` / `Music`)
 * both match this heuristic cleanly.
 */
function computeProjectStats(tracks: Track[], compositionMinMs: number): ProjectStats {
  let videoClipCount = 0
  let voiceClipCount = 0
  let musicClipCount = 0
  let captionClipCount = 0

  for (const track of tracks) {
    const count = track.clips.length
    if (count === 0) continue
    if (track.type === 'video') videoClipCount += count
    else if (track.type === 'caption') captionClipCount += count
    else if (track.type === 'audio') {
      if (/voice|vo\b|narrat|dialog/i.test(track.label)) voiceClipCount += count
      else musicClipCount += count
    }
  }

  const totalDurationMs = computeCompositionDuration(tracks, {
    width: 0,
    height: 0,
    fps: 30,
    durationMs: compositionMinMs,
  })

  const isEmpty =
    videoClipCount === 0 &&
    voiceClipCount === 0 &&
    musicClipCount === 0 &&
    captionClipCount === 0

  return {
    totalDurationMs,
    videoClipCount,
    voiceClipCount,
    musicClipCount,
    captionClipCount,
    isEmpty,
    videoMissingCaptions: videoClipCount > 0 && captionClipCount === 0,
  }
}

/** Pluralise "clip" without bringing in i18n for one word. */
function pluralClips(n: number): string {
  return n === 1 ? 'clip' : 'clips'
}

/**
 * A single tile in the stats grid. Dot color matches the track-type token
 * already used in the timeline + TrackTypeBadge so the dashboard reads as
 * "the same project, summarised."
 */
function StatTile({
  label,
  value,
  sub,
  dotClass,
  muted,
}: {
  label: string
  value: string
  sub?: string
  dotClass?: string
  /** Render the tile in a low-emphasis state — used for zero counts. */
  muted?: boolean
}) {
  return (
    <div
      className={`rounded-md border border-border bg-background/60 px-2.5 py-2 ${
        muted ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-1.5 mb-0.5">
        {dotClass && <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden />}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm font-semibold text-foreground tabular-nums leading-none">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
    </div>
  )
}

/**
 * Aspect-ratio presets surfaced in the Composition picker.
 *
 * `id` is the rendered toggle label. The first three (9:16 / 1:1 / 16:9) live
 * inline — they cover ~95% of DTC-ad workflows (Reels/TikTok/Shorts, IG feed
 * square, YouTube landscape). The rest live behind the "More" popover so the
 * inline row stays scannable.
 *
 * Widths are normalised to 1080 (or 1920 for landscape) — the values most
 * closely match the source media DTC operators tend to start from.
 */
interface AspectPreset {
  id: string
  width: number
  height: number
  /** Human-readable platform hint used as the popover sub-label. */
  hint?: string
}

const ASPECT_PRESETS_INLINE: AspectPreset[] = [
  { id: '9:16', width: 1080, height: 1920, hint: 'Reels · TikTok · Shorts' },
  { id: '1:1', width: 1080, height: 1080, hint: 'Instagram feed' },
  { id: '16:9', width: 1920, height: 1080, hint: 'YouTube · landscape' },
]

const ASPECT_PRESETS_MORE: AspectPreset[] = [
  { id: '4:5', width: 1080, height: 1350, hint: 'Instagram portrait' },
  { id: '2:3', width: 1080, height: 1620, hint: 'Pinterest · vertical' },
  { id: '4:3', width: 1440, height: 1080, hint: 'Classic landscape' },
]

const ASPECT_MATCH_TOLERANCE = 0.01

/**
 * FPS presets surfaced in the Composition picker.
 *
 * Inline row covers the three values that account for ~95% of vertical-ad
 * workflows: 24 (cinematic), 30 (web/social default), 60 (smooth motion).
 * 25 (PAL) and 50 (PAL high) live behind the "More" popover for the European
 * broadcast crowd without crowding the inline segment.
 */
const FPS_PRESETS_INLINE: number[] = [24, 30, 60]
const FPS_PRESETS_MORE: { value: number; hint: string }[] = [
  { value: 25, hint: 'PAL · broadcast' },
  { value: 50, hint: 'PAL · smooth' },
]

/** Identify the active preset for the current composition, if any matches. */
function findActiveAspect(width: number, height: number): AspectPreset | null {
  const ratio = width / height
  const all = [...ASPECT_PRESETS_INLINE, ...ASPECT_PRESETS_MORE]
  for (const preset of all) {
    if (Math.abs(preset.width / preset.height - ratio) <= ASPECT_MATCH_TOLERANCE) {
      return preset
    }
  }
  return null
}

export interface ProjectDashboardSectionProps {
  projectTitle?: string | null
  onProjectTitleChange?: (title: string) => void | Promise<void>
}

/**
 * ProjectDashboardSection — shown in the Inspector when no clip is selected.
 *
 * Replaces the previous "Project Settings" empty state, which was four small,
 * equally-weighted widgets and an apologetic paragraph. The dashboard reframes
 * the panel as a value-add surface — the project at a glance — so deselecting
 * a clip is informative rather than a step backward.
 *
 * Surfaces (top to bottom):
 *   1. Editable project name (anchor) + total duration sub-label.
 *   2. Stat grid: duration / video / voice / music / captions, dot-coded to
 *      the timeline track colours so the readout is "the same project".
 *   3. Issue strip (conditional): only renders when there's a truthful, useful
 *      thing to say. Currently: empty project, or video-without-captions.
 *   4. Settings cluster (Composition readout, Captions pointer, Master
 *      volume) — kept for now, visually demoted under a "Project settings"
 *      label. These three are slated for their own redesigns (#2, #3, #5).
 *
 * No invented metrics — every number/warning maps to current store state.
 */
export function ProjectDashboardSection({
  projectTitle,
  onProjectTitleChange,
}: ProjectDashboardSectionProps) {
  const tracks = useEditorStore((s) => s.tracks)
  const composition = useEditorStore((s) => s.composition)
  const globalAudioVolume = useEditorStore((s) => s.globalAudioVolume)
  const setGlobalAudioVolume = useEditorStore((s) => s.setGlobalAudioVolume)
  const setCompositionSize = useEditorStore((s) => s.setCompositionSize)
  const setCompositionFps = useEditorStore((s) => s.setCompositionFps)
  const setAssetTab = useUIStore((s) => s.setAssetTab)

  const activeAspect = useMemo(
    () => findActiveAspect(composition.width, composition.height),
    [composition.width, composition.height],
  )

  // Caption generation is wired here so the dashboard can offer "Auto-caption
  // from voiceover →" as a primary action when the project has voice but no
  // captions. Reads projectId from the route so callers don't need to thread it
  // through — matches how MobileBottomSheet already grabs it.
  const { projectId } = useParams<{ projectId: string }>()
  const captionGen = useCaptionGeneration(projectId)

  // Remember the last non-zero master volume so the speaker-icon mute toggle
  // can restore it. Ref (not state) — we don't need a re-render when it changes.
  const lastNonZeroVolumeRef = useRef(globalAudioVolume > 0 ? globalAudioVolume : 1)
  useEffect(() => {
    if (globalAudioVolume > 0) lastNonZeroVolumeRef.current = globalAudioVolume
  }, [globalAudioVolume])

  const stats = useMemo(
    () => computeProjectStats(tracks, composition.durationMs),
    [tracks, composition.durationMs],
  )

  const projectTitleValue = projectTitle ?? ''
  const [nameDraft, setNameDraft] = useState(() => ({
    source: projectTitleValue,
    value: projectTitleValue,
  }))
  const nameInput = nameDraft.source === projectTitleValue ? nameDraft.value : projectTitleValue

  const handleNameBlur = () => {
    if (onProjectTitleChange && nameInput.trim() !== (projectTitle ?? '').trim()) {
      onProjectTitleChange(nameInput.trim() || 'Untitled')
    }
  }

  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  return (
    <div className="p-3 space-y-4">
      {/* ── Project anchor: name + duration ─────────────────────────────── */}
      <div>
        {onProjectTitleChange != null ? (
          <input
            type="text"
            value={nameInput}
            onChange={(e) => setNameDraft({ source: projectTitleValue, value: e.target.value })}
            onBlur={handleNameBlur}
            onKeyDown={handleNameKeyDown}
            placeholder="Untitled"
            maxLength={100}
            className="w-full bg-transparent rounded px-1 -mx-1 py-0.5 text-sm font-semibold text-foreground border border-transparent hover:border-border focus:outline-none focus:border-primary focus:bg-muted placeholder:text-muted-foreground"
            aria-label="Project name"
          />
        ) : (
          <p className="text-sm font-semibold text-foreground px-1 -mx-1 py-0.5 truncate">
            {projectTitle || 'Untitled'}
          </p>
        )}
        <p className="text-[11px] text-muted-foreground mt-0.5 px-1 -mx-1 tabular-nums">
          {formatDurationShort(stats.totalDurationMs)} ·{' '}
          {composition.width}×{composition.height} · {composition.fps}fps
        </p>
      </div>

      {/* ── Stats grid ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-1.5">
        <StatTile
          label="Video"
          value={String(stats.videoClipCount)}
          sub={pluralClips(stats.videoClipCount)}
          dotClass="bg-clip-video-bg"
          muted={stats.videoClipCount === 0}
        />
        <StatTile
          label="Captions"
          value={String(stats.captionClipCount)}
          sub={pluralClips(stats.captionClipCount)}
          dotClass="bg-clip-caption-bg"
          muted={stats.captionClipCount === 0}
        />
        <StatTile
          label="Voice"
          value={String(stats.voiceClipCount)}
          sub={pluralClips(stats.voiceClipCount)}
          dotClass="bg-clip-audio-bg"
          muted={stats.voiceClipCount === 0}
        />
        <StatTile
          label="Music"
          value={String(stats.musicClipCount)}
          sub={pluralClips(stats.musicClipCount)}
          dotClass="bg-clip-audio-bg"
          muted={stats.musicClipCount === 0}
        />
      </div>

      {/* ── Issues (only when truthful) ─────────────────────────────────── */}
      {stats.isEmpty && (
        <div className="rounded-md border border-dashed border-border bg-muted/40 px-3 py-2.5">
          <p className="text-[11px] font-medium text-foreground">Empty project</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            Drop a clip onto the timeline, or open the AI Generate tab to create one.
          </p>
        </div>
      )}

      {!stats.isEmpty && stats.videoMissingCaptions && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2">
          <p className="text-[11px] font-medium text-foreground">No captions yet</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
            Your video has {stats.videoClipCount} {pluralClips(stats.videoClipCount)} but no captions.
          </p>
        </div>
      )}

      {/* ── Project settings (legacy cluster — visually demoted) ─────────
          Composition / Captions pointer / Master volume kept here to preserve
          access; each is redesigned in follow-up passes (#2 composition
          presets, #3 captions action, #5 master volume placement). */}
      <div className="pt-3 border-t border-border space-y-3">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          Project settings
        </p>

        {/* Composition picker — replaces the prior read-only WxH/fps print.
            Three common aspects sit inline as a segmented toggle; everything
            else lives in a "More" popover so the segment stays scannable.
            Aspect changes push history so accidental flips are one Cmd-Z away. */}
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">Composition</span>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`
                    text-[10px] transition-colors flex items-center gap-0.5
                    ${activeAspect && !ASPECT_PRESETS_INLINE.some((p) => p.id === activeAspect.id)
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'}
                  `}
                  aria-label="More aspect ratios"
                  title="More aspect ratios"
                >
                  {activeAspect && !ASPECT_PRESETS_INLINE.some((p) => p.id === activeAspect.id)
                    ? activeAspect.id
                    : 'More'}
                  <span aria-hidden className="text-[8px]">▾</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" className="w-56 p-1">
                {ASPECT_PRESETS_MORE.map((preset) => {
                  const active = activeAspect?.id === preset.id
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setCompositionSize(preset.width, preset.height)}
                      className={`
                        w-full text-left px-2 py-1.5 rounded text-[11px] flex items-baseline justify-between gap-2
                        ${active ? 'bg-primary/15 text-foreground' : 'hover:bg-muted text-foreground'}
                      `}
                    >
                      <span className="font-medium tabular-nums">{preset.id}</span>
                      {preset.hint && (
                        <span className="text-[10px] text-muted-foreground truncate">{preset.hint}</span>
                      )}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          </div>
          <ToggleGroup
            type="single"
            value={
              activeAspect && ASPECT_PRESETS_INLINE.some((p) => p.id === activeAspect.id)
                ? activeAspect.id
                : ''
            }
            onValueChange={(val) => {
              if (!val) return
              const preset = ASPECT_PRESETS_INLINE.find((p) => p.id === val)
              if (preset) setCompositionSize(preset.width, preset.height)
            }}
            size="sm"
            variant="outline"
            className="grid grid-cols-3 mt-1 w-full"
            aria-label="Aspect ratio"
          >
            {ASPECT_PRESETS_INLINE.map((preset) => (
              <ToggleGroupItem
                key={preset.id}
                value={preset.id}
                className="text-[10px] font-medium tabular-nums"
                title={preset.hint}
              >
                {preset.id}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="text-[10px] text-muted-foreground tabular-nums mt-1">
            {composition.width} × {composition.height}
            {activeAspect?.hint && (
              <span className="text-muted-foreground/70"> · {activeAspect.hint}</span>
            )}
          </div>

          {/* FPS picker — mirrors the aspect picker pattern. Inline segment
              for 24/30/60 (covers ~95% of social-ad workflows), popover for
              25/50 (PAL broadcast). FPS changes push history so an accidental
              flip is one Cmd-Z away — matches setCompositionSize. */}
          <div className="flex items-baseline justify-between gap-2 mt-3">
            <span className="text-[10px] text-muted-foreground">Framerate</span>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className={`
                    text-[10px] transition-colors flex items-center gap-0.5
                    ${!FPS_PRESETS_INLINE.includes(composition.fps)
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground'}
                  `}
                  aria-label="More framerates"
                  title="More framerates"
                >
                  {!FPS_PRESETS_INLINE.includes(composition.fps)
                    ? `${composition.fps} fps`
                    : 'More'}
                  <span aria-hidden className="text-[8px]">▾</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" side="bottom" className="w-56 p-1">
                {FPS_PRESETS_MORE.map((preset) => {
                  const active = composition.fps === preset.value
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setCompositionFps(preset.value)}
                      className={`
                        w-full text-left px-2 py-1.5 rounded text-[11px] flex items-baseline justify-between gap-2
                        ${active ? 'bg-primary/15 text-foreground' : 'hover:bg-muted text-foreground'}
                      `}
                    >
                      <span className="font-medium tabular-nums">{preset.value} fps</span>
                      <span className="text-[10px] text-muted-foreground truncate">{preset.hint}</span>
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          </div>
          <ToggleGroup
            type="single"
            value={
              FPS_PRESETS_INLINE.includes(composition.fps)
                ? String(composition.fps)
                : ''
            }
            onValueChange={(val) => {
              if (!val) return
              const next = Number(val)
              if (Number.isFinite(next)) setCompositionFps(next)
            }}
            size="sm"
            variant="outline"
            className="grid grid-cols-3 mt-1 w-full"
            aria-label="Framerate"
          >
            {FPS_PRESETS_INLINE.map((fps) => (
              <ToggleGroupItem
                key={fps}
                value={String(fps)}
                className="text-[10px] font-medium tabular-nums"
              >
                {fps}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* Captions — primary verb in three modes:
              • captions exist           → "Edit caption style →" (opens Captions tab)
              • voice present, no caps   → "Auto-caption from voiceover →" (triggers
                                            generation immediately with defaults)
              • neither present          → disabled hint "Add a voiceover to enable"
            The verb-first action replaces the prior pointer paragraph, which
            described where to go instead of taking the user there. */}
        <div>
          <span className="text-[10px] text-muted-foreground">Captions</span>
          {(() => {
            const hasCaptions = stats.captionClipCount > 0
            const canGenerate = captionGen.canGenerate
            const isGenerating = captionGen.isGenerating

            if (hasCaptions) {
              return (
                <button
                  type="button"
                  onClick={() => setAssetTab('captions')}
                  className="mt-1 w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[11px] font-medium border border-border bg-background text-foreground hover:bg-muted transition-colors"
                >
                  <span>Edit caption style</span>
                  <span aria-hidden className="text-muted-foreground">→</span>
                </button>
              )
            }

            if (canGenerate) {
              return (
                <>
                  <button
                    type="button"
                    onClick={() => void captionGen.generateCaptions()}
                    disabled={isGenerating}
                    className="mt-1 w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[11px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-progress"
                  >
                    <span>{isGenerating ? 'Generating captions…' : 'Auto-caption from voiceover'}</span>
                    {!isGenerating && <span aria-hidden>→</span>}
                  </button>
                  {captionGen.error && (
                    <p className="mt-1 text-[10px] text-destructive leading-relaxed">
                      {captionGen.error}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={() => setAssetTab('captions')}
                    className="mt-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                  >
                    Or tune options in the Captions tab
                  </button>
                </>
              )
            }

            return (
              <button
                type="button"
                onClick={() => setAssetTab('my-assets')}
                className="mt-1 w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[11px] border border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
                title="Auto-captions need at least one voiceover clip on the timeline"
              >
                <span>Add a voiceover to enable captions</span>
                <span aria-hidden>→</span>
              </button>
            )
          })()}
        </div>

        {/* Master volume — demoted to a single-line speaker control.
            The speaker icon doubles as the label (it's universally understood
            for "volume") and as a mute toggle, dropping the ~50px labelled
            section down to a ~24px row that doesn't compete with the
            dashboard above. Premium-CapCut positioning: a 30s product ad
            doesn't need a mixer; "loud / quiet" plus mute is enough here.
            A real per-track mixer is out of scope until tracks gain a
            `volume` field. */}
        <div className="flex items-center gap-2" title="Master volume">
          <button
            type="button"
            onClick={() => {
              if (globalAudioVolume > 0) {
                lastNonZeroVolumeRef.current = globalAudioVolume
                setGlobalAudioVolume(0)
              } else {
                setGlobalAudioVolume(lastNonZeroVolumeRef.current || 1)
              }
            }}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label={globalAudioVolume === 0 ? 'Unmute' : 'Mute'}
          >
            {globalAudioVolume === 0 ? (
              <VolumeX className="w-3.5 h-3.5" />
            ) : (
              <Volume2 className="w-3.5 h-3.5" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={globalAudioVolume}
            onChange={(e) => setGlobalAudioVolume(Number(e.target.value))}
            className="flex-1 h-1.5 accent-ring"
            aria-label="Master volume"
          />
          <span className="text-[10px] tabular-nums text-muted-foreground w-9 text-right shrink-0">
            {Math.round(globalAudioVolume * 100)}%
          </span>
        </div>
      </div>
    </div>
  )
}
