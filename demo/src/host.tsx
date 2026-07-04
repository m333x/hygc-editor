/**
 * The demo EditorHost — a complete, backend-free reference implementation of
 * the `@hygc/editor` integration contract:
 *
 *   - projects        → localStorage (timeline JSON is small)
 *   - asset library   → bundled stock + IndexedDB uploads (library.ts)
 *   - resolveAssetUrls→ static URLs / object URLs
 *   - seed            → a pre-built showcase timeline (seed.ts)
 *   - extra tab       → about/credits/reset panel
 *
 * Optional capabilities `serverExport` and `transcribeAudio` are deliberately
 * omitted to show graceful degradation: export runs fully client-side via
 * WebCodecs, and the AI-caption action hides.
 */

import { Info } from 'lucide-react'
import type {
  EditorHost,
  EditorHostResult,
  EditorProjectRecord,
  SerializedEditorState,
} from '@hygc/editor'
import { DemoAssetBrowser } from './AssetBrowser'
import { resetLibrary, resolveDemoAssetUrls, useDemoAssetLibrary } from './library'
import { buildSeedState } from './seed'
import { DEMO_DB_NAME } from './idb'

const PROJECT_PREFIX = 'hygc-editor-demo:project:'

function projectKey(id: string): string {
  return `${PROJECT_PREFIX}${id}`
}

function readProject(id: string): EditorProjectRecord | null {
  try {
    const raw = localStorage.getItem(projectKey(id))
    return raw ? (JSON.parse(raw) as EditorProjectRecord) : null
  } catch {
    return null
  }
}

function writeProject(record: EditorProjectRecord): void {
  localStorage.setItem(projectKey(record.id), JSON.stringify(record))
}

function getOrCreateProject(id: string): EditorProjectRecord {
  const existing = readProject(id)
  if (existing) return existing
  const now = new Date().toISOString()
  const fresh: EditorProjectRecord = {
    id,
    title: 'Stock footage showcase',
    created_at: now,
    updated_at: now,
    editor_state: null,
  }
  writeProject(fresh)
  return fresh
}

function ok<T>(data: T): EditorHostResult<T> {
  return { data, error: null }
}

function DemoAboutPanel() {
  const reset = async () => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('hygc-editor-demo:')) localStorage.removeItem(key)
    }
    await resetLibrary()
    indexedDB.deleteDatabase(DEMO_DB_NAME)
    location.reload()
  }

  return (
    <div className="flex flex-col gap-4 p-3 text-xs leading-relaxed text-muted-foreground">
      <div>
        <h3 className="mb-1 text-sm font-semibold text-foreground">About this demo</h3>
        <p>
          A standalone host for <span className="font-mono">@hygc/editor</span>. There is no
          backend: the timeline persists to localStorage, uploads to IndexedDB, and export runs
          in-browser through WebCodecs. This entire app is one implementation of the
          <span className="font-mono"> EditorHost</span> interface.
        </p>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold text-foreground">Stock media credits</h3>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            Big Buck Bunny & Sintel — © Blender Foundation,{' '}
            <a
              className="text-primary underline-offset-2 hover:underline"
              href="https://studio.blender.org/films/"
              target="_blank"
              rel="noreferrer"
            >
              Blender open movies
            </a>{' '}
            (CC-BY)
          </li>
          <li>Jellyfish — test-videos.co.uk sample clip</li>
          <li>
            “Monkeys Spinning Monkeys” — Kevin MacLeod,{' '}
            <a
              className="text-primary underline-offset-2 hover:underline"
              href="https://incompetech.com"
              target="_blank"
              rel="noreferrer"
            >
              incompetech.com
            </a>{' '}
            (CC-BY 4.0)
          </li>
          <li>Photos — picsum.photos</li>
        </ul>
      </div>
      <div>
        <button
          type="button"
          onClick={() => void reset()}
          className="rounded-md border border-destructive/50 px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive hover:text-destructive-foreground"
        >
          Reset demo
        </button>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Clears the saved timeline and uploads, then reloads with the seeded project.
        </p>
      </div>
    </div>
  )
}

export const demoHost: EditorHost = {
  projects: {
    async get(id) {
      return ok(getOrCreateProject(id))
    },
    async saveState(id, state: SerializedEditorState) {
      const record = getOrCreateProject(id)
      record.editor_state = state
      record.updated_at = new Date().toISOString()
      writeProject(record)
      return { error: null }
    },
    async rename(id, title) {
      const record = getOrCreateProject(id)
      record.title = title
      record.updated_at = new Date().toISOString()
      writeProject(record)
      return ok(record)
    },
    // Invoked by the editor when the loaded timeline is empty.
    async seed() {
      return buildSeedState()
    },
  },

  resolveAssetUrls: resolveDemoAssetUrls,
  useAssetLibrary: useDemoAssetLibrary,
  AssetBrowser: DemoAssetBrowser,

  assetPanelExtraTabs: [
    {
      id: 'demo-about',
      label: 'Demo',
      title: 'About this demo',
      icon: <Info className="size-4" />,
      render: () => <DemoAboutPanel />,
    },
  ],
}
