import { atom } from 'jotai'
import type { ProgressEntry } from './generation-progress'

export interface GenerationJob {
  id: string
  status: 'imagining' | 'uploading' | 'processing' | 'completed' | 'error'
  imagePreviewUrl?: string
  plyUrl?: string
  plyUrls?: string[]
  videoUrl?: string
  plyFilename?: string
  error?: string
  sourceUrl?: string
  imageCount?: number
  createdAt: number
  finishedAt?: number
  imageNames?: string[]
  progress?: ProgressEntry
  history?: ProgressEntry[]
  lastActivityAt?: number
}

export interface GalleryItem {
  id: string
  plyUrl: string
  plyFilename: string
  createdAt: number
  thumbnailUrl: string | null
}

export interface PlacedModel {
  id: string
  assetId: string
  name: string
  glbUrl: string
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export const currentJobAtom = atom<GenerationJob | null>(null)
export const galleryItemsAtom = atom<GalleryItem[]>([])
export const placedModelsAtom = atom<PlacedModel[]>([])
export const selectedModelIdAtom = atom<string | null>(null)
