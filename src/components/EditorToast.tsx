/**
 * EditorToast — styled toast bodies for the NLE.
 *
 * The global `<Toaster />` in `App.tsx` is configured with `unstyled: true`,
 * so plain `toast.success` / `toast.info` calls render as raw text. The
 * ads and products surfaces already work around this with `toast.custom()`
 * + a body component (see `UndoToastBody`). This file gives the editor
 * the same treatment with a small helper API so call sites stay terse.
 */

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ExternalToast } from 'sonner'
import {
  CheckCircle2,
  Info,
  Trash2,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../ui/cn'

type Variant = 'info' | 'success' | 'undo'

interface EditorToastBodyProps {
  variant: Variant
  message: string
  /** Required when `variant === 'undo'`. */
  durationMs?: number
  /** Required when `variant === 'undo'`. */
  onUndo?: () => void
  /** Optional undo button label override. */
  undoLabel?: string
}

const ICON_FOR: Record<Variant, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  undo: Trash2,
}

const ICON_TINT: Record<Variant, string> = {
  info: 'text-muted-foreground',
  success: 'text-[hsl(var(--accent-teal))]',
  undo: 'text-muted-foreground',
}

function EditorToastBody({
  variant,
  message,
  durationMs,
  onUndo,
  undoLabel = 'Undo',
}: EditorToastBodyProps) {
  const Icon = ICON_FOR[variant]
  const [drained, setDrained] = useState(false)

  useEffect(() => {
    if (variant !== 'undo') return
    const id = requestAnimationFrame(() => setDrained(true))
    return () => cancelAnimationFrame(id)
  }, [variant])

  return (
    <div
      className={cn(
        'pointer-events-auto relative flex min-w-[320px] max-w-[440px] items-start gap-3',
        'overflow-hidden rounded-2xl border border-border/60 bg-background/80',
        'px-4 py-3 shadow-card backdrop-blur-2xl',
      )}
    >
      {variant === 'undo' && durationMs != null ? (
        <div
          className="absolute inset-x-0 top-0 h-px origin-left bg-[hsl(var(--accent-teal))] ease-linear motion-reduce:hidden"
          style={{
            transform: drained ? 'scaleX(0)' : 'scaleX(1)',
            transitionProperty: 'transform',
            transitionDuration: `${durationMs}ms`,
          }}
          aria-hidden
        />
      ) : null}
      <Icon
        size={14}
        className={cn('mt-[3px] shrink-0', ICON_TINT[variant])}
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-pretty break-words text-sm leading-snug text-foreground">
        {message}
      </span>
      {variant === 'undo' && onUndo ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onUndo}
          className="-my-1 shrink-0 text-[hsl(var(--accent-teal))] hover:bg-[hsl(var(--accent-teal)/0.08)] hover:text-[hsl(var(--accent-teal))]"
        >
          {undoLabel}
        </Button>
      ) : null}
    </div>
  )
}

const DEFAULT_MESSAGE_DURATION_MS = 3500

function emitMessage(variant: 'info' | 'success', message: string, options?: ExternalToast) {
  return toast.custom(
    () => <EditorToastBody variant={variant} message={message} />,
    { duration: DEFAULT_MESSAGE_DURATION_MS, ...options },
  )
}

interface UndoToastOptions {
  message: string
  durationMs: number
  onUndo: () => void
  undoLabel?: string
  onAutoClose?: () => void
}

/** Editor-flavoured toast helpers. Use these instead of raw `toast.*`. */
export const editorToast = {
  info: (message: string, options?: ExternalToast) => emitMessage('info', message, options),
  success: (message: string, options?: ExternalToast) =>
    emitMessage('success', message, options),
  undo: ({ message, durationMs, onUndo, undoLabel, onAutoClose }: UndoToastOptions) => {
    let id: string | number | undefined
    id = toast.custom(
      (tId) => (
        <EditorToastBody
          variant="undo"
          message={message}
          durationMs={durationMs}
          undoLabel={undoLabel}
          onUndo={() => {
            onUndo()
            toast.dismiss(tId)
          }}
        />
      ),
      {
        duration: durationMs,
        onAutoClose: () => {
          if (id != null) onAutoClose?.()
        },
      },
    )
    return id
  },
}
