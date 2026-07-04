/**
 * web-export — client-side video render via @remotion/web-renderer (WebCodecs).
 *
 * Renders the SAME ShortComposition the preview Player uses, but encodes the
 * MP4 entirely in the browser with hardware-accelerated WebCodecs — no server
 * render-worker, no queue, no credits. This is the "client-primary" export path
 * for short UGC ads; the server render-worker (supabase/functions/render) stays
 * as the fallback for unsupported browsers and headless/batch renders.
 *
 * Tradeoffs and known limits live in docs/COMPETITOR_DIFFUSION_STUDIO.md.
 * The renderer emulates layout to a canvas (a CSS subset), so video clips must
 * use <Video> (handled by the `webExport` flag in ShortComposition) and a few
 * decorative effects (SVG url() filters / motion blur, backdrop-filter) are
 * dropped on this path.
 */

import type { ComponentType } from 'react'
import { renderMediaOnWeb, canRenderMediaOnWeb } from '@remotion/web-renderer'
import { ShortComposition } from './ShortComposition'
import type { ShortCompositionProps } from './ShortComposition'
import { computeCompositionDuration, msToDurationInFrames, getMediaAssetIds } from './composition-utils'
import type { SerializedEditorState } from '../types'
import type { ResolvedAssetUrls } from '../host/types'

// renderMediaOnWeb types props via a Zod schema; we pass plain inputProps.
const Component = ShortComposition as unknown as ComponentType<Record<string, unknown>>

/**
 * Encode codecs the web renderer can emit (all into an MP4 container).
 * h264 = universal playback; h265/av1 = ~30-40% smaller at equal quality but
 * encode/decode support is browser-dependent — always gate with canExportOnWeb.
 */
export type WebExportCodec = 'h264' | 'h265' | 'av1'

/**
 * Feature-detect: can this browser render the composition client-side with the
 * given codec? Checks WebCodecs + the MP4 encode path for the dimensions.
 */
export async function canExportOnWeb(
  width: number,
  height: number,
  codec: WebExportCodec = 'h264',
): Promise<boolean> {
  try {
    const result = await canRenderMediaOnWeb({
      width,
      height,
      container: 'mp4',
      videoCodec: codec,
    })
    return result.canRender
  } catch {
    return false
  }
}

export interface RenderOnWebOptions {
  /** Resolve timeline asset ids to playable URLs — pass the host's resolver. */
  resolveAssetUrls: (assetIds: string[]) => Promise<ResolvedAssetUrls>
  /** Output scale relative to the composition's native size (e.g. 0.667 → 720p, 2 → 4K). */
  scale?: number
  /** Video codec for the MP4. Defaults to 'h264'. Gate non-default codecs with canExportOnWeb. */
  codec?: WebExportCodec
  /** 0–1 progress callback. */
  onProgress?: (progress: number) => void
  /** Abort the render. */
  signal?: AbortSignal
}

/**
 * Render the given timeline to an MP4 Blob, entirely in the browser.
 * Resolves asset URLs the same way the preview does, then hands the
 * ShortComposition to renderMediaOnWeb.
 */
export async function renderProjectOnWeb(
  timeline: SerializedEditorState,
  options: RenderOnWebOptions,
): Promise<Blob> {
  const { tracks, captionStyle, composition, globalAudioVolume } = timeline

  const { assetUrlMap, assetTypeMap } = await options.resolveAssetUrls(getMediaAssetIds(tracks))

  const durationMs = computeCompositionDuration(tracks, composition)
  const durationInFrames = msToDurationInFrames(durationMs, composition.fps)

  const inputProps: ShortCompositionProps = {
    tracks,
    captionStyle,
    assetUrlMap,
    assetTypeMap,
    globalAudioVolume: globalAudioVolume ?? 1,
    webExport: true,
  }

  const { getBlob } = await renderMediaOnWeb({
    composition: {
      component: Component,
      id: 'ShortComposition',
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      durationInFrames,
    },
    inputProps: inputProps as unknown as Record<string, unknown>,
    container: 'mp4',
    videoCodec: options.codec ?? 'h264',
    scale: options.scale ?? 1,
    signal: options.signal ?? null,
    onProgress: options.onProgress
      ? (p) => options.onProgress!(p.progress)
      : null,
  })

  return getBlob()
}

/** Trigger a browser download for a rendered Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const safe = filename.endsWith('.mp4') ? filename : `${filename}.mp4`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safe
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
