/**
 * @hygc/editor — browser NLE video editor.
 *
 * Embed by wrapping {@link EditorPage} in an {@link EditorHostProvider} whose
 * {@link EditorHost} adapter supplies persistence, asset storage, and optional
 * capabilities (server export, transcription, extra asset tabs).
 */

// Host contract + provider
export * from './host'

// The editing surface
export { default as EditorPage } from './pages/EditorPage'

// Domain types (Track, Clip, SerializedEditorState, defaults, …)
export * from './types'

// Engine — composition, keyframes, transitions, client-side export
export * from './engine'

// Stores (Zustand) — timeline, selection, playback, UI
export * from './store'

// Hooks — persistence, playback, export, captions, …
export * from './hooks'

// UI pieces reusable by host-side chrome (toasts, panels)
export { editorToast } from './components/EditorToast'
export { UploadProgressBar } from './ui/upload-progress'
