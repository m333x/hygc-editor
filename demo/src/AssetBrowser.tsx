/**
 * Demo asset browser — the component the host plugs into the editor's asset
 * panel (`EditorHost.AssetBrowser`). Renders the library grid, wires uploads,
 * and makes cards draggable per the editor's drag contract.
 */

import { useRef } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import { Loader2, Music, Search, Trash2, Upload } from 'lucide-react'
import {
  ASSET_DRAG_MIME_TYPE,
  type DraggedAssetPayload,
  type EditorAsset,
  type EditorAssetBrowserProps,
  type EditorAssetType,
} from '@hygc/editor'

const TYPE_FILTERS: Array<{ value: EditorAssetType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'video', label: 'Video' },
  { value: 'image', label: 'Images' },
  { value: 'audio', label: 'Audio' },
]

function assetName(asset: EditorAsset): string {
  const name = asset.metadata?.filename
  return typeof name === 'string' && name.length > 0 ? name : 'Untitled'
}

function assetDuration(asset: EditorAsset): number | null {
  const v = asset.metadata?.duration_ms
  return typeof v === 'number' ? v : null
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function AssetCard({
  asset,
  draggable,
  onSelect,
  onDelete,
}: {
  asset: EditorAsset
  draggable: boolean
  onSelect: (asset: EditorAsset) => void
  onDelete: (assetId: string) => void
}) {
  const url = asset.public_url ?? undefined
  const duration = assetDuration(asset)

  const handleDragStart = (e: DragEvent) => {
    const payload: DraggedAssetPayload = {
      id: asset.id,
      type: asset.type,
      public_url: asset.public_url ?? null,
      duration_ms: duration,
      filename: assetName(asset),
    }
    e.dataTransfer.setData(ASSET_DRAG_MIME_TYPE, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={handleDragStart}
      onClick={() => onSelect(asset)}
      className="group relative aspect-video cursor-grab overflow-hidden rounded-lg border border-border bg-card text-left transition-colors hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      title={assetName(asset)}
    >
      {asset.type === 'video' && (
        <video
          src={url}
          muted
          playsInline
          preload="metadata"
          className="pointer-events-none h-full w-full object-cover"
        />
      )}
      {asset.type === 'image' && (
        <img
          src={url}
          alt={assetName(asset)}
          loading="lazy"
          className="pointer-events-none h-full w-full object-cover"
        />
      )}
      {asset.type === 'audio' && (
        <div className="pointer-events-none flex h-full w-full items-center justify-center bg-gradient-to-br from-clip-audio-bg to-editor-chrome">
          <Music className="size-7 text-clip-audio-fg/90" />
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-1.5 pt-5">
        <span className="truncate text-[11px] leading-tight text-white/90">
          {assetName(asset)}
        </span>
        {duration !== null && (
          <span className="shrink-0 rounded bg-black/60 px-1 py-px font-mono text-[10px] text-white/80">
            {formatDuration(duration)}
          </span>
        )}
      </div>

      <span
        role="button"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation()
          onDelete(asset.id)
        }}
        className="absolute top-1 right-1 hidden rounded-md bg-black/60 p-1 text-white/80 hover:bg-destructive hover:text-destructive-foreground group-hover:block"
        aria-label={`Remove ${assetName(asset)}`}
      >
        <Trash2 className="size-3.5" />
      </span>
    </button>
  )
}

export function DemoAssetBrowser({
  assets,
  loading,
  uploading,
  error,
  typeFilter,
  onTypeFilterChange,
  searchQuery,
  onSearchChange,
  onUpload,
  uploadProgress,
  onDelete,
  onSelect,
  compact,
  draggableAssets,
}: EditorAssetBrowserProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    if (files.length > 0) onUpload(files)
    e.target.value = ''
  }

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search assets…"
            className="h-8 w-full rounded-md border border-input bg-editor-chrome-soft pr-2 pl-7 text-xs text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          Upload
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          className="hidden"
          onChange={handleFiles}
        />
      </div>

      <div className="flex gap-1">
        {TYPE_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => onTypeFilterChange(f.value)}
            className={
              typeFilter === f.value
                ? 'rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-accent-foreground'
                : 'rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {uploading && uploadProgress && (
        <p className="truncate text-[11px] text-muted-foreground">
          Uploading {uploadProgress.completed + 1}/{uploadProgress.total}
          {uploadProgress.currentFilename ? ` — ${uploadProgress.currentFilename}` : ''}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        ) : assets.length === 0 ? (
          <div className="flex h-32 flex-col items-center justify-center gap-1 text-center">
            <p className="text-xs text-muted-foreground">No assets match.</p>
            <p className="text-[11px] text-muted-foreground/70">
              Upload video, images, or audio — or clear the filters.
            </p>
          </div>
        ) : (
          <div className={compact ? 'grid grid-cols-2 gap-2' : 'grid grid-cols-3 gap-2'}>
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                draggable={draggableAssets ?? false}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-[10px] leading-snug text-muted-foreground/70">
        Drag assets onto the timeline. Uploads stay in your browser — nothing
        leaves this machine.
      </p>
    </div>
  )
}
