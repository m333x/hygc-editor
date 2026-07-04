/**
 * Determinate progress bar driven by completed-file count. Indeterminate
 * (sliding stripe) for single-file batches so the user gets motion feedback
 * rather than a stuck 0%.
 */

import type { UploadProgressInfo } from '../host/types'

export function UploadProgressBar({
  uploading,
  progress,
  compact,
}: {
  uploading: boolean
  progress?: UploadProgressInfo | null
  compact?: boolean
}) {
  if (!uploading) return null

  const indeterminate = !progress || progress.total <= 1
  const pct =
    progress && progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0

  return (
    <div className={`w-full ${compact ? 'mt-1' : 'mt-1.5'}`}>
      <div
        className={`relative w-full overflow-hidden rounded-full bg-secondary/60 ${compact ? 'h-1' : 'h-1.5'}`}
      >
        {indeterminate ? (
          <div
            className="absolute inset-y-0 w-1/3 rounded-full bg-primary"
            style={{ animation: 'upload-indeterminate 1.2s linear infinite' }}
          />
        ) : (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
      {progress?.currentFilename && (
        <p
          className={`mt-1 truncate text-[10px] text-muted-foreground/80 ${compact ? '' : 'text-center'}`}
          title={progress.currentFilename}
        >
          {progress.currentFilename}
        </p>
      )}
      <style>{`
        @keyframes upload-indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  )
}
