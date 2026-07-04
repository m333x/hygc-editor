/**
 * Editor Hooks barrel export.
 *
 * Re-exports all editor-specific hooks. These hooks provide focused
 * interfaces to the editor Zustand store, following the Interface
 * Segregation Principle (ISP) — each hook exposes only the state and
 * actions relevant to its concern.
 *
 * Hook summary:
 *   useTimeline           — track/clip operations and timeline UI state
 *   usePlayback           — playhead position, duration, formatted time display
 *   usePlaybackEngine     — Zustand ↔ Remotion Player sync (Phase 3.5)
 *   useEditorKeyboard     — global keyboard shortcuts (Space, J/K/L, arrows, etc.)
 *   useEditorPersistence  — auto-save and load from Supabase
 *   useCaptionGeneration  — transcription + caption clip placement (Phase 3.8)
 *
 * @see PLAN.md Phase 3.1–3.8 for editor hook requirements
 */

export { useTimeline } from './useTimeline'
export type { UseTimelineReturn } from './useTimeline'

export { usePlayback } from './usePlayback'
export type { UsePlaybackReturn } from './usePlayback'

export { usePlaybackEngine } from './usePlaybackEngine'

export { useEditorKeyboard } from './useEditorKeyboard'

export { useEditorPersistence } from './useEditorPersistence'
export type { UseEditorPersistenceReturn } from './useEditorPersistence'


export { useProjectTitle } from './useProjectTitle'
export type { UseProjectTitleReturn } from './useProjectTitle'

export { useCaptionGeneration } from './useCaptionGeneration'
export type { UseCaptionGenerationReturn } from './useCaptionGeneration'

export { useAddManualCaption } from './useAddManualCaption'
export type { UseAddManualCaptionReturn } from './useAddManualCaption'

export { useAssetUrlMap } from './useAssetUrlMap'
export { useAudioPeaks } from './useAudioPeaks'
export type { UseAudioPeaksOptions, UseAudioPeaksResult } from './useAudioPeaks'
export { usePrefetchedAssetUrls } from './usePrefetchedAssetUrls'
export type { PrefetchProgress } from './usePrefetchedAssetUrls'
