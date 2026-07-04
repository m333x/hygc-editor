/**
 * ShortcutCheatsheet — Radix Dialog listing every editor keyboard shortcut.
 *
 * Opens via `?` (bound in useEditorKeyboard). The dialog reads/writes its
 * open state through the UI store so any caller — keyboard handler, toolbar
 * help button, context menu item — can summon the same instance.
 *
 * Layout: grouped sections (Playback / Tools / Editing / Timeline / Selection)
 * with each row being a label on the left and one or more <kbd> chips on the
 * right. The chips render the modifier symbol that matches the user's OS
 * (⌘ on Apple, Ctrl elsewhere) so the labels match what's printed on real
 * keyboards.
 *
 * Visual: liquid-glass surface with the same backdrop blur the InspectorPanel
 * and PlaybackBar use, so the dialog reads as part of the editor chrome.
 */

import { useMemo } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '../ui/cn'
import { useUIStore } from '../store/ui-store'

interface ShortcutRow {
  label: string
  /** One or more key glyphs that compose the chord. */
  keys: string[]
  /**
   * Optional alternate chord (e.g. for Ctrl/Cmd+Y as a redo synonym). Renders
   * a thin "or" between the two chord groups.
   */
  alt?: string[]
}

interface ShortcutSection {
  title: string
  rows: ShortcutRow[]
}

/**
 * Detect whether the current platform uses ⌘ as the primary command modifier.
 *
 * Uses `navigator.userAgent` rather than the deprecated `navigator.platform`.
 * SSR-safe: defaults to false during build / Node-side hydration paths.
 */
function isAppleHost(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}

/**
 * Build the section list at render time so the modifier glyph follows the
 * current platform without rebuilding the module on every dialog open.
 */
function buildSections(mod: string): ShortcutSection[] {
  return [
    {
      title: 'Playback',
      rows: [
        { label: 'Play / pause', keys: ['Space'] },
        { label: 'Step back 1 second', keys: ['J'] },
        { label: 'Pause', keys: ['K'] },
        { label: 'Step forward 1 second', keys: ['L'] },
        { label: 'Step back one frame', keys: ['←'] },
        { label: 'Step forward one frame', keys: ['→'] },
        { label: 'Jump to start', keys: ['Home'] },
        { label: 'Jump to end', keys: ['End'] },
      ],
    },
    {
      title: 'Tools',
      rows: [
        { label: 'Select tool', keys: ['V'] },
        { label: 'Slice tool', keys: ['C'] },
        { label: 'Track Select Forward', keys: ['A'] },
        { label: 'Track Select Backward', keys: ['⇧', 'A'] },
        { label: 'Rate Stretch tool', keys: ['R'] },
        { label: 'Slip tool', keys: ['Y'] },
        { label: 'Return to Select / deselect', keys: ['Esc'] },
      ],
    },
    {
      title: 'Editing',
      rows: [
        { label: 'Split at playhead', keys: ['S'] },
        { label: 'Delete selection', keys: ['Delete'] },
        { label: 'Duplicate selection', keys: [mod, 'D'] },
        { label: 'Copy selection', keys: [mod, 'C'] },
        { label: 'Paste at playhead', keys: [mod, 'V'] },
        { label: 'Nudge selection 1 frame', keys: ['⇧', '← / →'] },
        { label: 'Nudge selection 10 frames', keys: ['Alt', '← / →'] },
        { label: 'Undo', keys: [mod, 'Z'] },
        { label: 'Redo', keys: [mod, '⇧', 'Z'], alt: [mod, 'Y'] },
      ],
    },
    {
      title: 'Timeline',
      rows: [
        { label: 'Fit timeline to window', keys: ['\\'] },
        { label: 'Zoom in', keys: ['+'] },
        { label: 'Zoom out', keys: ['−'] },
        { label: 'Toggle snap', keys: ['⇧', 'S'] },
        { label: 'Toggle keyframe graph (selected clip)', keys: ['G'] },
      ],
    },
    {
      title: 'Selection',
      rows: [
        { label: 'Select all clips', keys: [mod, 'A'] },
        { label: 'Deselect all', keys: ['Esc'] },
        { label: 'Open this cheatsheet', keys: ['?'] },
      ],
    },
  ]
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className={cn(
        // Sits on the dialog's glass surface — borrow the same token set the
        // PlaybackBar uses for its chrome buttons so the chips read as the
        // same family of affordance.
        'inline-flex h-6 min-w-[1.5rem] items-center justify-center rounded-md px-1.5',
        'border border-border/60 bg-muted/70 text-[11px] font-medium text-foreground/80',
        'shadow-[inset_0_-1px_0_0_oklch(0_0_0/0.06)]',
        'tracking-tight',
      )}
    >
      {children}
    </kbd>
  )
}

function Chord({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground/50" aria-hidden>+</span>}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </span>
  )
}

function Row({ row }: { row: ShortcutRow }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-foreground/80">{row.label}</span>
      <span className="flex items-center gap-2 shrink-0">
        <Chord keys={row.keys} />
        {row.alt && (
          <>
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground/60">or</span>
            <Chord keys={row.alt} />
          </>
        )}
      </span>
    </li>
  )
}

function Section({ section }: { section: ShortcutSection }) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {section.title}
      </h3>
      <ul className="divide-y divide-border/40">
        {section.rows.map((row) => (
          <Row key={row.label} row={row} />
        ))}
      </ul>
    </section>
  )
}

export function ShortcutCheatsheet() {
  const open = useUIStore((s) => s.cheatsheetOpen)
  const setOpen = useUIStore((s) => s.setCheatsheetOpen)

  // Build sections once per platform — never recompute on open/close churn.
  const sections = useMemo(() => buildSections(isAppleHost() ? '⌘' : 'Ctrl'), [])

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            'fixed inset-0 z-[var(--z-overlay)] bg-black/40 backdrop-blur-sm',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in data-[state=closed]:fade-out',
          )}
        />
        <Dialog.Content
          aria-describedby="shortcut-cheatsheet-subtitle"
          className={cn(
            'fixed left-1/2 top-1/2 z-[var(--z-modal)] -translate-x-1/2 -translate-y-1/2',
            'flex w-[min(720px,94vw)] max-h-[85vh] flex-col overflow-hidden',
            'rounded-[20px] border border-border/60 bg-popover/95 backdrop-blur-xl',
            'shadow-[0_24px_60px_-20px_oklch(0_0_0/0.35),0_2px_6px_-2px_oklch(0_0_0/0.12)]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=open]:fade-in data-[state=closed]:fade-out',
            'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-border/50 px-6 pb-4 pt-5">
            <div className="flex flex-col gap-0.5">
              <Dialog.Title className="text-base font-semibold -tracking-[0.01em]">
                Keyboard shortcuts
              </Dialog.Title>
              <Dialog.Description
                id="shortcut-cheatsheet-subtitle"
                className="text-xs text-muted-foreground"
              >
                Press <Kbd>?</Kbd> any time to reopen this list.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close cheatsheet"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </header>

          <div className="grid grid-cols-1 gap-x-10 gap-y-5 overflow-y-auto px-6 py-5 md:grid-cols-2">
            {sections.map((section) => (
              <Section key={section.title} section={section} />
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
