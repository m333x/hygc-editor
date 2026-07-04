/**
 * UI Store — transient state for the editor's tool / panel / drag affordances.
 *
 * Owns:
 *   - `activeToolMode`        — current toolbar mode ('select' | 'slice')
 *   - `assetTab`              — active tab on the left asset rail
 *   - `zoomLevel`             — timeline horizontal zoom (px/sec)
 *   - `snapEnabled`           — snap-to-edges toggle
 *   - `transitionDragActive`  — true while a transition tile is being dragged
 *                                from the AssetPanel onto the timeline
 *   - `liveTransitionResize`  — live duration preview while resizing a
 *                                transition handle on a seam
 *   - `keyframeGraphClipIds`  — clip ids whose keyframe graph is expanded
 *                                beneath them in the timeline
 *
 * Why a separate store: none of this is persisted, none participates in
 * undo/redo, and most of it changes at pointer-event frequency (drag state,
 * zoom, hover-driven flags). Isolating it keeps the project store calm.
 */

import { create } from 'zustand'

import type {
  ToolMode,
  AssetTab,
  EffectInstance,
  LiveTransitionResize,
  LiveClipDrag,
  LiveSlip,
  ClipboardPreview,
} from '../types'

/** Default timeline zoom level: 100 pixels per second. */
const DEFAULT_ZOOM_LEVEL = 100

/**
 * localStorage key for the persisted UI prefs slice. Bumped only on
 * schema-breaking changes — additive fields can be merged via the parse step.
 */
const UI_PREFS_STORAGE_KEY = 'hygc.editor.ui-prefs.v1'

interface PersistedUIPrefs {
  snapEnabled: boolean
  zoomLevel: number
}

function readPersistedPrefs(): Partial<PersistedUIPrefs> {
  // SSR-safe: no window during build / Node-side hydration paths.
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<PersistedUIPrefs>
    const out: Partial<PersistedUIPrefs> = {}
    if (typeof parsed.snapEnabled === 'boolean') out.snapEnabled = parsed.snapEnabled
    if (typeof parsed.zoomLevel === 'number' && Number.isFinite(parsed.zoomLevel)) {
      out.zoomLevel = parsed.zoomLevel
    }
    return out
  } catch {
    // Corrupt JSON or storage-blocked. Fall back to defaults silently.
    return {}
  }
}

function writePersistedPrefs(prefs: PersistedUIPrefs): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Quota or storage-blocked — silently drop. Prefs are best-effort.
  }
}

export interface UIState {
  activeToolMode: ToolMode
  assetTab: AssetTab
  zoomLevel: number
  snapEnabled: boolean
  transitionDragActive: boolean
  liveTransitionResize: LiveTransitionResize | null
  /**
   * Active cross-track clip drag broadcast. Set by `TimelineClip` whenever a
   * move drag's pointer crosses out of the clip's source lane so the target
   * lane can paint a ghost at the live position. Null otherwise (including
   * during same-lane horizontal drags, which the clip itself previews).
   */
  liveClipDrag: LiveClipDrag | null
  /**
   * Active slip drag broadcast. Set by `TimelineClip` on every pointermove
   * while the Slip tool is sliding a clip's source window so the preview
   * canvas can show the new frame in real time. Null otherwise.
   */
  liveSlip: LiveSlip | null
  /**
   * Set of clip ids that have the advanced keyframe graph expanded beneath
   * them in the timeline. Stored as a readonly array so Zustand sees a new
   * reference on every change and selectors stay simple.
   */
  keyframeGraphClipIds: ReadonlyArray<string>
  /**
   * Whether the keyboard-shortcut cheatsheet dialog is open. Opens on `?`
   * and closes on Escape / clicking outside / Esc. Transient; not persisted.
   */
  cheatsheetOpen: boolean
  /**
   * Width (in px) of the timeline's scroll viewport, including its sticky
   * track-header column. Published by `Timeline` whenever its container is
   * measured or resized, so callers outside the timeline (the Fit View button
   * and the `\` shortcut) can compute a fit zoom without owning a ref.
   * `0` means the timeline hasn't been measured yet.
   */
  timelineViewportWidth: number
  /**
   * Monotonic counter incremented each time the user asks to fit the timeline
   * to the window. `Timeline` watches this id and runs the fit (zoom + scroll
   * reset) when it changes. A counter is used instead of a boolean so that two
   * consecutive fit requests still fire the effect.
   */
  fitTimelineRequestId: number
  /**
   * Render-friendly mirror of the editor store's in-memory copy buffer. Set by
   * `copyClips`, cleared when the buffer empties. Drives the paste-preview
   * ghost at the playhead in each compatible lane. Null when nothing is on the
   * clipboard.
   */
  clipboardPreview: ClipboardPreview | null
  /**
   * Copied effect instances awaiting paste onto another clip (Premiere's
   * copy/paste-effects). Kept verbatim from the source clip — the paste path
   * re-ids each instance so two clips never share instance ids. Null when
   * nothing has been copied. Transient; not persisted.
   */
  effectClipboard: EffectInstance[] | null
}

export interface UIActions {
  setToolMode(mode: ToolMode): void
  setAssetTab(tab: AssetTab): void
  setZoomLevel(level: number): void
  toggleSnap(): void
  /**
   * Toggle the transient flag the timeline uses to enable transition drop
   * zones. Called by the TransitionsPanel on dragstart/dragend so the zones
   * only intercept pointer events while a transition is in flight.
   */
  setTransitionDragActive(active: boolean): void
  /**
   * Set or clear the live-resize preview broadcast. Called by TimelineClip on
   * each pointermove while a transition resize handle is being dragged, and
   * cleared on pointerup/cancel.
   */
  setLiveTransitionResize(resize: LiveTransitionResize | null): void
  /**
   * Set or clear the cross-track drag broadcast. Called by `TimelineClip` on
   * each pointermove while a clip move drag hovers a different track, and
   * cleared on pointerup/cancel (or whenever the pointer returns to the
   * source lane).
   */
  setLiveClipDrag(drag: LiveClipDrag | null): void
  /**
   * Set or clear the live-slip broadcast. Called by `TimelineClip` on each
   * pointermove while the Slip tool is dragging, and cleared on pointerup /
   * cancel. Consumers (preview canvas) treat null as "no slip in flight".
   */
  setLiveSlip(slip: LiveSlip | null): void
  /**
   * Flip whether a clip's keyframe graph is expanded under it on the timeline.
   * Multiple clips may be expanded at once — handy when comparing motion across
   * adjacent shots — so this is a Set-like toggle, not a single active id.
   */
  toggleKeyframeGraph(clipId: string): void
  /** Force the graph open or closed for a specific clip. */
  setKeyframeGraphOpen(clipId: string, open: boolean): void
  /** Close every expanded graph. Called on project load/reset and when a clip is deleted. */
  clearKeyframeGraphs(): void
  /** Open / close / toggle the shortcut cheatsheet dialog. */
  setCheatsheetOpen(open: boolean): void
  /**
   * Publish the timeline scroll container's current width (in px). No-op when
   * the value is unchanged so unrelated UI state writes aren't perturbed.
   */
  setTimelineViewportWidth(width: number): void
  /**
   * Ask the timeline to fit its content into the current viewport. Increments
   * `fitTimelineRequestId`; the Timeline component reacts and runs the fit.
   */
  fitTimelineToWindow(): void
  /** Publish (or clear) the paste-preview summary. Called by `copyClips`. */
  setClipboardPreview(preview: ClipboardPreview | null): void
  /** Set or clear the copied-effects buffer. */
  setEffectClipboard(effects: EffectInstance[] | null): void
  /** Reset transient UI state (called on project load/reset). */
  reset(): void
}

export type UIStore = UIState & UIActions

const PERSISTED_DEFAULTS: PersistedUIPrefs = {
  snapEnabled: true,
  zoomLevel: DEFAULT_ZOOM_LEVEL,
}

const persistedAtBoot = { ...PERSISTED_DEFAULTS, ...readPersistedPrefs() }

const INITIAL_STATE: UIState = {
  activeToolMode: 'select',
  assetTab: 'my-assets',
  zoomLevel: persistedAtBoot.zoomLevel,
  snapEnabled: persistedAtBoot.snapEnabled,
  transitionDragActive: false,
  liveTransitionResize: null,
  liveClipDrag: null,
  liveSlip: null,
  keyframeGraphClipIds: [],
  cheatsheetOpen: false,
  timelineViewportWidth: 0,
  fitTimelineRequestId: 0,
  clipboardPreview: null,
  effectClipboard: null,
}

export const useUIStore = create<UIStore>((set, get) => ({
  ...INITIAL_STATE,

  setToolMode: (mode) => {
    set({ activeToolMode: mode })
  },

  setAssetTab: (tab) => {
    set({ assetTab: tab })
  },

  setZoomLevel: (level) => {
    set({ zoomLevel: Math.max(10, Math.min(500, level)) })
  },

  toggleSnap: () => {
    set({ snapEnabled: !get().snapEnabled })
  },

  setTransitionDragActive: (active) => {
    set({ transitionDragActive: active })
  },

  setLiveTransitionResize: (resize) => {
    set({ liveTransitionResize: resize })
  },

  setLiveClipDrag: (drag) => {
    set({ liveClipDrag: drag })
  },

  setLiveSlip: (slip) => {
    // Identity check avoids redundant store writes during slip drags — the
    // producer updates ~60×/sec and the preview canvas re-derives tracks on
    // every change, so churning on identical (clipId, delta) pairs would
    // cascade re-renders for no reason.
    const current = get().liveSlip
    if (slip === current) return
    if (
      slip &&
      current &&
      slip.clipId === current.clipId &&
      slip.sourceDeltaMs === current.sourceDeltaMs
    ) {
      return
    }
    set({ liveSlip: slip })
  },

  toggleKeyframeGraph: (clipId) => {
    const current = get().keyframeGraphClipIds
    set({
      keyframeGraphClipIds: current.includes(clipId)
        ? current.filter((id) => id !== clipId)
        : [...current, clipId],
    })
  },

  setKeyframeGraphOpen: (clipId, open) => {
    const current = get().keyframeGraphClipIds
    const isOpen = current.includes(clipId)
    if (open === isOpen) return
    set({
      keyframeGraphClipIds: open ? [...current, clipId] : current.filter((id) => id !== clipId),
    })
  },

  clearKeyframeGraphs: () => {
    if (get().keyframeGraphClipIds.length === 0) return
    set({ keyframeGraphClipIds: [] })
  },

  setCheatsheetOpen: (open) => {
    if (get().cheatsheetOpen === open) return
    set({ cheatsheetOpen: open })
  },

  setTimelineViewportWidth: (width) => {
    if (get().timelineViewportWidth === width) return
    set({ timelineViewportWidth: width })
  },

  fitTimelineToWindow: () => {
    set({ fitTimelineRequestId: get().fitTimelineRequestId + 1 })
  },

  setClipboardPreview: (preview) => {
    if (get().clipboardPreview === preview) return
    set({ clipboardPreview: preview })
  },

  setEffectClipboard: (effects) => {
    set({ effectClipboard: effects })
  },

  reset: () => {
    // Preserve transient measurements that describe the runtime, not the
    // project: the timeline viewport width survives a project switch, and the
    // fit-request id mustn't roll backward (or a stale effect could re-fit on
    // project load).
    const { timelineViewportWidth, fitTimelineRequestId } = get()
    set({ ...INITIAL_STATE, timelineViewportWidth, fitTimelineRequestId })
  },
}))

// ─── Persistence subscription ────────────────────────────────────────────────
//
// Only `snapEnabled` and `zoomLevel` survive reloads — every other UI flag
// (active tool, drag previews, expanded keyframe graphs) should boot fresh.
// We subscribe to the whole store and persist when either watched key changes;
// the cost is one shallow comparison per UI mutation, which is negligible
// compared to the writes the timeline already does.
{
  let lastSnap = useUIStore.getState().snapEnabled
  let lastZoom = useUIStore.getState().zoomLevel
  useUIStore.subscribe((state) => {
    if (state.snapEnabled === lastSnap && state.zoomLevel === lastZoom) return
    lastSnap = state.snapEnabled
    lastZoom = state.zoomLevel
    writePersistedPrefs({ snapEnabled: lastSnap, zoomLevel: lastZoom })
  })
}
