/**
 * Bundled stock media the demo library starts with. Everything is
 * redistributable: Blender open-movie clips (CC-BY), Kevin MacLeod music
 * (CC-BY 4.0), Picsum photos. See the README credits section.
 */

import type { EditorAsset, EditorAssetType } from '@hygc/editor'

export interface StockAsset {
  id: string
  type: EditorAssetType
  file: string
  filename: string
  duration_ms: number | null
}

export const STOCK_ASSETS: StockAsset[] = [
  {
    id: 'stock-big-buck-bunny',
    type: 'video',
    file: 'big-buck-bunny-10s.mp4',
    filename: 'Big Buck Bunny (720p).mp4',
    duration_ms: 10000,
  },
  {
    id: 'stock-sintel',
    type: 'video',
    file: 'sintel-10s.mp4',
    filename: 'Sintel (720p).mp4',
    duration_ms: 10000,
  },
  {
    id: 'stock-jellyfish',
    type: 'video',
    file: 'jellyfish-10s.mp4',
    filename: 'Jellyfish (720p).mp4',
    duration_ms: 10000,
  },
  {
    id: 'stock-fjord-lookout',
    type: 'image',
    file: 'fjord-lookout.jpg',
    filename: 'Fjord lookout.jpg',
    duration_ms: null,
  },
  {
    id: 'stock-highland-road',
    type: 'image',
    file: 'highland-road.jpg',
    filename: 'Highland road.jpg',
    duration_ms: null,
  },
  {
    id: 'stock-valley-river',
    type: 'image',
    file: 'valley-river.jpg',
    filename: 'Valley river.jpg',
    duration_ms: null,
  },
  {
    id: 'stock-monkeys-spinning-monkeys',
    type: 'audio',
    file: 'monkeys-spinning-monkeys.mp3',
    filename: 'Monkeys Spinning Monkeys — Kevin MacLeod.mp3',
    duration_ms: 125074,
  },
]

export function stockUrl(stock: StockAsset): string {
  return `${import.meta.env.BASE_URL}assets/${stock.file}`
}

export function toEditorAsset(stock: StockAsset): EditorAsset {
  return {
    id: stock.id,
    type: stock.type,
    public_url: stockUrl(stock),
    metadata: {
      filename: stock.filename,
      duration_ms: stock.duration_ms ?? undefined,
      source: 'stock',
    },
  }
}
