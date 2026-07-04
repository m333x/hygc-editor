/**
 * EditorHost — the single integration contract between the editor package and
 * the application embedding it.
 *
 * The editor owns timeline state, playback, rendering, and export mechanics.
 * Everything environment-specific — persistence, asset storage, auth identity,
 * server rendering, AI transcription — is provided by the host through this
 * interface. A host can be HyGC (Supabase-backed), the standalone dev app
 * (localStorage-backed), or any future consumer.
 *
 * Optional capabilities (`serverExport`, `transcribeAudio`, `assetPanelExtraTabs`,
 * `projects.seed`) degrade gracefully: the UI for a capability hides when the
 * host doesn't provide it.
 */

import type { ComponentType, ReactNode } from 'react'
import type { SerializedEditorState } from '../types'

// ─── Assets ──────────────────────────────────────────────────────────────────

export type EditorAssetType = 'image' | 'video' | 'audio'
export type EditorAssetSource = 'uploaded' | 'ai_generated' | 'rendered'

/**
 * The subset of a host asset record the editor reads. Host asset types with
 * more fields (e.g. Supabase rows) satisfy this structurally.
 */
export interface EditorAsset {
  id: string
  type: EditorAssetType
  storage_path?: string | null
  public_url?: string | null
  metadata?: Record<string, unknown> | null
}

/** Maps of clip assetId → playable URL / media kind, consumed by the preview and export. */
export interface ResolvedAssetUrls {
  assetUrlMap: Record<string, string>
  assetTypeMap: Record<string, EditorAssetType>
}

/** Reactive asset-library surface backing the asset panel and voiceover upload. */
export interface AssetLibrary {
  assets: EditorAsset[]
  loading: boolean
  uploading: boolean
  error: string | null
  typeFilter: EditorAssetType | 'all'
  setTypeFilter: (type: EditorAssetType | 'all') => void
  sourceFilter: EditorAssetSource | 'all'
  setSourceFilter: (source: EditorAssetSource | 'all') => void
  searchQuery: string
  setSearchQuery: (query: string) => void
  upload: (
    file: File,
    projectId: string,
    type: EditorAssetType,
    metadata?: Record<string, unknown>,
  ) => Promise<EditorAsset | null>
  remove: (assetId: string) => Promise<boolean>
  refetch: () => Promise<void>
}

export interface AssetLibraryOptions {
  /** 'project' = assets linked to the given project; 'all' = every user asset. */
  scope?: 'project' | 'all'
}

// ─── Drag contract (asset browser → timeline) ────────────────────────────────

/**
 * dataTransfer MIME type identifying a dragged library asset. The host's asset
 * browser serialises a {@link DraggedAssetPayload} under this key; the
 * timeline's drop targets read it.
 */
export const ASSET_DRAG_MIME_TYPE = 'application/hygc-asset'

export interface DraggedAssetPayload {
  id: string
  type: EditorAssetType
  public_url: string | null
  duration_ms: number | null
  filename: string | null
}

// ─── Asset browser slot ──────────────────────────────────────────────────────

export type AssetViewMode = 'grid' | 'list'

export interface UploadProgressInfo {
  /** Number of files already completed (not including the current one). */
  completed: number
  /** Total files in this batch. */
  total: number
  /** Display name of the file currently being uploaded. */
  currentFilename: string | null
}

/**
 * Props the editor passes to the host's asset browser component. The browser
 * renders the library grid/list; cards must be draggable via the drag contract
 * above when `draggableAssets` is set.
 */
export interface EditorAssetBrowserProps {
  assets: EditorAsset[]
  loading: boolean
  uploading: boolean
  error: string | null
  typeFilter: EditorAssetType | 'all'
  onTypeFilterChange: (type: EditorAssetType | 'all') => void
  sourceFilter: EditorAssetSource | 'all'
  onSourceFilterChange: (source: EditorAssetSource | 'all') => void
  searchQuery: string
  onSearchChange: (query: string) => void
  onUpload: (files: File[]) => void
  uploadProgress?: UploadProgressInfo | null
  onDelete: (assetId: string) => void
  onSelect: (asset: EditorAsset) => void
  compact?: boolean
  draggableAssets?: boolean
  viewMode?: AssetViewMode
  projectId?: string
}

// ─── Projects ────────────────────────────────────────────────────────────────

export interface EditorProjectRecord {
  id: string
  title: string
  created_at: string
  updated_at: string
  editor_state: SerializedEditorState | null
}

export interface EditorHostResult<T> {
  data: T | null
  error: { message: string } | null
}

export interface EditorProjectsApi {
  get(id: string): Promise<EditorHostResult<EditorProjectRecord>>
  saveState(id: string, state: SerializedEditorState): Promise<{ error: { message: string } | null }>
  rename(id: string, title: string): Promise<EditorHostResult<EditorProjectRecord>>
  /**
   * Optional: build initial content for a project whose timeline is empty
   * (e.g. HyGC seeds from a linked UGC ad). Return null when no seed applies.
   * The editor persists the returned state and title itself.
   */
  seed?(id: string): Promise<{ state: SerializedEditorState; title: string } | null>
}

// ─── Server export (optional capability) ─────────────────────────────────────

export type ExportResolution = '720p' | '1080p' | '2160p'
export type ExportFps = 24 | 30 | 60
export type ExportQuality = 'standard' | 'high'

export interface ExportOptions {
  resolution: ExportResolution
  fps: ExportFps
  quality: ExportQuality
  includeAudio: boolean
  filename?: string
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  resolution: '1080p',
  fps: 30,
  quality: 'high',
  includeAudio: true,
}

export interface ServerExportJobUpdate {
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'canceled'
  progress?: number
  outputAssetId?: string | null
  outputUrl?: string | null
  errorMessage?: string | null
}

/** Fields of a past export the history list renders. */
export interface ServerExportRecord {
  id: string
  resolution: string
  created_at: string
  expires_at: string | null
}

export interface ServerExportApi {
  start(request: {
    projectId: string
    options: ExportOptions
    timeline: SerializedEditorState
  }): Promise<{ jobId: string; exportId: string | null; creditsCharged: number }>
  /** Subscribe to job progress/status. Returns an unsubscribe function. */
  subscribeToJob(jobId: string, onUpdate: (update: ServerExportJobUpdate) => void): () => void
  getDownloadUrl(exportId: string): Promise<string | null>
  listHistory(projectId: string): Promise<ServerExportRecord[]>
  /** Credit cost preview shown before the user commits. */
  getCost(options: Pick<ExportOptions, 'resolution' | 'fps' | 'quality'>): number
  /** Optional "Save to Library" action for a completed export's output asset. */
  saveToLibrary?(outputAssetId: string | null): Promise<void>
}

// ─── Transcription (optional capability) ─────────────────────────────────────

export interface TranscriptSegment {
  id: string
  startMs: number
  endMs: number
  text: string
}

export interface TranscribeAudioRequest {
  audioUrl: string
  projectId?: string
  options: {
    maxWordsPerSegment: number
    language: string
    punctuate: boolean
    filterProfanity: boolean
  }
}

// ─── Asset panel extension tabs ──────────────────────────────────────────────

export interface AssetPanelExtraTab {
  id: string
  label: string
  title: string
  icon: ReactNode
  render: (ctx: { projectId?: string }) => ReactNode
}

// ─── The host contract ───────────────────────────────────────────────────────

export interface EditorHost {
  projects: EditorProjectsApi

  /** Resolve timeline asset ids to playable URLs for preview and export. */
  resolveAssetUrls(assetIds: string[]): Promise<ResolvedAssetUrls>

  /**
   * Reactive asset-library hook. Must obey the Rules of Hooks — the editor
   * calls it unconditionally from components. Hosts typically pass an existing
   * hook (HyGC passes `useAssets`).
   */
  useAssetLibrary(editorProjectId?: string, options?: AssetLibraryOptions): AssetLibrary

  /** Library browser UI rendered in the asset panel's "Assets" tab. */
  AssetBrowser: ComponentType<EditorAssetBrowserProps>

  /** Server-side rendering + credits + history. Absent → local export only. */
  serverExport?: ServerExportApi

  /** AI caption transcription. Absent → the Generate Captions action hides. */
  transcribeAudio?(request: TranscribeAudioRequest): Promise<{ segments: TranscriptSegment[] }>

  /** Extra tabs appended to the asset panel rail (e.g. HyGC's AI tools tab). */
  assetPanelExtraTabs?: AssetPanelExtraTab[]

  /** Toolbar back-link target (e.g. HyGC's planner). Absent → no back button. */
  exit?: { path: string; title?: string }
}
