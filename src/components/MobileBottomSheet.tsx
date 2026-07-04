/**
 * MobileBottomSheet — bottom sheet navigation for the mobile editor layout.
 *
 * On mobile, the editor cannot use a three-column resizable panel layout
 * because the viewport is too narrow. Instead, the Asset Panel, Inspector
 * Panel, and Caption Style Panel are collapsed into a bottom sheet with tabs:
 *
 *   [Assets] [Inspector] [Captions] [Export]
 *
 * The bottom sheet sits below the Timeline area and slides up to reveal
 * its content. On small screens, users tap a tab to switch content without
 * losing the timeline or preview above.
 *
 * Mobile editor layout (top to bottom, as specified in README.md Section 7.2):
 *   Preview   (top ~40vh)
 *   Timeline  (middle ~35vh)
 *   Playback controls (compact)
 *   BottomSheet (bottom ~25vh, scrollable)
 *
 * Phase 3.2 scope:
 *   The shell with tab navigation and placeholder content areas is fully
 *   implemented. The Assets and Inspector tabs reuse AssetPanel and
 *   InspectorPanel.
 *
 * Phase 3.8 update:
 *   The Captions tab now renders the full CaptionStylePanel with:
 *     - "Generate Captions" button (triggers transcription)
 *     - 4 style presets (Bold Impact, Modern Sans, Minimal, Neon)
 *     - Font, color, position, animation, and effect controls
 *
 * Phase 3.9 update:
 *   The Export tab now renders the full ExportPanel in inline mode with:
 *     - Resolution picker (720p / 1080p) with credit cost display
 *     - Export button with progress bar (via Realtime subscription)
 *     - Download button on completion
 *     - Export history list
 *
 * SOLID: SRP — only manages the mobile bottom sheet shell and tab switching.
 *   Content delegation to panel components keeps concerns cleanly separated.
 *
 * @see README.md Section 7.2 "Mobile Layout"
 * @see README.md Section 10.2 "Mobile Editor"
 * @see PLAN.md Phase 3.2 for mobile layout requirements
 * @see PLAN.md Phase 3.8 for caption panel requirements
 * @see PLAN.md Phase 3.9 for export panel requirements
 * @see CaptionStylePanel.tsx for the Captions tab content
 * @see ExportPanel.tsx for the Export tab content
 */

import { type FC, useState } from 'react'
import { useParams } from 'react-router'
import { Mic } from 'lucide-react'
import { AssetPanel } from './AssetPanel'
import { InspectorPanel } from './InspectorPanel'
import { CaptionStylePanel } from './CaptionStylePanel'
import { CaptionGeneratorPanel } from './CaptionGeneratorPanel'
import { ExportPanel } from './ExportPanel'
import { VoiceoverPanel } from './VoiceoverPanel'

// ─── Types ───────────────────────────────────────────────────────────────────

/** Available tabs in the mobile bottom sheet. */
type MobileTab = 'assets' | 'inspector' | 'voiceover' | 'captions' | 'export'

// ─── Tab Configuration ────────────────────────────────────────────────────────

const MOBILE_TABS: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'assets',
    label: 'Assets',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="5" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M1 11L5 7L8 10L11 6.5L15 11" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'inspector',
    label: 'Inspector',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
        <line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <line x1="5" y1="10" x2="8" y2="10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'voiceover',
    label: 'Voiceover',
    icon: <Mic size={16} aria-hidden />,
  },
  {
    id: 'captions',
    label: 'Captions',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <rect x="1" y="4" width="14" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <line x1="3" y1="7" x2="7" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <line x1="3" y1="9" x2="13" y2="9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: 'export',
    label: 'Export',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
        <path
          d="M8 2V10M8 2L5 5M8 2L11 5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M2 12H14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
]

// ─── MobileBottomSheet Component ─────────────────────────────────────────────

/**
 * MobileBottomSheet — tab-based bottom panel for the mobile editor.
 *
 * Renders a fixed-height content area (fills the available space below the
 * timeline) with a tab strip at the top. Each tab switches the content area.
 *
 * Captions tab (Phase 3.8):
 *   Renders the full CaptionStylePanel in `inline` mode so it appears
 *   seamlessly inside the bottom sheet's scrollable content area without
 *   its own header/border (which would duplicate the bottom sheet chrome).
 *
 * @example
 *   <MobileBottomSheet />
 *   <MobileBottomSheet projectTitle={title} onProjectTitleChange={updateTitle} />
 */
export interface MobileBottomSheetProps {
  projectTitle?: string | null
  onProjectTitleChange?: (title: string) => void | Promise<void>
}

export const MobileBottomSheet: FC<MobileBottomSheetProps> = (props) => {
  const { projectTitle, onProjectTitleChange } = props
  const { projectId } = useParams<{ projectId: string }>()
  const [activeTab, setActiveTab] = useState<MobileTab>('assets')

  return (
    <div className="flex flex-col bg-card border-t border-border h-full">
      {/* Tab strip */}
      <div
        className="flex border-b border-border shrink-0"
        role="tablist"
        aria-label="Editor tools"
      >
        {MOBILE_TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`mobile-tab-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`
              flex-1 flex flex-col items-center gap-0.5 py-2 text-[9px] font-medium transition-colors border-b-2
              ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground'
              }
            `}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div
        id={`mobile-tab-${activeTab}`}
        role="tabpanel"
        className="flex-1 min-h-0 overflow-hidden"
        aria-label={MOBILE_TABS.find((t) => t.id === activeTab)?.label}
      >
        {activeTab === 'assets' && (
          <div className="h-full overflow-y-auto">
            <AssetPanel />
          </div>
        )}
        {activeTab === 'inspector' && (
          <div className="h-full overflow-y-auto">
            <InspectorPanel
              projectTitle={projectTitle}
              onProjectTitleChange={onProjectTitleChange}
            />
          </div>
        )}
        {activeTab === 'voiceover' && (
          <div className="h-full overflow-y-auto">
            <VoiceoverPanel projectId={projectId} />
          </div>
        )}
        {activeTab === 'captions' && (
          <div className="h-full overflow-y-auto p-3">
            <CaptionGeneratorPanel projectId={projectId} />
            <CaptionStylePanel inline />
          </div>
        )}
        {activeTab === 'export' && (
          <div className="h-full overflow-y-auto p-3">
            <ExportPanel projectId={projectId} inline />
          </div>
        )}
      </div>
    </div>
  )
}
