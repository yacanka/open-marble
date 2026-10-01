'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAtom } from 'jotai'
import { Stack } from '@/components/core/stack'
import { Button } from '@/components/core/button'
import { Text } from '@/components/core/text'
import { Material } from '@/components/core/material'
import {
  ImageUpload,
  type SelectedImage,
} from '@/components/marble/image-upload'
import { ProcessingOverlay } from '@/components/marble/processing-overlay'
import {
  StreetViewInput,
  type StreetViewInputHandle,
} from '@/components/marble/street-view-input'
import { currentJobAtom } from '@/lib/marble-atoms'
import { generateWorld, generateImageFromText, extractImageFromUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { appendProgress, type GenerationProgress } from '@/lib/generation-progress'

type InputMode = 'image' | 'text' | 'maps' | 'url'

const MAX_IMAGES = 4
const SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
])

export default function CreatePage() {
  const router = useRouter()
  const [job, setJob] = useAtom(currentJobAtom)
  const [mode, setMode] = useState<InputMode>('image')
  const [selectedImages, setSelectedImages] = useState<SelectedImage[]>([])
  const [selectionError, setSelectionError] = useState<string | null>(null)
  const [textPrompt, setTextPrompt] = useState('')
  const [urlInput, setUrlInput] = useState('')
  const [streetViewReady, setStreetViewReady] = useState(false)
  const streetViewRef = useRef<StreetViewInputHandle>(null)
  const previewUrlsRef = useRef(new Set<string>())

  useEffect(() => {
    const previewUrls = previewUrlsRef.current
    return () => {
      for (const previewUrl of previewUrls) URL.revokeObjectURL(previewUrl)
      previewUrls.clear()
    }
  }, [])

  const handleFilesSelect = useCallback(
    (files: File[]) => {
      const supportedFiles = files.filter((file) =>
        SUPPORTED_IMAGE_TYPES.has(file.type),
      )
      const availableSlots = MAX_IMAGES - selectedImages.length
      const filesToAdd = supportedFiles.slice(0, availableSlots)

      if (supportedFiles.length !== files.length) {
        setSelectionError('Only PNG, JPG, and WebP images are supported.')
      } else if (supportedFiles.length > availableSlots) {
        setSelectionError(`You can use up to ${MAX_IMAGES} images in one scene.`)
      } else {
        setSelectionError(null)
      }

      const nextImages = filesToAdd.map((file) => {
        const previewUrl = URL.createObjectURL(file)
        previewUrlsRef.current.add(previewUrl)
        return { file, previewUrl }
      })
      setSelectedImages((current) => [...current, ...nextImages])
    },
    [selectedImages.length],
  )

  const handleRemoveImage = useCallback((index: number) => {
    setSelectedImages((current) => {
      const image = current[index]
      if (!image) return current
      URL.revokeObjectURL(image.previewUrl)
      previewUrlsRef.current.delete(image.previewUrl)
      return current.filter((_, currentIndex) => currentIndex !== index)
    })
    setSelectionError(null)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (mode === 'image' && selectedImages.length === 0) return
    if (mode === 'text' && !textPrompt.trim()) return
    if (mode === 'maps' && (!streetViewReady || !streetViewRef.current)) return
    if (mode === 'url' && !urlInput.trim()) return

    const jobId = Date.now().toString()
    setJob({
      id: jobId,
      status: mode === 'text' || mode === 'url' ? 'imagining' : 'uploading',
      imagePreviewUrl: selectedImages[0]?.previewUrl,
      imageCount: mode === 'image' ? selectedImages.length : 1,
      sourceUrl: mode === 'url' ? urlInput.trim() : undefined,
      createdAt: Date.now(),
      imageNames: selectedImages.map(({ file }) => file.name),
      history: [],
      lastActivityAt: Date.now(),
    })

    try {
      let imageFiles: File[]

      if (mode === 'text') {
        // Step 1: Generate image from text via Replicate Minimax
        const { image_url } = await generateImageFromText(textPrompt.trim())

        // Step 2: Download the generated image as a File
        const imgRes = await fetch(image_url)
        const blob = await imgRes.blob()
        imageFiles = [
          new File([blob], 'imagined.jpeg', {
            type: blob.type || 'image/jpeg',
          }),
        ]

        setJob((prev) =>
          prev
            ? { ...prev, status: 'uploading', imagePreviewUrl: image_url }
            : null,
        )
      } else if (mode === 'url') {
        // Step 1: Use AgentCore BrowserTools to extract the best image from the URL
        const { image_url } = await extractImageFromUrl(urlInput.trim())

        // Step 2: Download the extracted image as a File
        const imgRes = await fetch(image_url)
        const blob = await imgRes.blob()
        imageFiles = [
          new File([blob], 'extracted.jpeg', {
            type: blob.type || 'image/jpeg',
          }),
        ]

        setJob((prev) =>
          prev
            ? { ...prev, status: 'uploading', imagePreviewUrl: image_url }
            : null,
        )
      } else if (mode === 'maps') {
        // Capture the current Street View frame
        const streetView = streetViewRef.current
        if (!streetView) throw new Error('Select a Street View location first')
        imageFiles = [await streetView.captureImage()]
      } else {
        imageFiles = selectedImages.map(({ file }) => file)
      }

      const onProgress = (event: GenerationProgress) => {
        const entry = { ...event, receivedAt: Date.now() }
        setJob((prev) => prev?.id === jobId ? {
          ...prev,
          status: event.stage === 'uploading' ? 'uploading' : 'processing',
          progress: entry,
          history: appendProgress(prev.history ?? [], entry),
          lastActivityAt: entry.receivedAt,
        } : prev)
      }
      setJob((prev) => prev ? { ...prev, imageNames: imageFiles.map((file) => file.name) } : null)
      onProgress({ type: 'progress', stage: 'uploading', message: `Uploading ${imageFiles.length} image(s) to the server` })
      const result = await generateWorld(imageFiles, {
        onProgress,
        onHeartbeat: () => setJob((prev) => prev?.id === jobId ? { ...prev, lastActivityAt: Date.now() } : prev),
      })
      onProgress({
        type: 'progress', stage: 'completed',
        message: `${result.scenes.length} scene(s) ready${result.errors.length ? `; ${result.errors.length} image(s) failed` : ''}`,
      })
      const plyUrls = result.scenes.map((scene) => scene.ply_url)
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'completed',
              finishedAt: Date.now(),
              plyUrl: result.ply_url,
              plyUrls,
              plyFilename: result.ply_filename,
              videoUrl: result.video_url ?? undefined,
            }
          : null,
      )
      const viewerParams = new URLSearchParams()
      for (const plyUrl of plyUrls) viewerParams.append('ply', plyUrl)
      if (result.errors.length === 0) router.push(`/openmarble/viewer?${viewerParams.toString()}`)
    } catch (error) {
      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: 'error',
              finishedAt: Date.now(),
              error:
                error instanceof Error ? error.message : 'Unknown error',
            }
          : null,
      )
    }
  }, [mode, selectedImages, textPrompt, urlInput, streetViewReady, setJob, router])

  const canGenerate =
    mode === 'image'
      ? selectedImages.length > 0
      : mode === 'text'
        ? !!textPrompt.trim()
        : mode === 'url'
          ? !!urlInput.trim()
          : streetViewReady

  return (
    <>
      <Stack
        material
        options={{ title: 'Imagining a World', headerShown: true }}
      >
        <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto p-8 pt-0">
          {/* Description */}
          <div className="flex flex-col items-center gap-2 text-center">
            {/* <Text size="title2">Imaging a World</Text> */}
            <Text size="body" variant="secondary">
              Turn an image, a text description, or a real-world location into
              an explorable 3D environment.
            </Text>
          </div>

          {/* Mode Tabs */}
          <Material
            thickness="thinnest"
            className="flex items-center gap-1 p-1 px-4"
          >
            {/* Image tab */}
            <button
              type="button"
              onClick={() => setMode('image')}
              className={cn(
                'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
                mode === 'image'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                <circle cx="9" cy="9" r="2" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
              Image
            </button>

            {/* Text tab */}
            <button
              type="button"
              onClick={() => setMode('text')}
              className={cn(
                'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
                mode === 'text'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M17 6.1H3" />
                <path d="M21 12.1H3" />
                <path d="M15.1 18H3" />
              </svg>
              Text
            </button>

            {/* Maps tab */}
            <button
              type="button"
              onClick={() => setMode('maps')}
              className={cn(
                'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
                mode === 'maps'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                <circle cx="12" cy="10" r="3" />
              </svg>
              Maps
            </button>

            {/* URL tab */}
            <button
              type="button"
              onClick={() => setMode('url')}
              className={cn(
                'flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors',
                mode === 'url'
                  ? 'bg-white/15 text-white'
                  : 'text-white/50 hover:text-white/80',
              )}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
              >
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              URL
            </button>
          </Material>

          {/* Image Mode */}
          {mode === 'image' && (
            <>
              <ImageUpload
                images={selectedImages}
                onFilesSelect={handleFilesSelect}
                onRemove={handleRemoveImage}
                maxFiles={MAX_IMAGES}
              />

              {selectionError && (
                <Text size="callout" className="text-red-400">
                  {selectionError}
                </Text>
              )}
            </>
          )}

          {/* Text Mode */}
          {mode === 'text' && (
            <Material
              thickness="thin"
              className="flex w-full max-w-[500px] flex-col gap-3 p-6"
            >
              <Text size="callout" variant="secondary">
                Describe the world you want to create
              </Text>
              <textarea
                value={textPrompt}
                onChange={(e) => setTextPrompt(e.target.value)}
                placeholder="A serene Japanese garden with cherry blossoms, a koi pond, and a wooden bridge..."
                rows={4}
                className="w-full resize-none rounded-2xl border border-white/10 bg-white/5 p-4 text-sm text-white placeholder:text-white/30 focus:border-white/20 focus:outline-none"
              />
            </Material>
          )}

          {/* Maps Mode */}
          {mode === 'maps' && (
            <StreetViewInput
              ref={streetViewRef}
              onLocationSet={setStreetViewReady}
            />
          )}

          {/* URL Mode */}
          {mode === 'url' && (
            <Material
              thickness="thin"
              className="flex w-full max-w-[500px] flex-col gap-3 p-6"
            >
              <Text size="callout" variant="secondary">
                Paste any URL — we'll find the best image and turn it into a 3D world
              </Text>
              <div className="relative flex items-center">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="absolute left-3 size-4 text-white/30"
                >
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                <input
                  type="url"
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  placeholder="https://en.wikipedia.org/wiki/Machu_Picchu"
                  className="w-full rounded-2xl border border-white/10 bg-white/5 py-3 pl-10 pr-4 text-sm text-white placeholder:text-white/30 focus:border-white/20 focus:outline-none"
                />
              </div>
              <Text size="caption2" variant="tertiary">
                Try: Wikipedia articles, travel blogs, news stories, or any page with a striking photo
              </Text>
            </Material>
          )}

          {/* Generate Button */}
          {canGenerate && (
            <Button
              variant="primary"
              className="rounded-full px-8"
              onClick={handleGenerate}
              disabled={
                job?.status === 'imagining' ||
                job?.status === 'uploading' ||
                job?.status === 'processing'
              }
            >
              {selectedImages.length > 1 && mode === 'image'
                ? `Generate Wide Scene from ${selectedImages.length} Images`
                : 'Generate 3D World'}
            </Button>
          )}

          {job?.status === 'error' && (
            <Text size="callout" className="text-red-400">
              {job.error}
            </Text>
          )}
        </div>
      </Stack>

      <ProcessingOverlay
        job={job}
        onDismiss={() => setJob(null)}
        onViewScene={() => {
          const params = new URLSearchParams()
          for (const url of job?.plyUrls ?? []) params.append('ply', url)
          router.push(`/openmarble/viewer?${params}`)
        }}
      />
    </>
  )
}
