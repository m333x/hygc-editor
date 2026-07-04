/**
 * TimelineClipContextMenu — right-click menu for a clip on the timeline.
 *
 * Visual model: shadcn-style Radix context menu (matches DropdownMenu look)
 * with a Windows-style icon-button strip at the top (the "action bar"), a
 * divider, then conventional menu items with leading icons + trailing
 * keyboard shortcuts.
 *
 * SOLID: SRP — this component owns the menu and only the menu. It does not
 *   render the clip body; consumers pass that as `children` and we wrap it
 *   with `<ContextMenuTrigger asChild>` so the existing clip element becomes
 *   the right-click target without any structural changes.
 *
 * Why this component subscribes to the editor stores directly (instead of
 *   receiving every action as a prop like TimelineClip does): the menu is a
 *   UI affordance, not part of the clip's render or interaction model. Routing
 *   a dozen additional callbacks through TimelineClip just to bind a menu would
 *   bloat its prop surface and obscure the SRP boundary we're enforcing here.
 *   Stores in this codebase are global singletons; reading them at the menu
 *   level keeps TimelineClip from growing further and keeps the menu's
 *   dependencies explicit in one place.
 */

import { type ReactNode } from 'react'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChartSpline,
  FlipHorizontal,
  FlipVertical,
  Gauge,
  Link,
  RotateCcw,
  Scissors,
  Snowflake,
  Trash2,
  Unlink,
  Waves,
} from 'lucide-react'

import {
  ContextMenu,
  ContextMenuActionBar,
  ContextMenuActionItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '../../ui/context-menu'

import type { Clip, Track } from '../../types'
import { DEFAULT_CLIP_TRANSFORM } from '../../types'
import { useEditorStore } from '../../store/editor-store'
import { usePlaybackStore } from '../../store/playback-store'
import { useSelectionStore } from '../../store/selection-store'
import { useUIStore } from '../../store/ui-store'
import { getClipSourceTime } from '../../engine/composition-utils'

/** Speed presets shown in the Speed submenu. Mirrors the store's clamp range. */
const SPEED_PRESETS = [0.5, 1, 1.5, 2, 4] as const

export interface TimelineClipContextMenuProps {
  clip: Clip
  track: Track
  /** The clip body element to use as the right-click target. */
  children: ReactNode
}

export function TimelineClipContextMenu({ clip, track, children }: TimelineClipContextMenuProps) {
  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const selectClip = useSelectionStore((s) => s.selectClip)
  const playhead = usePlaybackStore((s) => s.playheadPosition)
  const setPlayhead = usePlaybackStore((s) => s.setPlayhead)
  const splitClip = useEditorStore((s) => s.splitClip)
  const deleteClips = useEditorStore((s) => s.deleteClips)
  const setClipAudioLinked = useEditorStore((s) => s.setClipAudioLinked)
  const updateClipSpeed = useEditorStore((s) => s.updateClipSpeed)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const setClipFreezeFrame = useEditorStore((s) => s.setClipFreezeFrame)
  const setClipTransition = useEditorStore((s) => s.setClipTransition)
  const isGraphOpen = useUIStore((s) => s.keyframeGraphClipIds.includes(clip.id))
  const toggleKeyframeGraph = useUIStore((s) => s.toggleKeyframeGraph)

  const isSelected = selectedClipIds.includes(clip.id)
  const clipEnd = clip.startTime + clip.duration
  const playheadInside = playhead > clip.startTime && playhead < clipEnd
  const isVideoClip = track.type === 'video'
  const isCaptionClip = track.type === 'caption'
  const supportsKeyframeGraph = isVideoClip || isCaptionClip
  const audioLinked = clip.audioLinked !== false
  const isLocked = track.locked
  const hasFreeze = clip.freezeFrame !== undefined
  const transform = clip.transform
  const isTransformDefault =
    transform.x === 0 &&
    transform.y === 0 &&
    transform.scale === 1 &&
    transform.rotation === 0 &&
    !transform.flipH &&
    !transform.flipV &&
    transform.crop.top === 0 &&
    transform.crop.right === 0 &&
    transform.crop.bottom === 0 &&
    transform.crop.left === 0 &&
    (transform.opacity ?? 1) === 1
  const hasInTransition = clip.transitionIn && clip.transitionIn.type !== 'none'
  const hasOutTransition = clip.transitionOut && clip.transitionOut.type !== 'none'

  // Read selection fresh at call-time so we always act on the current state,
  // not on the snapshot from when the menu was rendered.
  const targetIdsForDelete = () => {
    const ids = useSelectionStore.getState().selectedClipIds
    return ids.includes(clip.id) && ids.length > 0 ? ids : [clip.id]
  }

  const handleSplit = () => splitClip(clip.id, playhead)
  const handleDelete = () => deleteClips(targetIdsForDelete())
  const handleToggleLink = () => setClipAudioLinked(clip.id, !audioLinked)
  const handleJumpToStart = () => setPlayhead(clip.startTime)
  const handleJumpToEnd = () => setPlayhead(clipEnd)
  const handleFlipH = () => updateClipTransform(clip.id, { flipH: !transform.flipH })
  const handleFlipV = () => updateClipTransform(clip.id, { flipV: !transform.flipV })
  const handleResetTransform = () => updateClipTransform(clip.id, DEFAULT_CLIP_TRANSFORM)
  const handleFreezeFrame = () => setClipFreezeFrame(clip.id, getClipSourceTime(clip, playhead))
  const handleUnfreeze = () => setClipFreezeFrame(clip.id, undefined)
  const handleClearInTransition = () => setClipTransition(clip.id, 'in', null)
  const handleClearOutTransition = () => setClipTransition(clip.id, 'out', null)

  return (
    <ContextMenu
      onOpenChange={(open) => {
        // Match every NLE + Finder/Explorer: right-clicking an unselected
        // item makes it the selection before the menu opens. If the user
        // right-clicks inside an existing multi-selection, leave it alone
        // so Delete acts on the whole group.
        if (open && !isSelected) selectClip(clip.id)
      }}
    >
      <ContextMenuTrigger asChild disabled={isLocked}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuActionBar>
          <ContextMenuActionItem
            icon={Scissors}
            label="Split at playhead"
            disabled={!playheadInside}
            onSelect={handleSplit}
          />
          <ContextMenuActionItem
            icon={Trash2}
            label="Delete"
            variant="destructive"
            onSelect={handleDelete}
          />
        </ContextMenuActionBar>
        <ContextMenuSeparator />

        <ContextMenuItem disabled={!playheadInside} onSelect={handleSplit}>
          <Scissors />
          Split at playhead
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <ArrowLeftToLine />
            Jump to
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem onSelect={handleJumpToStart}>
              <ArrowLeftToLine />
              Start of clip
            </ContextMenuItem>
            <ContextMenuItem onSelect={handleJumpToEnd}>
              <ArrowRightToLine />
              End of clip
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>

        {supportsKeyframeGraph && (
          <ContextMenuItem onSelect={() => toggleKeyframeGraph(clip.id)}>
            <ChartSpline />
            {isGraphOpen ? 'Hide keyframe graph' : 'Show keyframe graph'}
            <ContextMenuShortcut>G</ContextMenuShortcut>
          </ContextMenuItem>
        )}

        {!isCaptionClip && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Gauge />
              Speed
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={String(clip.speed)}
                onValueChange={(value) => updateClipSpeed(clip.id, Number(value))}
              >
                {SPEED_PRESETS.map((preset) => (
                  <ContextMenuRadioItem key={preset} value={String(preset)}>
                    {preset === 1 ? 'Normal (1×)' : `${preset}×`}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {isVideoClip && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <FlipHorizontal />
              Transform
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem onSelect={handleFlipH}>
                <FlipHorizontal />
                {transform.flipH ? 'Unflip horizontal' : 'Flip horizontal'}
              </ContextMenuItem>
              <ContextMenuItem onSelect={handleFlipV}>
                <FlipVertical />
                {transform.flipV ? 'Unflip vertical' : 'Flip vertical'}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={isTransformDefault} onSelect={handleResetTransform}>
                <RotateCcw />
                Reset transform
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {isVideoClip && (
          <ContextMenuItem
            disabled={!hasFreeze && !playheadInside}
            onSelect={hasFreeze ? handleUnfreeze : handleFreezeFrame}
          >
            <Snowflake />
            {hasFreeze ? 'Unfreeze' : 'Freeze frame at playhead'}
          </ContextMenuItem>
        )}

        {isVideoClip && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={handleToggleLink}>
              {audioLinked ? <Unlink /> : <Link />}
              {audioLinked ? 'Unlink audio' : 'Link audio'}
            </ContextMenuItem>
          </>
        )}

        {(hasInTransition || hasOutTransition) && (
          <>
            <ContextMenuSeparator />
            {hasInTransition && (
              <ContextMenuItem onSelect={handleClearInTransition}>
                <Waves />
                Clear in-transition
              </ContextMenuItem>
            )}
            {hasOutTransition && (
              <ContextMenuItem onSelect={handleClearOutTransition}>
                <Waves />
                Clear out-transition
              </ContextMenuItem>
            )}
          </>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={handleDelete}>
          <Trash2 />
          Delete
          <ContextMenuShortcut>Del</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
