/**
 * Get the duration of a video or audio file in milliseconds using the HTML5
 * media API. Used when uploading so assets (and timeline clips) get the
 * correct duration instead of a default.
 *
 * @param file - The media file (video or audio)
 * @param kind - 'video' or 'audio' — determines which element is used
 * @returns Duration in ms, or null if unavailable or invalid
 */
export function getMediaDurationMs(
  file: File,
  kind: 'video' | 'audio',
): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(kind)

    const cleanup = () => {
      el.remove()
      URL.revokeObjectURL(url)
    }

    el.preload = 'metadata'
    el.onloadedmetadata = () => {
      const seconds = el.duration
      cleanup()
      if (Number.isFinite(seconds) && seconds > 0) {
        resolve(Math.round(seconds * 1000))
      } else {
        resolve(null)
      }
    }
    el.onerror = () => {
      cleanup()
      resolve(null)
    }

    el.src = url
  })
}
