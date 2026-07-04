/**
 * InspectorPanel — right sidebar panel for selected clip properties.
 *
 * Thin orchestrator: reads the current selection from the store via
 * `useInspectorSelection()` and dispatches to the appropriate section
 * component. Per-section UI lives under `./inspector/*` so each concern is
 * isolated and the panel itself stays scannable.
 *
 * Selection states:
 *   - Transition selected   → <TransitionInspectorSection />
 *   - No clip selected      → <ProjectDashboardSection />
 *   - 2+ clips selected     → <MultiSelectionState />
 *   - Caption clip selected → <CaptionClipSection />
 *   - Other clip selected   → <TransformSection /> + <CropSection /> +
 *                             <SpeedSection /> (+ <AudioFadeSection /> for
 *                             audio / clip_audio tracks)
 *
 * SOLID: SRP — only routes between section components; section UI logic and
 *   selection resolution live in dedicated modules.
 * SOLID: OCP — adding a new per-track-type section means adding one component
 *   and one render branch; existing sections stay untouched.
 */

import { useEditorStore } from '../store/editor-store'
import { useSelectionStore } from '../store/selection-store'
import { usePlaybackStore } from '../store/playback-store'
import { useUIStore } from '../store/ui-store'
import { getClipSourceTime } from '../engine/composition-utils'
import type {
  ClipTransform,
  CaptionStyle,
  ClipTransition,
  TransitionType,
  TransitionDirection,
} from '../types'
import { isDirectionalTransition } from '../engine/transitions'

import { TransformSection } from './inspector/TransformSection'
import { EffectsSection } from './inspector/EffectsSection'
import { CropSection } from './inspector/CropSection'
import { SpeedSection } from './inspector/SpeedSection'
import { AudioFadeSection } from './inspector/AudioFadeSection'
import { TransitionInspectorSection } from './inspector/TransitionInspectorSection'
import { CaptionClipSection } from './inspector/CaptionClipSection'
import { ProjectDashboardSection } from './inspector/ProjectDashboardSection'
import { MultiSelectionState } from './inspector/MultiSelectionState'
import { TrackTypeBadge } from './inspector/TrackTypeBadge'
import { useInspectorSelection } from './inspector/useInspectorSelection'

export interface InspectorPanelProps {
  /** Current project title; when provided with onProjectTitleChange, shown in project settings. */
  projectTitle?: string | null
  /** Called when the user edits the project name in the inspector. */
  onProjectTitleChange?: (title: string) => void | Promise<void>
}

export function InspectorPanel({ projectTitle, onProjectTitleChange }: InspectorPanelProps = {}) {
  // ── Store actions (selectors that don't re-render on every state change) ──

  const selectedClipIds = useSelectionStore((s) => s.selectedClipIds)
  const selectTransition = useSelectionStore((s) => s.selectTransition)
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const updateClipTransform = useEditorStore((s) => s.updateClipTransform)
  const updateClipSpeed = useEditorStore((s) => s.updateClipSpeed)
  const setClipFreezeFrame = useEditorStore((s) => s.setClipFreezeFrame)
  const setClipAudioFade = useEditorStore((s) => s.setClipAudioFade)
  const deleteClips = useEditorStore((s) => s.deleteClips)
  const setClipTransition = useEditorStore((s) => s.setClipTransition)
  const setSeamTransition = useEditorStore((s) => s.setSeamTransition)
  const resizeTransition = useEditorStore((s) => s.resizeTransition)
  const updateCaptionText = useEditorStore((s) => s.updateCaptionText)
  const updateClipCaptionStyle = useEditorStore((s) => s.updateClipCaptionStyle)
  const clearClipCaptionStyle = useEditorStore((s) => s.clearClipCaptionStyle)
  const setAssetTab = useUIStore((s) => s.setAssetTab)
  const beginHistoryTransaction = useEditorStore((s) => s.beginHistoryTransaction)
  const commitHistoryTransaction = useEditorStore((s) => s.commitHistoryTransaction)

  const { selectionCount, selectedClip, selectedTrackType, transitionSelection } =
    useInspectorSelection()

  // ── Clip handlers ──

  function handleTransformChange(transform: Partial<ClipTransform>) {
    if (!selectedClip) return
    updateClipTransform(selectedClip.id, transform)
  }

  function beginPropertyEdit() {
    beginHistoryTransaction('Inspector property edit')
  }

  function commitPropertyEdit() {
    commitHistoryTransaction()
  }

  function handleSpeedChange(speed: number) {
    if (!selectedClip) return
    updateClipSpeed(selectedClip.id, speed)
  }

  function handleAudioFadeChange(edge: 'in' | 'out', durationMs: number) {
    if (!selectedClip) return
    setClipAudioFade(selectedClip.id, edge, durationMs)
  }

  /**
   * Toggle the freeze frame for the selected clip. When enabling, captures the
   * current source-relative playhead position so the Remotion composition can
   * render that frame held still. Disabling clears the property.
   */
  function handleFreezeFrameToggle(enabled: boolean) {
    if (!selectedClip) return
    if (enabled) {
      const sourceTime = getClipSourceTime(selectedClip, playheadPosition)
      const clampedSourceTime = Math.max(
        selectedClip.inPoint,
        Math.min(sourceTime, selectedClip.outPoint - 1),
      )
      setClipFreezeFrame(selectedClip.id, clampedSourceTime)
    } else {
      setClipFreezeFrame(selectedClip.id, undefined)
    }
  }

  function handleDeleteSelected() {
    if (selectedClipIds.length > 0) {
      deleteClips(selectedClipIds)
    }
  }

  // ── Transition handlers ──

  function handleTransitionTypeChange(type: TransitionType) {
    if (!transitionSelection) return
    const { host, edge, neighbour, isSeam } = transitionSelection
    const existing = edge === 'in' ? host.transitionIn : host.transitionOut
    if (!existing) return
    // Drop direction/motionBlurStrength when switching to a type that doesn't
    // use them — preserving them would carry stale state into types where the
    // Inspector won't expose the controls.
    const next: ClipTransition = {
      type,
      durationMs: existing.durationMs,
      ...(isDirectionalTransition(type) && existing.direction
        ? { direction: existing.direction }
        : {}),
      ...(existing.motionBlurStrength !== undefined
        ? { motionBlurStrength: existing.motionBlurStrength }
        : {}),
    }
    if (isSeam && neighbour) {
      const [leftId, rightId] = edge === 'in' ? [neighbour.id, host.id] : [host.id, neighbour.id]
      setSeamTransition(leftId, rightId, next)
    } else {
      setClipTransition(host.id, edge, next)
    }
  }

  function handleTransitionResize(durationMs: number) {
    if (!transitionSelection) return
    resizeTransition(transitionSelection.host.id, transitionSelection.edge, durationMs)
  }

  function patchActiveTransition(patch: Partial<ClipTransition>) {
    if (!transitionSelection) return
    const { host, edge, neighbour, isSeam } = transitionSelection
    const existing = edge === 'in' ? host.transitionIn : host.transitionOut
    if (!existing) return
    const next: ClipTransition = { ...existing, ...patch }
    if (isSeam && neighbour) {
      const [leftId, rightId] = edge === 'in' ? [neighbour.id, host.id] : [host.id, neighbour.id]
      setSeamTransition(leftId, rightId, next)
    } else {
      setClipTransition(host.id, edge, next)
    }
  }

  function handleTransitionDirectionChange(direction: TransitionDirection) {
    patchActiveTransition({ direction })
  }

  function handleTransitionMotionBlurChange(strength: number) {
    patchActiveTransition({ motionBlurStrength: strength })
  }

  function handleTransitionRemove() {
    if (!transitionSelection) return
    const { host, edge, neighbour, isSeam } = transitionSelection
    setClipTransition(host.id, edge, null)
    if (isSeam && neighbour) {
      // Also clear the paired half so the seam doesn't keep a dangling fade.
      setClipTransition(neighbour.id, edge === 'in' ? 'out' : 'in', null)
    }
    selectTransition(null)
  }

  // ── Caption handlers ──

  function handleCaptionTextChange(text: string) {
    if (!selectedClip) return
    updateCaptionText(selectedClip.id, text)
  }

  function handleCaptionStyleChange(update: Partial<CaptionStyle>) {
    if (!selectedClip) return
    // Inspector callers are mode-switch / state-reset writes (Size and
    // Position toggles, anchor resets) — they must hit the static baseline so
    // the toggles correctly reflect the new mode. Continuous value edits
    // (X/Y offset, font-size slider) go through `KeyframedSliderRow`, which
    // owns its own keyframe-vs-baseline routing via `commitValue`.
    updateClipCaptionStyle(selectedClip.id, update)
  }

  function handleResetCaptionStyle() {
    if (!selectedClip) return
    clearClipCaptionStyle(selectedClip.id)
  }

  // ── Render ──

  return (
    <div className="flex flex-col h-full bg-card border-l border-border">
      {/* Panel header — adapts to selection state so the label is free
          orientation instead of a static word that's always the same. */}
      <div className="px-3 pt-3 pb-2 shrink-0 border-b border-border">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {transitionSelection
            ? 'Transition'
            : selectionCount === 0
              ? 'Project'
              : selectionCount === 1
                ? 'Clip'
                : 'Selection'}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {transitionSelection && (
          <div className="p-3">
            <TransitionInspectorSection
              clip={transitionSelection.host}
              edge={transitionSelection.edge}
              neighbour={transitionSelection.neighbour}
              isSeam={transitionSelection.isSeam}
              onChangeType={handleTransitionTypeChange}
              onResize={handleTransitionResize}
              onChangeDirection={handleTransitionDirectionChange}
              onChangeMotionBlur={handleTransitionMotionBlurChange}
              onRemove={handleTransitionRemove}
              onEditStart={beginPropertyEdit}
              onEditEnd={commitPropertyEdit}
            />
          </div>
        )}

        {!transitionSelection && selectionCount === 0 && (
          <ProjectDashboardSection
            projectTitle={projectTitle}
            onProjectTitleChange={onProjectTitleChange}
          />
        )}

        {!transitionSelection && selectionCount > 1 && (
          <MultiSelectionState count={selectionCount} onDelete={handleDeleteSelected} />
        )}

        {!transitionSelection && selectedClip && (
          <div className="p-3">
            {/* ── Clip identity ── */}
            <div className="mb-4">
              <div className="flex items-center gap-1.5 mb-0.5">
                <p
                  className="text-[10px] font-medium text-foreground truncate flex-1"
                  title={selectedClip.assetId}
                >
                  {selectedClip.captionText
                    ? `"${selectedClip.captionText}"`
                    : selectedClip.assetId.slice(0, 12) + '…'}
                </p>
                <TrackTypeBadge type={selectedTrackType} />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {(selectedClip.duration / 1000).toFixed(2)}s at {(selectedClip.startTime / 1000).toFixed(2)}s
                {selectedClip.freezeFrame !== undefined && (
                  <span className="ml-1.5 text-primary/80">• frozen</span>
                )}
              </p>
            </div>

            {/*
             * Caption clips get a stripped-down inspector: only the text editor.
             * The shared transform sliders (X/Y/zoom/rotation/opacity/flip),
             * Crop, and Speed are no-ops for text overlays — captions render via
             * captionStyle.position + xOffset/yOffset, not clip.transform.
             */}
            {selectedTrackType === 'caption' ? (
              <CaptionClipSection
                clip={selectedClip}
                onTextChange={handleCaptionTextChange}
                onStyleChange={handleCaptionStyleChange}
                onResetStyle={handleResetCaptionStyle}
                onEditStart={beginPropertyEdit}
                onEditEnd={commitPropertyEdit}
                onOpenCaptionsTab={() => setAssetTab('captions')}
              />
            ) : selectedTrackType === 'audio' || selectedTrackType === 'clip_audio' ? (
              <>
                {/* Audio clips have no visual transform, crop, or freeze frame —
                    only speed (which time-stretches the waveform) and fades. */}
                <SpeedSection
                  clip={selectedClip}
                  onSpeedChange={handleSpeedChange}
                  onFreezeFrameToggle={handleFreezeFrameToggle}
                  hideFreezeFrame
                />

                <AudioFadeSection
                  clip={selectedClip}
                  onFadeChange={handleAudioFadeChange}
                  onEditStart={beginPropertyEdit}
                  onEditEnd={commitPropertyEdit}
                />
              </>
            ) : (
              <>
                <TransformSection
                  clip={selectedClip}
                  onTransformChange={handleTransformChange}
                  onEditStart={beginPropertyEdit}
                  onEditEnd={commitPropertyEdit}
                />

                <CropSection
                  clip={selectedClip}
                  onTransformChange={handleTransformChange}
                  onEditStart={beginPropertyEdit}
                  onEditEnd={commitPropertyEdit}
                />

                <EffectsSection
                  clip={selectedClip}
                  onEditStart={beginPropertyEdit}
                  onEditEnd={commitPropertyEdit}
                />

                <SpeedSection
                  clip={selectedClip}
                  onSpeedChange={handleSpeedChange}
                  onFreezeFrameToggle={handleFreezeFrameToggle}
                />
              </>
            )}

            <button
              onClick={handleDeleteSelected}
              className="w-full text-[11px] py-1.5 rounded border border-destructive/50 text-destructive hover:bg-destructive hover:text-destructive-foreground transition-colors mt-2"
            >
              Delete clip
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
