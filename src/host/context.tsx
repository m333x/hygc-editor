/**
 * EditorHostProvider — supplies the {@link EditorHost} adapter to the editor
 * component tree. Every editor surface must be wrapped in one.
 */

import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { EditorHost } from './types'

const EditorHostContext = createContext<EditorHost | null>(null)

export function EditorHostProvider({ host, children }: { host: EditorHost; children: ReactNode }) {
  return <EditorHostContext.Provider value={host}>{children}</EditorHostContext.Provider>
}

export function useEditorHost(): EditorHost {
  const host = useContext(EditorHostContext)
  if (!host) {
    throw new Error('useEditorHost: wrap the editor in <EditorHostProvider host={...}>.')
  }
  return host
}
