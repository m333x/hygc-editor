import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Navigate, Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import { EditorHostProvider, EditorPage } from '@hygc/editor'
import { demoHost } from './host'
import './theme.css'

// HashRouter so deep links survive GitHub Pages' static hosting (no SPA
// fallback rewrites). The editor reads `:projectId` from the route.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <EditorHostProvider host={demoHost}>
        <Routes>
          <Route path="/p/:projectId" element={<EditorPage />} />
          <Route path="*" element={<Navigate to="/p/demo" replace />} />
        </Routes>
        {/* editorToast bodies style themselves; the global Toaster stays unstyled. */}
        <Toaster position="bottom-center" toastOptions={{ unstyled: true }} />
      </EditorHostProvider>
    </HashRouter>
  </StrictMode>,
)
