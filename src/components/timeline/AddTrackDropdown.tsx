/**
 * AddTrackDropdown — "+ Add Track" button at the bottom of the track header column.
 *
 * Implemented with Radix DropdownMenu so focus, click-outside, ESC, and portal
 * stacking are handled correctly. The previous custom popover used an `onBlur`
 * close path that fired before the option's `onClick` could register, so the
 * button looked dead. Matches the look of the right-click menu in
 * `TimelineTrackContextMenu` for consistency.
 *
 * SOLID: SRP — only manages the "add track" interaction.
 *
 * @see PLAN.md Phase 3.4 '"Add Track" button at top of track headers'
 */

import { useState } from 'react'
import { AudioLines, Captions, Plus, Video, type LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu'
import type { TrackType } from '../../types'

export interface AddTrackDropdownProps {
  /** Delegated to the Zustand store's `addTrack` action by the parent. */
  onAddTrack: (label: string, type: TrackType) => void
}

interface TrackOption {
  type: TrackType
  defaultLabel: string
  description: string
  icon: LucideIcon
  /** Matches TRACK_TYPE_CONFIG dot colors so the picker reads as the clip. */
  dotClass: string
}

const TRACK_OPTIONS: TrackOption[] = [
  {
    type: 'video',
    defaultLabel: 'Video',
    description: 'Visual clips with transforms',
    icon: Video,
    dotClass: 'bg-clip-video-bg',
  },
  {
    type: 'audio',
    defaultLabel: 'Audio',
    description: 'Voiceover or music clips',
    icon: AudioLines,
    dotClass: 'bg-clip-audio-bg',
  },
  {
    type: 'caption',
    defaultLabel: 'Captions',
    description: 'Styled text overlays',
    icon: Captions,
    dotClass: 'bg-clip-caption-bg',
  },
]

export function AddTrackDropdown({ onAddTrack }: AddTrackDropdownProps) {
  const [open, setOpen] = useState(false)

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        className="
          w-full flex items-center gap-1.5 px-2 py-1.5
          text-[10px] text-muted-foreground hover:text-foreground
          hover:bg-muted/40 transition-colors rounded-sm
          outline-hidden focus-visible:ring-1 focus-visible:ring-ring
        "
        aria-label="Add a new track"
      >
        <Plus className="size-3" aria-hidden />
        <span>Add Track</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-52"
      >
        <DropdownMenuLabel className="text-[9px] text-muted-foreground uppercase tracking-wider py-1">
          Track type
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {TRACK_OPTIONS.map((opt) => {
          const Icon = opt.icon
          return (
            <DropdownMenuItem
              key={opt.type}
              onSelect={() => onAddTrack(opt.defaultLabel, opt.type)}
              className="gap-2.5"
            >
              <span className={`size-2 rounded-full shrink-0 ${opt.dotClass}`} aria-hidden />
              <Icon className="size-3.5 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium leading-tight">{opt.defaultLabel}</div>
                <div className="text-[10px] text-muted-foreground leading-tight">
                  {opt.description}
                </div>
              </div>
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * AddElementButton — small "+" inside a track lane (Phase 3.4 spec). Full asset
 * browser wiring lands in Phase 3.7; this is the visual entry point.
 */
export function AddElementButton({ trackLabel }: { trackLabel: string }) {
  const [showTip, setShowTip] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setShowTip((s) => !s)}
        onBlur={() => setShowTip(false)}
        className="
          flex items-center gap-1 px-2 py-1
          text-[9px] text-muted-foreground/60 hover:text-foreground
          hover:bg-muted/30 rounded transition-colors
        "
        title={`Add clip to ${trackLabel}`}
        aria-label={`Add element to ${trackLabel} track`}
      >
        <Plus className="size-2" aria-hidden />
        Add
      </button>

      {showTip && (
        <div
          className="
            absolute left-0 top-full mt-1 z-50
            w-44 rounded-md border border-border
            bg-popover p-2 shadow-md
          "
          role="tooltip"
        >
          <p className="text-[10px] text-foreground font-medium leading-tight">
            Asset library coming soon
          </p>
          <p className="text-[9px] text-muted-foreground mt-0.5 leading-snug">
            Full asset browser integration is implemented in Phase 3.7.
            Use the Asset Panel on the left to browse your files.
          </p>
        </div>
      )}
    </div>
  )
}
