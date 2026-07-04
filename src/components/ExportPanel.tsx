/**
 * ExportPanel — export UI for the NLE editor.
 *
 * Provides the complete export interface as specified in PLAN.md Phase 3.9:
 *   - Resolution picker (720p / 1080p) with credit cost display
 *   - "Export" button with credit cost confirmation
 *   - Progress bar during render (via Realtime subscription)
 *   - Download button on completion
 *   - Export history list with past exports
 *   - Error display with retry option
 *
 * The panel adapts its layout based on the `inline` prop:
 *   - `inline={false}` (default): Standalone panel used in the desktop toolbar
 *     popover. Includes a header, padding, and full export history.
 *   - `inline={true}`: Compact version used in the mobile bottom sheet's
 *     Export tab. No header, reduced padding, scrollable history.
 *
 * State management:
 *   All export state (phase, progress, error, download URL) is managed by
 *   the `useExport` hook. This component is purely presentational — it reads
 *   the hook's state and dispatches its actions.
 *
 * SOLID: SRP — only renders the export UI. No export logic, no API calls.
 * SOLID: DIP — depends on the useExport hook's interface, not on services
 *   or Supabase directly.
 *
 * @see useExport.ts — the hook that manages export state
 * @see EditorToolbar.tsx — desktop integration (Export button + popover)
 * @see MobileBottomSheet.tsx — mobile integration (Export tab)
 * @see PLAN.md Phase 3.9 for export UI spec
 * @see README.md Section 7.7 for export pipeline specification
 */

import { useState } from 'react'
import { useExport } from '../hooks/useExport'
import { useEditorHost } from '../host'
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportFps,
  type ExportOptions,
  type ExportQuality,
  type ExportResolution,
} from '../host'
import type { ExportPhase } from '../hooks/useExport'
import type { WebExportCodec } from '../engine/web-export'

// ─── Props ──────────────────────────────────────────────────────────────────────

export interface ExportPanelProps {
  /** Project ID from route params. */
  projectId: string | undefined

  /**
   * When true, renders in compact "inline" mode for the mobile bottom sheet.
   * Omits the panel header and reduces spacing.
   */
  inline?: boolean

  /**
   * Optional callback fired when the export completes successfully.
   * Used by the toolbar to close the popover on completion download.
   */
  onExportComplete?: () => void
}

// ─── Picker Option Tables ────────────────────────────────────────────────────────

interface ResolutionOption {
  value: ExportResolution
  label: string
  dimensions: string
  hint: string
}

const RESOLUTION_OPTIONS: ResolutionOption[] = [
  { value: '720p', label: '720p', dimensions: '720 × 1280', hint: 'Lightweight' },
  { value: '1080p', label: '1080p', dimensions: '1080 × 1920', hint: 'Recommended' },
  { value: '2160p', label: '4K', dimensions: '2160 × 3840', hint: 'Pro' },
]

interface FpsOption {
  value: ExportFps
  label: string
  hint: string
}

const FPS_OPTIONS: FpsOption[] = [
  { value: 24, label: '24', hint: 'Cinematic' },
  { value: 30, label: '30', hint: 'Standard' },
  { value: 60, label: '60', hint: 'Smooth' },
]

interface QualityOption {
  value: ExportQuality
  label: string
  hint: string
}

const QUALITY_OPTIONS: QualityOption[] = [
  { value: 'standard', label: 'Standard', hint: 'CRF 23 · smaller files' },
  { value: 'high', label: 'High', hint: 'CRF 18 · archival' },
]

/** Codec options for the local (in-browser) export path. Server export is always H.264. */
const CODEC_OPTIONS: Array<{ value: WebExportCodec; label: string; hint: string }> = [
  { value: 'h264', label: 'H.264', hint: 'Most compatible' },
  { value: 'h265', label: 'H.265', hint: 'Smaller · newer devices' },
  { value: 'av1', label: 'AV1', hint: 'Smallest · newest' },
]

// ─── Sub-Components ──────────────────────────────────────────────────────────────

/**
 * ProgressBar — animated progress indicator for the render job.
 *
 * Shows a thin horizontal bar that fills from left to right as progress
 * increases from 0 to 1. Uses CSS transitions for smooth animation.
 * Below the bar, shows the percentage and a status label.
 */
function ProgressBar({
  progress,
  phase,
}: {
  progress: number
  phase: ExportPhase
}) {
  const percentage = Math.round(progress * 100)
  const statusLabel =
    phase === 'queued'
      ? 'Queued — waiting for render server...'
      : phase === 'processing'
        ? `Rendering... ${percentage}%`
        : phase === 'completed'
          ? 'Export complete!'
          : 'Export failed'

  return (
    <div className="space-y-2">
      {/* Progress track */}
      <div
        className="h-2 rounded-full bg-muted overflow-hidden"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={statusLabel}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ease-out ${
            phase === 'completed'
              ? 'bg-success'
              : phase === 'failed'
                ? 'bg-destructive'
                : 'bg-ring'
          }`}
          style={{ width: `${percentage}%` }}
        />
      </div>

      {/* Status text */}
      <div className="flex items-center justify-between text-xs">
        <span
          className={
            phase === 'completed'
              ? 'text-success font-medium'
              : phase === 'failed'
                ? 'text-destructive font-medium'
                : 'text-muted-foreground'
          }
        >
          {statusLabel}
        </span>
        {phase === 'processing' && (
          <span className="text-muted-foreground tabular-nums">{percentage}%</span>
        )}
      </div>
    </div>
  )
}

/**
 * ExportHistoryItem — a single row in the export history list.
 *
 * Shows the resolution, date, and a download link for past exports.
 */
function ExportHistoryItem({
  resolution,
  createdAt,
  expiresAt,
}: {
  resolution: string
  createdAt: string
  expiresAt: string | null
}) {
  const date = new Date(createdAt)
  const formattedDate = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const isExpired = expiresAt ? new Date(expiresAt) < new Date() : false

  return (
    <div className="flex items-center justify-between py-2 border-b border-border last:border-0">
      <div className="flex items-center gap-2">
        {/* Film icon */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden
          className="text-muted-foreground shrink-0"
        >
          <rect
            x="1"
            y="2"
            width="12"
            height="10"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <line
            x1="4"
            y1="2"
            x2="4"
            y2="12"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.5"
          />
          <line
            x1="10"
            y1="2"
            x2="10"
            y2="12"
            stroke="currentColor"
            strokeWidth="1"
            opacity="0.5"
          />
        </svg>
        <div>
          <span className="text-xs font-medium text-foreground">{resolution}</span>
          <span className="text-[10px] text-muted-foreground ml-2">{formattedDate}</span>
        </div>
      </div>
      {isExpired ? (
        <span className="text-[10px] text-muted-foreground italic">Expired</span>
      ) : (
        <span className="text-[10px] text-muted-foreground">Available</span>
      )}
    </div>
  )
}

/**
 * SegmentedRow — a labeled, segmented control used by the advanced pickers.
 *
 * Renders as: [label] [segment | segment | segment]   trailing
 * with a single highlighted segment indicating the current value. Sized for
 * a 360px popover, so each segment shrinks gracefully on narrow widths.
 */
function SegmentedRow({
  label,
  trailing,
  options,
  value,
  onChange,
}: {
  label: string
  trailing?: string
  options: Array<{ value: string; label: string; hint: string }>
  value: string
  onChange: (next: string) => void
}) {
  const active = options.find((o) => o.value === value)

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {active && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {active.hint}
            {trailing ? ` · ${trailing}` : ''}
          </span>
        )}
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-border bg-card/40 p-0.5"
      >
        {options.map((opt) => {
          const selected = opt.value === value
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={`
                rounded-md py-1 text-xs font-medium tabular-nums transition-colors duration-150 ease-out
                ${
                  selected
                    ? 'bg-ring/15 text-foreground shadow-[0_1px_0_oklch(1_0_0/0.06)_inset]'
                    : 'text-muted-foreground hover:text-foreground'
                }
              `}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── ExportPanel Component ──────────────────────────────────────────────────────

/**
 * ExportPanel — renders the export interface.
 *
 * @example
 *   // Desktop: inside a popover triggered by toolbar button
 *   <ExportPanel projectId={projectId} />
 *
 *   // Mobile: inside the bottom sheet Export tab
 *   <ExportPanel projectId={projectId} inline />
 */
export function ExportPanel({ projectId, inline = false, onExportComplete }: ExportPanelProps) {
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  /** Local-export codec — separate from ExportOptions since the server path is always H.264. */
  const [codec, setCodec] = useState<WebExportCodec>('h264')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [savingToLibrary, setSavingToLibrary] = useState(false)
  const host = useEditorHost()
  const saveToLibrary = host.serverExport?.saveToLibrary

  const {
    phase,
    progress,
    error,
    downloadUrl,
    outputAssetId,
    creditsCharged,
    canExport,
    canServerExport,
    canWebExport,
    exportHistory,
    historyLoading,
    startExport,
    exportOnWeb,
    resetExport,
    getCreditCost,
  } = useExport(projectId)

  const creditCost = getCreditCost(options)
  const advancedDirty =
    options.fps !== DEFAULT_EXPORT_OPTIONS.fps ||
    options.quality !== DEFAULT_EXPORT_OPTIONS.quality ||
    options.includeAudio !== DEFAULT_EXPORT_OPTIONS.includeAudio ||
    Boolean(options.filename && options.filename.length > 0)

  // ── Handlers ──

  function handleExport() {
    startExport(options)
  }

  function handleWebExport() {
    exportOnWeb(options, codec)
  }

  function patchOptions(patch: Partial<ExportOptions>) {
    setOptions((prev) => ({ ...prev, ...patch }))
  }

  function handleDownload() {
    if (downloadUrl) {
      window.open(downloadUrl, '_blank')
      onExportComplete?.()
    }
  }

  function handleReset() {
    resetExport()
  }

  async function handleSaveToLibrary() {
    if (!saveToLibrary) return
    setSavingToLibrary(true)
    try {
      await saveToLibrary(outputAssetId)
    } finally {
      setSavingToLibrary(false)
    }
  }

  // ── Render: Active Export (not idle) ──

  const isActive = phase !== 'idle'

  return (
    <div className={inline ? 'space-y-4' : 'space-y-4 p-4'}>
      {/* Header (desktop only) */}
      {!inline && (
        <div className="flex items-center gap-2">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden
            className="text-foreground shrink-0"
          >
            <path
              d="M8 2V10M8 2L5 5M8 2L11 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M2 12H14"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <h3 className="text-sm font-semibold text-foreground tracking-tight">Export video</h3>
        </div>
      )}

      {/* ── Resolution Picker ── */}
      {canExport && (
        <div className="space-y-2">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Resolution
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {RESOLUTION_OPTIONS.map((option) => {
              const isSelected = options.resolution === option.value
              const cost = canServerExport
                ? getCreditCost({
                    resolution: option.value,
                    fps: options.fps,
                    quality: options.quality,
                  })
                : null

              return (
                <button
                  key={option.value}
                  onClick={() => patchOptions({ resolution: option.value })}
                  className={`
                    relative flex flex-col items-start gap-0.5 px-2.5 py-2 rounded-xl border text-left
                    transition-[border-color,background-color,box-shadow] duration-150 ease-out
                    ${
                      isSelected
                        ? 'border-ring/70 bg-ring/[0.06] ring-2 ring-ring/30'
                        : 'border-border bg-card/40 hover:border-ring/40 hover:bg-card'
                    }
                  `}
                  aria-pressed={isSelected}
                >
                  <span className="text-sm font-semibold text-foreground leading-none">
                    {option.label}
                  </span>
                  <span className="text-[9px] text-muted-foreground tabular-nums leading-tight">
                    {option.dimensions}
                  </span>
                  <span
                    className={`mt-0.5 text-[9px] leading-none tabular-nums ${
                      isSelected ? 'text-ring' : 'text-muted-foreground'
                    }`}
                  >
                    {cost != null ? `${cost} cr · ${option.hint}` : option.hint}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Advanced options ── */}
      {canExport && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="w-full flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={showAdvanced}
            aria-controls="export-advanced"
          >
            <span className="flex items-center gap-2">
              Advanced
              {advancedDirty && !showAdvanced && (
                <span className="h-1.5 w-1.5 rounded-full bg-ring" aria-hidden />
              )}
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 10 10"
              fill="none"
              aria-hidden
              className={`transition-transform duration-150 ease-out ${
                showAdvanced ? 'rotate-180' : ''
              }`}
            >
              <path
                d="M2 4L5 7L8 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {showAdvanced && (
            <div id="export-advanced" className="space-y-3 pt-1">
              {/* FPS */}
              <SegmentedRow
                label="Frame rate"
                trailing="fps"
                options={FPS_OPTIONS.map((o) => ({
                  value: String(o.value),
                  label: o.label,
                  hint: o.hint,
                }))}
                value={String(options.fps)}
                onChange={(v) => patchOptions({ fps: Number(v) as ExportFps })}
              />

              {/* Quality */}
              <SegmentedRow
                label="Quality"
                options={QUALITY_OPTIONS.map((o) => ({
                  value: o.value,
                  label: o.label,
                  hint: o.hint,
                }))}
                value={options.quality}
                onChange={(v) => patchOptions({ quality: v as ExportQuality })}
              />

              {/* Codec — applies to local (in-browser) export only; the server
                  path always emits H.264. Shown only when local export works. */}
              {canWebExport && (
                <SegmentedRow
                  label="Local codec"
                  options={CODEC_OPTIONS.map((o) => ({
                    value: o.value,
                    label: o.label,
                    hint: o.hint,
                  }))}
                  value={codec}
                  onChange={(v) => setCodec(v as WebExportCodec)}
                />
              )}

              {/* Audio toggle */}
              <div className="flex items-center justify-between gap-3 py-1">
                <div className="flex flex-col">
                  <span className="text-xs font-medium text-foreground">Include audio</span>
                  <span className="text-[10px] text-muted-foreground leading-tight">
                    AAC 192 kbps muxed into the MP4
                  </span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={options.includeAudio}
                  onClick={() => patchOptions({ includeAudio: !options.includeAudio })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                    options.includeAudio ? 'bg-ring' : 'bg-muted'
                  }`}
                >
                  <span
                    className={`h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out ${
                      options.includeAudio ? 'translate-x-4' : 'translate-x-0'
                    }`}
                    aria-hidden
                  />
                </button>
              </div>

              {/* Filename */}
              <div className="space-y-1">
                <label
                  htmlFor="export-filename"
                  className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                >
                  Filename
                </label>
                <div className="relative">
                  <input
                    id="export-filename"
                    type="text"
                    inputMode="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={options.filename ?? ''}
                    onChange={(e) =>
                      patchOptions({ filename: e.target.value.length > 0 ? e.target.value : undefined })
                    }
                    placeholder="my-export"
                    maxLength={64}
                    className="w-full rounded-lg border border-border bg-card/40 px-2.5 py-1.5 pr-10 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-ring/70 focus:ring-2 focus:ring-ring/20 transition-colors"
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground tabular-nums">
                    .mp4
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Output specs strip ── */}
      {canExport && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
          <span className="text-[10px] text-muted-foreground">Output</span>
          <span className="text-[10px] font-medium text-foreground tabular-nums">
            H.264 MP4 · {options.fps} fps · {options.includeAudio ? 'AAC 192k' : 'no audio'}
          </span>
        </div>
      )}

      {/* ── Export Button ── */}
      {canExport && (
        <div className="space-y-2">
          {canServerExport && (
            <button
              onClick={handleExport}
              disabled={!canExport}
              className="group relative w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_1px_0_oklch(1_0_0/0.12)_inset,0_8px_24px_-12px_oklch(0_0_0/0.4)]"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M7 2V9M7 2L4 5M7 2L10 5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="M2 11H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>Export</span>
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary-foreground/15 text-[10px] font-semibold tabular-nums leading-none">
                {creditCost} credits
              </span>
            </button>
          )}

          {/* Client-side fast path — renders in-browser with WebCodecs, no
              credits, downloads directly. Shown only on capable browsers
              (Chrome/Firefox). Secondary when a server path exists; primary
              styling when local export is the only option. */}
          {canWebExport && (
            <button
              onClick={handleWebExport}
              disabled={!canExport}
              className={
                canServerExport
                  ? 'group relative w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-border bg-card/40 text-sm font-medium text-foreground hover:bg-card transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
                  : 'group relative w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-[0_1px_0_oklch(1_0_0/0.12)_inset,0_8px_24px_-12px_oklch(0_0_0/0.4)]'
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path
                  d="M7 1.5L8.6 5.2L12.5 5.5L9.5 8L10.5 11.8L7 9.7L3.5 11.8L4.5 8L1.5 5.5L5.4 5.2L7 1.5Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Export locally</span>
              {canServerExport && (
                <span className="ml-1 px-1.5 py-0.5 rounded-full bg-ring/15 text-[10px] font-semibold leading-none text-ring">
                  free · beta
                </span>
              )}
            </button>
          )}

          {!canServerExport && !canWebExport && (
            <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
              This browser can't export locally (WebCodecs unavailable). Try Chrome.
            </p>
          )}

          {canServerExport && (
            <p className="text-[10px] text-muted-foreground text-center leading-relaxed">
              Available for 30 days from export.
            </p>
          )}
        </div>
      )}

      {/* ── Progress / Status ── */}
      {isActive && (
        <div className="space-y-3">
          <ProgressBar progress={progress} phase={phase} />

          {/* Download button (on completion) */}
          {phase === 'completed' && (downloadUrl || outputAssetId) && (
            <div className="flex flex-col gap-2">
              {downloadUrl && (
                <button
                  onClick={handleDownload}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-success text-success-foreground text-sm font-medium hover:bg-success/90 transition-colors"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
                    <path
                      d="M7 2V9M7 9L4 6M7 9L10 6"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path d="M2 11H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                  Download MP4
                </button>
              )}
              {saveToLibrary && (
                <button
                  type="button"
                  onClick={() => void handleSaveToLibrary()}
                  disabled={savingToLibrary}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-border bg-card text-sm font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {savingToLibrary ? 'Saving…' : 'Save to Library'}
                </button>
              )}
            </div>
          )}

          {/* Completed without download URL (render server not configured) */}
          {phase === 'completed' && !downloadUrl && canServerExport && (
            <p className="text-xs text-muted-foreground text-center">
              Export job completed. The download link will be available once the
              render server processes the job.
            </p>
          )}

          {/* Error display */}
          {phase === 'failed' && error && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
              <p className="text-xs text-destructive font-medium mb-1">Export Failed</p>
              <p className="text-[10px] text-destructive/80 leading-relaxed">{error}</p>
            </div>
          )}

          {/* Credits charged note */}
          {creditsCharged > 0 && (
            <p className="text-[10px] text-muted-foreground text-center">
              {phase === 'failed'
                ? `${creditsCharged} credits will be refunded.`
                : `${creditsCharged} credits charged.`}
            </p>
          )}

          {/* Reset / New Export button */}
          {(phase === 'completed' || phase === 'failed') && (
            <button
              onClick={handleReset}
              className="w-full px-3 py-2 rounded-lg border border-border text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
            >
              {phase === 'failed' ? 'Try Again' : 'New Export'}
            </button>
          )}
        </div>
      )}

      {/* ── Export History ── */}
      {exportHistory.length > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Recent Exports</h4>
          <div className="rounded-lg border border-border divide-y divide-border">
            {exportHistory.map((exp) => (
              <ExportHistoryItem
                key={exp.id}
                resolution={exp.resolution}
                createdAt={exp.created_at}
                expiresAt={exp.expires_at}
              />
            ))}
          </div>
        </div>
      )}

      {historyLoading && exportHistory.length === 0 && (
        <p className="text-[10px] text-muted-foreground text-center animate-pulse">
          Loading export history...
        </p>
      )}
    </div>
  )
}
