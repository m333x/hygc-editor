/**
 * CaptionGeneratorPanel — caption *creation* surface.
 *
 * Two equally-weighted actions; the user picks the workflow that fits the
 * moment, not a hero + escape pair:
 *   - **Generate Captions** — primary CTA. Transcribes voiceover audio via
 *     `useCaptionGeneration` and places caption clips on a caption track.
 *     Requires at least one audio clip on a voice-labelled audio track;
 *     spends credits (2 credits/min of audio).
 *   - **Add caption** — secondary CTA. Drops a single empty caption clip at
 *     the playhead. No credits, no transcription; the user types text in the
 *     Inspector. Useful for one-off captions or when there's no voiceover.
 *
 * Layout: two stacked full-width buttons with matched dimensions so neither
 * reads as a fallback to the other. The credit hint sits between them where
 * it visually anchors to Generate (its only consumer) without becoming a
 * floating island.
 *
 * Separated from `CaptionStylePanel` because the two surfaces have no shared
 * data dependency: a user can generate without restyling, and restyle without
 * generating.
 */

import { Loader2, Sparkles, Info, Plus } from 'lucide-react'

import { useCaptionGeneration } from '../hooks/useCaptionGeneration'
import { useAddManualCaption } from '../hooks/useAddManualCaption'

export interface CaptionGeneratorPanelProps {
  /** Project ID used by `useCaptionGeneration` to fetch source audio. */
  projectId?: string
}

export function CaptionGeneratorPanel({ projectId }: CaptionGeneratorPanelProps) {
  const { addManualCaption } = useAddManualCaption()
  const { isGenerating, error, canGenerate, lastGeneratedCount, generateCaptions } =
    useCaptionGeneration(projectId)

  return (
    <div className="mb-4">
      <button
        onClick={() => generateCaptions()}
        disabled={!canGenerate || isGenerating}
        className={`
          w-full h-9 flex items-center justify-center gap-2 px-3 rounded-lg
          text-xs font-medium transition-colors
          ${canGenerate && !isGenerating
            ? 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm'
            : 'bg-muted text-muted-foreground cursor-not-allowed'
          }
        `}
        title={
          !canGenerate
            ? 'Add audio clips to a Voiceover track first'
            : isGenerating
              ? 'Generation in progress…'
              : 'Transcribe voiceover audio and create caption clips'
        }
      >
        {isGenerating ? (
          <>
            <Loader2 size={13} className="animate-spin shrink-0" />
            Generating captions…
          </>
        ) : (
          <>
            <Sparkles size={13} className="shrink-0" />
            Generate Captions
          </>
        )}
      </button>

      <p className="my-1.5 text-[10px] text-muted-foreground/70 text-center leading-tight">
        {canGenerate || isGenerating ? (
          '2 credits/min of audio'
        ) : (
          <span className="inline-flex items-center gap-1">
            <Info size={10} aria-hidden className="shrink-0" />
            Add a Voiceover track to enable
          </span>
        )}
      </p>

      <button
        type="button"
        onClick={addManualCaption}
        className="w-full h-9 flex items-center justify-center gap-2 px-3 rounded-lg text-xs font-medium border border-border bg-background text-foreground hover:bg-muted hover:border-border/80 transition-colors"
        title="Add an empty caption at the current playhead; edit text in the Inspector."
      >
        <Plus size={13} className="shrink-0" />
        Add caption
      </button>

      {lastGeneratedCount > 0 && !isGenerating && !error && (
        <p className="mt-2 text-[10px] text-success font-medium text-center">
          ✓ Created {lastGeneratedCount} caption{lastGeneratedCount !== 1 ? 's' : ''}
        </p>
      )}

      {error && (
        <p className="mt-2 text-[10px] text-destructive leading-snug">{error}</p>
      )}
    </div>
  )
}
