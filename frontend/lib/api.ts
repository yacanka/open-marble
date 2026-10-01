import { type GenerationProgress, readGenerationStream } from './generation-progress'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
const SUPERSPLAT_URL = process.env.NEXT_PUBLIC_SUPERSPLAT_URL || '/supersplat/index.html'

export async function checkHealth() {
  const res = await fetch(`${BACKEND_URL}/api/health`)
  if (!res.ok) throw new Error('Backend unreachable')
  return res.json() as Promise<{
    status: string
    cuda_available: boolean
    model_loaded: boolean
  }>
}

async function readGenerationResponse<T>(
  response: Response,
  onProgress?: (event: GenerationProgress) => void,
  onHeartbeat?: () => void
): Promise<T> {
  if (!onProgress) return response.json()
  if (!response.body) throw new Error('Progress stream unavailable')
  return readGenerationStream<T>(response.body, onProgress, onHeartbeat)
}

export async function generateWorld(
  imageFiles: File | File[],
  options?: {
    renderVideo?: boolean
    trajectoryType?: string
    onProgress?: (event: GenerationProgress) => void
    onHeartbeat?: () => void
  }
) {
  const files = Array.isArray(imageFiles) ? imageFiles : [imageFiles]
  if (files.length === 0) throw new Error('Select at least one image')

  const formData = new FormData()
  for (const file of files) formData.append('images', file)

  const params = new URLSearchParams()
  if (options?.onProgress) params.set('stream', 'true')
  if (options?.renderVideo !== undefined) {
    params.set('render_video', String(options.renderVideo))
  }
  if (options?.trajectoryType) params.set('trajectory_type', options.trajectoryType)

  const url = `${BACKEND_URL}/api/generate${params.toString() ? `?${params}` : ''}`
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: formData })
  } catch {
    throw new Error(
      'The 3D generation service could not be reached. Make sure the backend and SHARP services are running.'
    )
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ detail: 'Unknown error' }))
    const detail = typeof error.detail === 'string' ? error.detail : 'Generation failed'
    throw new Error(detail)
  }

  type GenerationResult = {
    id: string
    ply_url: string
    ply_filename: string
    video_url: string | null
    thumbnail_url: string | null
    scenes?: GeneratedScene[]
    errors?: Array<{ filename: string; message: string }>
  }

  const result = await readGenerationResponse<GenerationResult>(
    res,
    options?.onProgress,
    options?.onHeartbeat
  )

  const scenes =
    result.scenes && result.scenes.length > 0
      ? result.scenes
      : [
          {
            id: result.id,
            ply_url: result.ply_url,
            ply_filename: result.ply_filename,
            video_url: result.video_url,
            thumbnail_url: result.thumbnail_url,
            source_filename: files[0]?.name ?? 'image',
          },
        ]

  return { ...result, scenes, errors: result.errors ?? [] }
}

export interface GeneratedScene {
  id: string
  ply_url: string
  ply_filename: string
  video_url: string | null
  thumbnail_url: string | null
  source_filename: string
}

export async function fetchGallery() {
  const res = await fetch(`${BACKEND_URL}/api/gallery`)
  if (!res.ok) throw new Error('Failed to fetch gallery')
  return res.json() as Promise<{
    items: Array<{
      id: string
      ply_url: string
      ply_filename: string
      created_at: number
      thumbnail_url: string | null
      video_url: string | null
    }>
  }>
}

export async function fetchWorlds() {
  const res = await fetch(`${BACKEND_URL}/api/worlds`)
  if (!res.ok) throw new Error('Failed to fetch worlds')
  return res.json() as Promise<{
    items: Array<{
      id: string
      ply_url: string
      video_url: string
      thumbnail_url: string | null
      created_at: number
    }>
  }>
}

export async function generateImageFromText(prompt: string) {
  const res = await fetch('/api/imagine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || 'Image generation failed')
  }

  return res.json() as Promise<{ image_url: string }>
}

export async function extractImageFromUrl(url: string) {
  const res = await fetch('/api/url-to-world', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error(error.error || 'URL extraction failed')
  }

  return res.json() as Promise<{ image_url: string }>
}

export function getSuperSplatViewerUrl(plyUrl: string): string {
  return `${SUPERSPLAT_URL}/?load=${encodeURIComponent(plyUrl)}`
}
