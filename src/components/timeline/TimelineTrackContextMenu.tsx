/**
 * TimelineTrackContextMenu — right-click menu for the empty area of a track row.
 *
 * Fires whenever the user right-clicks inside a track lane but NOT on a clip
 * (Radix's nested triggers ensure TimelineClipContextMenu wins when the click
 * lands on a clip, and this menu wins everywhere else within the lane).
 *
 * Contents are a mix of timeline-global affordances (undo/redo, add track,
 * tool switch, snap) and per-track affordances (mute, hide, lock, delete) so
 * the user gets the most relevant set without needing to chase the inspector
 * or the toolbar.
 *
 * SOLID: SRP — owns the menu and only the menu. Doesn't render the lane;
 *   consumers pass that as `children` and we wrap it via `asChild`.
 *
 * Same store-subscription rationale as TimelineClipContextMenu: routing every
 * affected action through TrackContent as a prop would balloon its surface.
 * Stores are singletons; reading them at the menu level keeps the parent
 * clean and the menu's dependencies explicit.
 */

import { type ReactNode } from 'react'
import {
  ArrowLeftFromLine,
  ArrowLeftRight,
  ArrowRightFromLine,
  AudioLines,
  Captions,
  ChevronsDown,
  Eye,
  EyeOff,
  Gauge,
  Headphones,
  ListX,
  Lock,
  LockOpen,
  MousePointer2,
  Plus,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  Video,
  Volume2,
  VolumeX,
} from 'lucide-react'

import {
  ContextMenu,
  ContextMenuActionBar,
  ContextMenuActionItem,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../ui/context-menu'

import type { Track, ToolMode } from '../../types'
import { useEditorStore } from '../../store/editor-store'
import { useSelectionStore } from '../../store/selection-store'
import { useUIStore } from '../../store/ui-store'

export interface TimelineTrackContextMenuProps {
  /** The track whose lane is the right-click target. */
  track: Track
  /** The lane element. */
  children: ReactNode
}

export function TimelineTrackContextMenu({ track, children }: TimelineTrackContextMenuProps) {
  // Selection
  const hasSelection = useSelectionStore(
    (s) => s.selectedClipIds.length > 0 || s.selectedTransition !== null,
  )
  const deselectAll = useSelectionStore((s) => s.deselectAll)

  // UI
  const activeToolMode = useUIStore((s) => s.activeToolMode)
  const setToolMode = useUIStore((s) => s.setToolMode)
  const snapEnabled = useUIStore((s) => s.snapEnabled)
  const toggleSnap = useUIStore((s) => s.toggleSnap)

  // Project store (history + track ops)
  const addTrack = useEditorStore((s) => s.addTrack)
  const removeTrack = useEditorStore((s) => s.removeTrack)
  const toggleTrackMute = useEditorStore((s) => s.toggleTrackMute)
  const toggleTrackVisibility = useEditorStore((s) => s.toggleTrackVisibility)
  const toggleTrackLock = useEditorStore((s) => s.toggleTrackLock)
  const toggleTrackDucking = useEditorStore((s) => s.toggleTrackDucking)
  const soloTrack = useEditorStore((s) => s.soloTrack)
  // Derive the solo state as a primitive inside the selector so the snapshot
  // stays referentially stable. Selecting the filtered array would return a
  // new reference every read and trip useSyncExternalStore's infinite-loop
  // guard.
  const isOnlyAudibleAudioTrack = useEditorStore((s) => {
    if (track.type !== 'audio' && track.type !== 'clip_audio') return false
    if (track.muted) return false
    return s.tracks.every(
      (t) => (t.type !== 'audio' && t.type !== 'clip_audio') || t.id === track.id || t.muted,
    )
  })
  const undo = useEditorStore((s) => s.undo)
  const redo = useEditorStore((s) => s.redo)
  // canUndo/canRedo read from a ref outside Zustand state, so a normal selector
  // won't re-render on history changes. We call them at render time and accept
  // that the disabled state may be one tick stale — acceptable for a menu that
  // re-evaluates on every open.
  const canUndo = useEditorStore((s) => s.canUndo)()
  const canRedo = useEditorStore((s) => s.canRedo)()

  const isClipAudio = track.type === 'clip_audio'
  const supportsVisibility = track.type === 'video' || track.type === 'caption'
  const supportsDucking = track.type === 'audio' || track.type === 'clip_audio'
  const supportsSolo = track.type === 'audio' || track.type === 'clip_audio'
  const isMuted = track.muted
  const isVisible = track.visible ?? true
  const isLocked = track.locked
  const isDucking = !!track.ducking?.enabled
  // The track is "soloed" when it's the only audible audio track. Used to swap
  // the menu label between Solo and Un-solo so the affordance is reversible.
  const isSoloed = supportsSolo && isOnlyAudibleAudioTrack

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuActionBar>
          <ContextMenuActionItem icon={Undo2} label="Undo" disabled={!canUndo} onSelect={undo} />
          <ContextMenuActionItem icon={Redo2} label="Redo" disabled={!canRedo} onSelect={redo} />
          <ContextMenuActionItem
            icon={ListX}
            label="Deselect all"
            disabled={!hasSelection}
            onSelect={deselectAll}
          />
        </ContextMenuActionBar>
        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Plus />
            Add track
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={() => addTrack('Video', 'video')}>
              <Video />
              Video track
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => addTrack('Audio', 'audio')}>
              <AudioLines />
              Audio track
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => addTrack('Captions', 'caption')}>
              <Captions />
              Caption track
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <MousePointer2 />
            Tool
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuRadioGroup
              value={activeToolMode}
              onValueChange={(v) => setToolMode(v as ToolMode)}
            >
              <ContextMenuRadioItem value="select">
                <MousePointer2 />
                Select
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="slice">
                <Scissors />
                Slice
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="track-select-forward">
                <ArrowRightFromLine />
                Track Select Forward
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="track-select-backward">
                <ArrowLeftFromLine />
                Track Select Backward
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="rate-stretch">
                <Gauge />
                Rate Stretch
              </ContextMenuRadioItem>
              <ContextMenuRadioItem value="slip">
                <ArrowLeftRight />
                Slip
              </ContextMenuRadioItem>
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuCheckboxItem checked={snapEnabled} onCheckedChange={() => toggleSnap()}>
          Snap to edges
        </ContextMenuCheckboxItem>

        <ContextMenuSeparator />
        <ContextMenuLabel>{track.label}</ContextMenuLabel>

        <ContextMenuItem onSelect={() => toggleTrackMute(track.id)}>
          {isMuted ? <Volume2 /> : <VolumeX />}
          {isMuted ? 'Unmute track' : 'Mute track'}
        </ContextMenuItem>

        {supportsSolo && (
          <ContextMenuItem onSelect={() => soloTrack(track.id)}>
            <Headphones />
            {isSoloed ? 'Un-solo track' : 'Solo track'}
          </ContextMenuItem>
        )}

        {supportsVisibility && (
          <ContextMenuItem onSelect={() => toggleTrackVisibility(track.id)}>
            {isVisible ? <EyeOff /> : <Eye />}
            {isVisible ? 'Hide track' : 'Show track'}
          </ContextMenuItem>
        )}

        <ContextMenuItem onSelect={() => toggleTrackLock(track.id)}>
          {isLocked ? <LockOpen /> : <Lock />}
          {isLocked ? 'Unlock track' : 'Lock track'}
        </ContextMenuItem>

        {supportsDucking && (
          <ContextMenuCheckboxItem
            checked={isDucking}
            onCheckedChange={() => toggleTrackDucking(track.id)}
          >
            <ChevronsDown />
            Auto-duck under voiceover
          </ContextMenuCheckboxItem>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem
          variant="destructive"
          disabled={isClipAudio}
          onSelect={() => removeTrack(track.id)}
        >
          <Trash2 />
          Delete track
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
