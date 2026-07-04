/**
 * AssetPanel — left sidebar panel of the NLE editor.
 *
 * Provides access to the user's media assets from within the editor. Contains
 * three tabs for different asset sources:
 *
 *   My Assets  — browse the current project's assets (video, audio, image).
 *                Renders the shared AssetBrowser in compact mode.
 *                Assets can be dragged from the panel directly onto a timeline
 *                track (HTML5 drag-to-timeline — Phase 3.7), or selected to
 *                choose a target track via the inline TrackPicker dropdown.
 *
 *   AI Generate — shortcuts into the standalone AI tools for quick generation.
 *                 Opens tool pages in a new tab so the project stays open.
 *
 *   Upload     — a focused drop zone + file picker for uploading local media
 *                directly into the project's asset library. Uses the same
 *                `useAssets` hook as the My Assets tab so uploaded files
 *                appear immediately after upload completes.
 *
 * ─── Phase 3.7 implementation ─────────────────────────────────────────────────
 *
 * My Assets tab:
 *   - AssetBrowser in compact mode with `draggableAssets={true}` — each card
 *     encodes the asset as JSON in a `dataTransfer` entry under the type
 *     `application/hygc-asset`. TrackContent.tsx reads this on drop.
 *   - `onSelect` opens the inline TrackPicker which shows compatible tracks
 *     for the selected asset type and dispatches `addClip` on confirmation.
 *   - Compatible track matching:
 *       video assets   → tracks with type 'video'
 *       audio assets   → tracks with type 'audio'
 *       image assets   → tracks with type 'video'  (images on video tracks)
 *       caption_file   → tracks with type 'caption'
 *       (all assets)   → all tracks (fallback if no compatible track exists)
 *   - Clip placement: new clip starts at the current playhead position.
 *     Its duration defaults to the asset's `duration_ms`, or 5 seconds for
 *     images and assets without duration metadata.
 *
 * Upload tab:
 *   - Drag-and-drop zone calls `useAssets.upload()` directly.
 *   - Hidden file input provides click-to-browse fallback.
 *   - Uploading state shows a spinner; error is displayed inline.
 *   - On completion the My Assets tab automatically shows the new file because
 *     both tabs share the same `useAssets` hook instance.
 *
 * ─── State management ─────────────────────────────────────────────────────────
 *
 * The panel reads `projectId` from the URL params (same param used by EditorPage).
 * Asset data comes from the `useAssets(projectId, { scope })` hook; the My Assets
 * tab supports scope "This project" or "All my assets" (previously uploaded).
 * Track data and the `addClip` action come from the Zustand editor store directly
 * — the panel does not need to receive these via props, which keeps EditorPage's JSX clean.
 *
 * SOLID: SRP — only manages the panel shell, tab switching, and asset-to-clip
 *   bridging. All data access is delegated to useAssets and useEditorStore.
 * SOLID: OCP — new tabs can be added without touching existing tab logic.
 * SOLID: DIP — depends on the useAssets hook interface and the editor store
 *   interface, not on concrete service implementations.
 *
 * @see README.md Section 7.2 "Asset Panel (left sidebar)"
 * @see PLAN.md Phase 3.7 for asset panel wiring requirements
 * @see AssetBrowser.tsx for the shared browser component (supports draggableAssets)
 * @see TrackContent.tsx for the timeline drop target that receives dragged assets
 * @see useAssets.ts for the asset data hook
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams } from 'react-router'
import { editorToast } from './EditorToast'
import {
  Captions as CaptionsIcon,
  ImageIcon,
  LayoutGrid,
  List as ListIcon,
  Loader2,
  Mic,
  Sparkles,
  Upload,
  UploadCloud,
  Wand2,
} from 'lucide-react'
import { useEditorHost } from '../host'
import type { EditorAsset, EditorAssetType, AssetViewMode, UploadProgressInfo } from '../host'
import { getMediaDurationMs } from '../lib/mediaDuration'
import { assetFilename, assetDurationMs } from '../lib/asset-meta'
import { UploadProgressBar } from '../ui/upload-progress'
import { useEditorStore } from '../store/editor-store'
import { usePlaybackStore } from '../store/playback-store'
import { useUIStore } from '../store/ui-store'
import { CaptionStylePanel } from './CaptionStylePanel'
import { CaptionGeneratorPanel } from './CaptionGeneratorPanel'
import { TransitionsPanel } from './TransitionsPanel'
import { EffectsPanel } from './EffectsPanel'
import { VoiceoverPanel } from './VoiceoverPanel'
import type { Track, AssetTab } from '../types'

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Default clip duration in milliseconds when an asset has no `duration_ms`.
 * Applies to images, caption files, and any asset whose duration is unknown.
 */
const DEFAULT_CLIP_DURATION_MS = 5_000

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine which track types are compatible with a given asset type.
 *
 * Audio assets belong on audio tracks; images and video belong on video tracks;
 * caption files belong on caption tracks. If no compatible track exists at all,
 * the fallback returns all tracks so the user is never blocked.
 *
 * @param assetType - The type of the asset being added
 * @param tracks    - All tracks on the timeline
 * @returns Tracks that can accept the asset (may be all tracks as fallback)
 */
function getCompatibleTracks(assetType: EditorAssetType, tracks: Track[]): Track[] {
  const typeMap: Partial<Record<EditorAssetType, Track['type'][]>> = {
    video: ['video'],
    audio: ['audio'],
    image: ['video'],
  }

  const compatibleTypes = typeMap[assetType] ?? []
  const filtered = tracks.filter((t) => compatibleTypes.includes(t.type))

  // Fallback: if no compatible track exists (e.g., no audio tracks), show all
  return filtered.length > 0 ? filtered : tracks
}

// ─── TrackPicker ──────────────────────────────────────────────────────────────

/**
 * TrackPicker — inline dropdown to choose which timeline track to add an asset to.
 *
 * Appears directly below the selected asset card when the user clicks an asset
 * in the My Assets tab. Shows only tracks compatible with the asset type.
 * Clicking a track creates a clip and dispatches `addClip` to the store.
 *
 * Design rationale:
 *   An inline popup keeps the user's eyes on the asset panel rather than
 *   forcing them to interact with the timeline before understanding where
 *   the clip will go. The popup dismisses on selection or on clicking Cancel.
 */
interface TrackPickerProps {
  /** The asset the user wants to add. */
  asset: EditorAsset
  /** All tracks on the timeline (filtered internally for compatibility). */
  tracks: Track[]
  /** Callback dispatched with target track when the user picks a track. */
  onAddToTrack: (trackId: string) => void
  /** Dismiss the picker without adding anything. */
  onCancel: () => void
}

function TrackPicker({ asset, tracks, onAddToTrack, onCancel }: TrackPickerProps) {
  const compatibleTracks = getCompatibleTracks(asset.type, tracks)

  return (
    <div
      className="mt-1 mb-3 bg-popover border border-border rounded-lg shadow-lg overflow-hidden"
      role="dialog"
      aria-label="Choose target track"
    >
      {/* Header */}
      <div className="px-2.5 py-2 border-b border-border/60">
        <p className="text-[10px] font-semibold text-foreground truncate" title={assetFilename(asset)}>
          Add to track:
        </p>
        <p className="text-[9px] text-muted-foreground truncate mt-0.5">
          {assetFilename(asset)} · {asset.type}
        </p>
      </div>

      {/* Track list */}
      <div className="py-1 max-h-40 overflow-y-auto">
        {compatibleTracks.length === 0 ? (
          <p className="text-[10px] text-muted-foreground px-2.5 py-2 text-center">
            No compatible tracks. Add a track first.
          </p>
        ) : (
          compatibleTracks
            .sort((a, b) => a.order - b.order)
            .map((track) => (
              <button
                key={track.id}
                disabled={track.locked}
                onClick={() => {
                  onAddToTrack(track.id)
                }}
                className={`
                  w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-colors
                  ${track.locked
                    ? 'opacity-40 cursor-not-allowed'
                    : 'hover:bg-primary/10 hover:text-primary'
                  }
                `}
                title={track.locked ? 'Track is locked' : `Add to ${track.label}`}
              >
                {/* Track type colour indicator — matches TRACK_TYPE_CONFIG so
                    the dot in the picker and the clip on the timeline share
                    one identity. */}
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    track.type === 'video'
                      ? 'bg-clip-video-bg'
                      : track.type === 'audio'
                        ? 'bg-clip-audio-bg'
                        : 'bg-clip-caption-bg'
                  }`}
                  aria-hidden
                />
                <span className="text-[11px] text-foreground flex-1 truncate">
                  {track.label}
                </span>
                {track.locked && (
                  <span className="text-[9px] text-muted-foreground">Locked</span>
                )}
              </button>
            ))
        )}
      </div>

      {/* Footer */}
      <div className="px-2.5 py-1.5 border-t border-border/60">
        <button
          onClick={onCancel}
          className="w-full text-[10px] text-muted-foreground hover:text-foreground transition-colors py-0.5"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ─── MyAssetsTab ──────────────────────────────────────────────────────────────

/**
 * MyAssetsTab — the main asset browser in the editor sidebar.
 *
 * Renders the shared `AssetBrowser` in compact + draggable mode. Supports two
 * scopes: "This project" (assets linked to the current project) and "All my
 * assets" (previously uploaded assets from any project), so users can reuse
 * uploads from other projects in the NLE.
 *
 *   - Drag-to-timeline: Assets are draggable via HTML5 DnD. TrackContent.tsx
 *     reads the `application/hygc-asset` dataTransfer payload on drop and
 *     calls `addClip` with the clip positioned at the drop X-coordinate.
 *
 *   - Click-to-add: Clicking an asset opens an inline TrackPicker popup below
 *     the asset card. The user picks a target track; the clip is added at the
 *     current playhead position and the picker dismisses automatically.
 *
 * Both mechanisms ultimately call `addClip(trackId, clip)` on the Zustand store,
 * keeping state management consistent with all other editor mutations.
 */
interface MyAssetsTabProps {
  projectId: string | undefined
}

/**
 * localStorage key for persisting the user's grid/list view preference.
 *
 * Stored under a stable namespace so future panel preferences can sit alongside
 * without colliding. The preference is per-browser, not per-project — the user
 * picks a layout they like and every project they open uses it.
 */
const ASSET_VIEW_MODE_STORAGE_KEY = 'hygc.editor.assetPanel.viewMode'

function readStoredViewMode(): AssetViewMode {
  if (typeof window === 'undefined') return 'grid'
  const stored = window.localStorage.getItem(ASSET_VIEW_MODE_STORAGE_KEY)
  return stored === 'list' ? 'list' : 'grid'
}

function MyAssetsTab({ projectId }: MyAssetsTabProps) {
  // ── Scope: this project only vs all user assets (previously uploaded) ──

  const [assetScope, setAssetScope] = useState<'project' | 'all'>('project')

  // ── View mode: grid (default, thumbnail-first) vs list (dense rows) ──

  const [viewMode, setViewMode] = useState<AssetViewMode>(readStoredViewMode)

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ASSET_VIEW_MODE_STORAGE_KEY, viewMode)
  }, [viewMode])

  // ── Asset data (host-provided) ──

  const { useAssetLibrary, AssetBrowser } = useEditorHost()
  const assets = useAssetLibrary(projectId, { scope: assetScope })

  // ── Editor store ──

  const tracks = useEditorStore((s) => s.tracks)
  const playheadPosition = usePlaybackStore((s) => s.playheadPosition)
  const addAssetClipToTrack = useEditorStore((s) => s.addAssetClipToTrack)

  // ── Track picker state ──

  /** The asset whose TrackPicker is currently open. Null = picker closed. */
  const [selectedAsset, setSelectedAsset] = useState<EditorAsset | null>(null)

  /** Batch upload progress. Null when no batch is in flight. */
  const [uploadProgress, setUploadProgress] = useState<UploadProgressInfo | null>(null)

  // ── Handlers ──

  /**
   * Called when the user clicks an asset card.
   * Toggles the TrackPicker for that asset.
   */
  function handleAssetSelect(asset: EditorAsset) {
    setSelectedAsset((prev) => (prev?.id === asset.id ? null : asset))
  }

  /**
   * Called when the user picks a track in the TrackPicker.
   * Creates a clip at the current playhead position and dispatches addClip.
   */
  function handleAddToTrack(trackId: string, asset: EditorAsset) {
    const duration = assetDurationMs(asset) ?? DEFAULT_CLIP_DURATION_MS
    addAssetClipToTrack(trackId, {
      assetId: asset.id,
      assetType: asset.type,
      startTime: playheadPosition,
      duration,
      sourceDurationMs: duration,
    })
    setSelectedAsset(null)
  }

  /**
   * Upload handler — delegates to the useAssets hook.
   * Uploads each file sequentially so the single `uploading` flag in useAssets
   * stays coherent and the user sees one continuous spinner across the batch.
   * For video/audio, extracts duration so the asset (and timeline clips) get the correct length.
   */
  async function handleUpload(files: File[]) {
    if (!projectId || files.length === 0) return
    setUploadProgress({ completed: 0, total: files.length, currentFilename: files[0].name })
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        setUploadProgress({ completed: i, total: files.length, currentFilename: file.name })

        let type: EditorAssetType = 'video'
        if (file.type.startsWith('audio/')) type = 'audio'
        else if (file.type.startsWith('image/')) type = 'image'

        let metadata: Record<string, unknown> | undefined
        if (type === 'video' || type === 'audio') {
          const durationMs = await getMediaDurationMs(file, type)
          if (durationMs != null) metadata = { duration_ms: durationMs }
        }

        await assets.upload(file, projectId, type, metadata).catch(console.error)
      }
    } finally {
      setUploadProgress(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-2.5">
      {/* Scope segmented control + view-mode toggle + asset count. One quiet
          row keeps the controls aligned and avoids extra vertical chrome —
          NLE sidebars are space-constrained and a second row would push the
          actual grid below the fold on shorter screens. */}
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="inline-flex items-center rounded-md bg-secondary/50 p-0.5 text-[11px] font-medium">
          <button
            type="button"
            onClick={() => setAssetScope('project')}
            className={`rounded-[5px] px-2.5 py-1 transition-colors ${
              assetScope === 'project'
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Show only assets from this project"
          >
            Project
          </button>
          <button
            type="button"
            onClick={() => setAssetScope('all')}
            className={`rounded-[5px] px-2.5 py-1 transition-colors ${
              assetScope === 'all'
                ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            title="Show all your uploaded and generated assets"
          >
            All
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/70 tabular-nums">
            {assets.assets.length}
          </span>
          {/* Grid / List toggle — mirrors the segmented-control styling of the
              scope chips so the two controls read as one consistent toolbar. */}
          <div
            role="radiogroup"
            aria-label="Asset layout"
            className="inline-flex items-center rounded-md bg-secondary/50 p-0.5"
          >
            <button
              type="button"
              role="radio"
              aria-checked={viewMode === 'grid'}
              onClick={() => setViewMode('grid')}
              className={`rounded-[5px] p-1 transition-colors ${
                viewMode === 'grid'
                  ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="Grid view"
            >
              <LayoutGrid size={12} aria-hidden />
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={viewMode === 'list'}
              onClick={() => setViewMode('list')}
              className={`rounded-[5px] p-1 transition-colors ${
                viewMode === 'list'
                  ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.04)]'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              title="List view"
            >
              <ListIcon size={12} aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/*
       * AssetBrowser in compact + draggable mode.
       *
       * `draggableAssets={true}` enables HTML5 drag behaviour on each card.
       * `onSelect` opens the TrackPicker inline rather than the preview modal.
       * `compact={true}` renders a 2-column grid with shorter thumbnails.
       */}
      <AssetBrowser
        assets={assets.assets}
        loading={assets.loading}
        uploading={assets.uploading}
        error={assets.error}
        typeFilter={assets.typeFilter}
        onTypeFilterChange={assets.setTypeFilter}
        sourceFilter={assets.sourceFilter}
        onSourceFilterChange={assets.setSourceFilter}
        searchQuery={assets.searchQuery}
        onSearchChange={assets.setSearchQuery}
        onUpload={handleUpload}
        uploadProgress={uploadProgress}
        onDelete={(assetId) => assets.remove(assetId)}
        onSelect={handleAssetSelect}
        compact
        draggableAssets
        viewMode={viewMode}
        projectId={projectId}
      />

      {/*
       * TrackPicker — rendered inline below the selected asset.
       *
       * Because the AssetBrowser renders a flat grid (not individual wrappers
       * per card), the TrackPicker appears at the bottom of the scrollable
       * area rather than directly under the card. For the sidebar context
       * this is a clean solution: the user sees the picker without any
       * layout shift or Z-index conflicts with the panel borders.
       *
       * A future enhancement could position the picker adjacent to the card
       * using a floating popover library once the design matures.
       */}
      {selectedAsset && (
        <TrackPicker
          asset={selectedAsset}
          tracks={tracks}
          onAddToTrack={(trackId) => handleAddToTrack(trackId, selectedAsset)}
          onCancel={() => setSelectedAsset(null)}
        />
      )}
    </div>
  )
}

// ─── UploadTab ────────────────────────────────────────────────────────────────

/**
 * UploadTab — a focused upload zone for adding local media files.
 *
 * Provides a dedicated drag-and-drop + click-to-browse zone for uploading
 * files directly. Shares the `useAssets` hook with `MyAssetsTab` so newly
 * uploaded files appear immediately in the assets grid.
 *
 * Accepted formats match the asset service's `ACCEPTED_TYPES` configuration:
 *   video: mp4, mov, webm, avi, mkv
 *   audio: mp3, m4a, wav, ogg, aac, flac
 *   image: jpg, jpeg, png, gif, webp, svg
 *
 * After a successful upload the tab shows a success message with a link to
 * switch to "My Assets" so the user can immediately use the new file.
 */
interface UploadTabProps {
  projectId: string | undefined
}

function UploadTab({ projectId }: UploadTabProps) {
  const { useAssetLibrary } = useEditorHost()
  const assets = useAssetLibrary(projectId)
  const setAssetTab = useUIStore((s) => s.setAssetTab)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [uploadProgress, setUploadProgress] = useState<UploadProgressInfo | null>(null)

  /**
   * Infer AssetType from the file's MIME type.
   * Falls back to 'video' for unrecognised MIME types.
   */
  function inferAssetType(file: File): EditorAssetType {
    if (file.type.startsWith('audio/')) return 'audio'
    if (file.type.startsWith('image/')) return 'image'
    return 'video'
  }

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!projectId || files.length === 0) return
      const uploaded: EditorAsset[] = []
      setUploadProgress({ completed: 0, total: files.length, currentFilename: files[0].name })
      try {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          setUploadProgress({ completed: i, total: files.length, currentFilename: file.name })

          const type = inferAssetType(file)
          let metadata: Record<string, unknown> | undefined
          if (type === 'video' || type === 'audio') {
            const durationMs = await getMediaDurationMs(file, type)
            if (durationMs != null) metadata = { duration_ms: durationMs }
          }
          const result = await assets.upload(file, projectId, type, metadata)
          if (result) uploaded.push(result)
        }
      } finally {
        setUploadProgress(null)
      }
      if (uploaded.length > 0) {
        // Hop to the Assets tab so the newly uploaded files are visible without
        // a manual click. The grid is sorted by recency so they land at the top.
        setAssetTab('my-assets')
        editorToast.success(
          uploaded.length === 1
            ? `Uploaded ${assetFilename(uploaded[0])}`
            : `Uploaded ${uploaded.length} files`,
        )
      }
    },
    [assets, projectId, setAssetTab],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => setIsDragOver(false), [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) handleFiles(files)
    },
    [handleFiles],
  )

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? [])
      if (files.length > 0) handleFiles(files)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [handleFiles],
  )

  return (
    <div className="flex-1 overflow-y-auto p-3">
      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !assets.uploading && fileInputRef.current?.click()}
        className={`
          flex flex-col items-center justify-center min-h-40 text-center
          border-2 border-dashed rounded-lg gap-2 transition-colors
          ${assets.uploading ? 'cursor-wait' : 'cursor-pointer'}
          ${isDragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/40 hover:bg-primary/5'
          }
        `}
        role="button"
        aria-label="Upload media files"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
      >
        {assets.uploading ? (
          <>
            <Loader2 size={24} className="text-primary animate-spin" />
            <p className="text-xs font-medium text-foreground">
              {uploadProgress && uploadProgress.total > 1
                ? `Uploading ${Math.min(uploadProgress.completed + 1, uploadProgress.total)} of ${uploadProgress.total}`
                : 'Uploading…'}
            </p>
            <div className="w-full px-4">
              <UploadProgressBar uploading progress={uploadProgress} />
            </div>
          </>
        ) : (
          <>
            <Upload size={24} className="text-muted-foreground/50" />
            <div>
              <p className="text-xs font-medium text-foreground">
                {isDragOver ? 'Drop to upload' : 'Drag & drop or click'}
              </p>
              <p className="text-[10px] text-muted-foreground mt-1">
                Video, audio, or image · multiple files supported
              </p>
            </div>
          </>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInput}
          className="hidden"
          accept="video/*,audio/*,image/*"
          aria-hidden
        />
      </div>

      {/* Upload error */}
      {assets.error && (
        <div className="mt-3 p-2 rounded-md bg-destructive/10 border border-destructive/20 text-[10px] text-destructive">
          {assets.error}
        </div>
      )}

      {/* Size & format guide */}
      <div className="mt-3 text-[9px] text-muted-foreground/60 leading-relaxed">
        <p className="font-medium text-muted-foreground/80 mb-1">Supported formats</p>
        <p>Video: MP4, MOV, WebM</p>
        <p>Audio: MP3, WAV, AAC, OGG</p>
        <p>Image: JPG, PNG, WebP, GIF</p>
        <p className="mt-1">Max 500 MB per file</p>
      </div>
    </div>
  )
}

// ─── CaptionsTab ──────────────────────────────────────────────────────────────

/**
 * CaptionsTab — left-rail destination for caption creation AND styling.
 *
 * Composes two single-responsibility panels:
 *   - {@link CaptionGeneratorPanel}: Generate Captions (ASR) + Add caption at playhead
 *   - {@link CaptionStylePanel}: presets + Custom controls (font, color, animation, …)
 *
 * The global captionStyle edited here is applied to every caption clip that
 * doesn't have a per-clip override. Per-clip overrides remain editable in the
 * Inspector when a caption clip is selected.
 */
interface CaptionsTabProps {
  projectId: string | undefined
}

function CaptionsTab({ projectId }: CaptionsTabProps) {
  return (
    <div className="flex-1 overflow-y-auto px-3 py-2">
      <CaptionGeneratorPanel projectId={projectId} />
      <CaptionStylePanel inline />
    </div>
  )
}

// ─── AssetRail (vertical icon strip) ──────────────────────────────────────────

/**
 * AssetRail — fixed-width vertical icon rail at the left edge of the panel.
 *
 * Borrows IMG.LY's pattern: each category is an icon + tiny label stacked
 * vertically, making the rail scannable and leaving the content panel to the
 * right free for the actual browser. Clicking a rail item swaps the content.
 *
 * The rail width is fixed (~64px) regardless of how the user resizes the
 * asset panel — only the content area grows / shrinks. This is intentional:
 * the rail is navigation chrome, not content.
 */
/** Re-exported from `../types` so other files can import it from either place. */
export type { AssetTab } from '../types'

interface RailItem {
  id: AssetTab
  label: string
  icon: React.ReactNode
  title: string
}

function AssetRail({
  items,
  activeTab,
  onSelect,
}: {
  items: RailItem[]
  activeTab: AssetTab
  onSelect: (id: AssetTab) => void
}) {
  return (
    <div
      className="w-[88px] shrink-0 flex flex-col items-stretch py-2 gap-0.5 border-r border-border bg-card/60"
      role="tablist"
      aria-orientation="vertical"
      aria-label="Asset categories"
    >
      {items.map((item) => {
        const active = item.id === activeTab
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`asset-tab-${item.id}`}
            onClick={() => onSelect(item.id)}
            title={item.title}
            className={`
              relative mx-1 flex flex-col items-center justify-center gap-1 py-2 rounded-md transition-colors
              ${active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'}
            `}
          >
            {/* Active indicator — a 2px vertical pill on the left edge so the
                rail reads like a navigation column rather than a list of
                disconnected buttons. */}
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary"
              />
            )}
            <span className="shrink-0">{item.icon}</span>
            <span className="text-[10px] font-medium leading-tight">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// ─── AssetPanel Component ─────────────────────────────────────────────────────

/**
 * AssetPanel — left sidebar of the editor with a vertical asset rail.
 *
 * Layout:
 *   ┌────┬──────────────────────────────────┐
 *   │ ▣  │                                  │
 *   │Asse│                                  │
 *   │ts  │   Active category content        │
 *   │ ✨ │   (scrollable)                   │
 *   │ AI │                                  │
 *   │ ⤴  │                                  │
 *   │Upl │                                  │
 *   └────┴──────────────────────────────────┘
 *
 * Reads `projectId` from the URL params so it can scope asset queries without
 * the parent passing it. Keeps EditorPage clean and the panel self-contained.
 *
 * @example
 *   <AssetPanel />
 */
export function AssetPanel() {
  const { projectId } = useParams<{ projectId: string }>()
  // Tab state is in the editor store so external surfaces (e.g. InspectorPanel)
  // can switch tabs programmatically — see `setAssetTab` consumers.
  const activeTab = useUIStore((s) => s.assetTab)
  const setActiveTab = useUIStore((s) => s.setAssetTab)

  const extraTabs = useEditorHost().assetPanelExtraTabs ?? []

  const railItems: RailItem[] = [
    {
      id: 'my-assets',
      label: 'Assets',
      title: 'Browse your project assets',
      icon: <ImageIcon size={18} aria-hidden />,
    },
    ...extraTabs.map((t) => ({ id: t.id, label: t.label, title: t.title, icon: t.icon })),
    {
      id: 'upload',
      label: 'Upload',
      title: 'Upload local media files',
      icon: <UploadCloud size={18} aria-hidden />,
    },
    {
      id: 'voiceover',
      label: 'Voiceover',
      title: 'Record voiceover with your microphone',
      icon: <Mic size={18} aria-hidden />,
    },
    {
      id: 'captions',
      label: 'Captions',
      title: 'Add or generate captions',
      icon: <CaptionsIcon size={18} aria-hidden />,
    },
    {
      id: 'effects',
      label: 'Effects',
      title: 'Drag effects onto clips',
      icon: <Sparkles size={18} aria-hidden />,
    },
    {
      id: 'transitions',
      label: 'Transitions',
      title: 'Drag transitions onto clip edges or seams',
      icon: <Wand2 size={18} aria-hidden />,
    },
  ]

  return (
    <div className="flex h-full bg-card border-r border-border">
      <AssetRail items={railItems} activeTab={activeTab} onSelect={setActiveTab} />

      {/* Content area — fills the rest of the (resizable) asset panel. */}
      <div
        id={`asset-tab-${activeTab}`}
        role="tabpanel"
        className="flex-1 flex flex-col min-w-0"
        aria-label={railItems.find((t) => t.id === activeTab)?.label}
      >
        {/* The rail's active pill + label already announces the view, so the
            old uppercase "ASSETS" header was visual duplication. Each tab now
            owns its own top region for tighter, dedicated controls. */}
        <div className="flex-1 flex flex-col min-h-0">
          {activeTab === 'my-assets' && <MyAssetsTab projectId={projectId} />}
          {extraTabs.find((t) => t.id === activeTab)?.render({ projectId })}
          {activeTab === 'upload' && <UploadTab projectId={projectId} />}
          {activeTab === 'voiceover' && <VoiceoverPanel projectId={projectId} />}
          {activeTab === 'captions' && <CaptionsTab projectId={projectId} />}
          {activeTab === 'effects' && <EffectsPanel />}
          {activeTab === 'transitions' && <TransitionsPanel />}
        </div>
      </div>
    </div>
  )
}
