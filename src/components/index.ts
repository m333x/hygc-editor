/**
 * Editor Components barrel export.
 *
 * Re-exports all editor UI components for use within the editor feature
 * and from the EditorPage layout. Import from this barrel to avoid deep
 * relative paths.
 *
 * Components added in Phase 3.1:
 *   PreviewCanvas — Remotion Player wrapper with CSS scaling
 *
 * Components added in Phase 3.2:
 *   EditorToolbar     — top toolbar (undo/redo, tool selection, snap, zoom-to-fit,
 *                       Generate Captions button added in Phase 3.8)
 *   AssetPanel        — left sidebar (fully wired in Phase 3.7):
 *                       My Assets tab with AssetBrowser + drag-to-timeline
 *                       Upload tab with real file upload
 *                       AI Generate tab with tool links
 *   InspectorPanel    — right sidebar (clip transform, crop, speed controls)
 *   MobileBottomSheet — bottom sheet navigation for mobile layout
 *
 * Components added in Phase 3.4:
 *   Timeline          — interactive multi-track NLE timeline with DnD reorder,
 *                       drag-to-move clips, trim handles, snap, playhead,
 *                       asset drop target (Phase 3.7)
 *
 * Components added in Phase 3.8:
 *   CaptionStylePanel — caption generation trigger + global style controls
 *                       (4 presets, font, color, position, animation, effects)
 *
 * @see PLAN.md Phase 3.1–3.8 for editor component requirements
 */

// Phase 3.1
export { PreviewCanvas } from './PreviewCanvas'
export type { PreviewCanvasProps, PreviewCanvasHandle } from './PreviewCanvas'

// Phase 3.2
export { EditorToolbar } from './EditorToolbar'
export type { EditorToolbarProps } from './EditorToolbar'

export { AssetPanel } from './AssetPanel'

export { InspectorPanel } from './InspectorPanel'

export { MobileBottomSheet } from './MobileBottomSheet'

// Phase 3.4
export { Timeline } from './timeline'

// Phase 3.8
export { CaptionStylePanel } from './CaptionStylePanel'
export type { CaptionStylePanelProps } from './CaptionStylePanel'
export { CaptionGeneratorPanel } from './CaptionGeneratorPanel'
export type { CaptionGeneratorPanelProps } from './CaptionGeneratorPanel'

export { TransitionsPanel } from './TransitionsPanel'
export { EffectsPanel } from './EffectsPanel'

// Loading
export { EditorPageSkeleton } from './EditorPageSkeleton'
