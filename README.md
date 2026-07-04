# @hygc/editor

Browser NLE video editor — Remotion-powered preview, WebCodecs client-side
export (H.264/H.265/AV1), multi-track timeline with keyframes, captions,
transitions, and voiceover recording.

## Embedding

The editor is host-agnostic. Wrap `EditorPage` in an `EditorHostProvider` and
supply an `EditorHost` adapter (see `src/host/types.ts` — the single
integration contract):

```tsx
import { EditorHostProvider, EditorPage } from '@hygc/editor'

<EditorHostProvider host={myHost}>
  <EditorPage />   {/* expects a :projectId route param */}
</EditorHostProvider>
```

Required host surface: `projects` (get/saveState/rename), `resolveAssetUrls`,
`useAssetLibrary` (a React hook), and an `AssetBrowser` component. Optional
capabilities degrade gracefully when omitted: `serverExport` (render farm +
credits + history), `transcribeAudio` (AI captions), `projects.seed`,
`assetPanelExtraTabs`, `exit`.

The single integration contract lives in `src/host/types.ts`. Implement it once
against your own storage/asset backend and the editor is fully wired.

## Install

Until it lands on the npm registry, install straight from GitHub:

```bash
npm install github:m333x/hygc-editor
```

This builds the package on install (`tsc` → `dist/`, ESM + `.d.ts`). Provide the
peer dependencies listed in `package.json` (React 19, Remotion 4.0.475, etc.).

## License

Dual-licensed: **AGPL-3.0-only** for open-source use, **commercial** for
proprietary use. See [`LICENSE`](./LICENSE) and
[`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).

## Notes

- Ships compiled ESM + type declarations from `src/`; consumers use a bundler
  (Vite/Next/webpack) for extensionless module resolution.
- Tailwind v4 consumers must scan this package's source
  (`@source "…/packages/editor/src"`) and provide the semantic theme tokens
  (`--background`, `--primary`, `--clip-video-bg`, …).
- i18n: ships its strings as `@hygc/editor/locales/en/editor.json`; register
  them under the `editor` namespace.
