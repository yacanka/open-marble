'use client'

import Image from 'next/image'
import { useCallback, useRef, useState } from 'react'
import { Material } from '@/components/core/material'
import { Text } from '@/components/core/text'
import { cn } from '@/lib/utils'

export interface SelectedImage {
  file: File
  previewUrl: string
}

interface ImageUploadProps {
  images: SelectedImage[]
  onFilesSelect: (files: File[]) => void
  onRemove: (index: number) => void
  maxFiles?: number
  className?: string
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
      className="size-7"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function ImageUpload({
  images,
  onFilesSelect,
  onRemove,
  maxFiles = 4,
  className,
}: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return
      const imageFiles = Array.from(fileList).filter((file) => file.type.startsWith('image/'))
      if (imageFiles.length > 0) onFilesSelect(imageFiles)
    },
    [onFilesSelect]
  )

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragging(false)
      addFiles(event.dataTransfer.files)
    },
    [addFiles]
  )

  const handleFileInput = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(event.target.files)
      event.target.value = ''
    },
    [addFiles]
  )

  const openPicker = () => inputRef.current?.click()
  const canAddMore = images.length < maxFiles

  return (
    <Material
      thickness="thin"
      className={cn(
        'relative flex min-h-[320px] w-full max-w-[780px] items-center justify-center overflow-hidden',
        'transition-[box-shadow,background-color] duration-300',
        isDragging && 'bg-white/10 ring-2 ring-white/30',
        className
      )}
      onDragOver={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        className="hidden"
        onChange={handleFileInput}
      />

      {images.length === 0 ? (
        <button
          type="button"
          className="flex min-h-[320px] w-full flex-col items-center justify-center gap-3 p-8"
          onClick={openPicker}
        >
          <UploadIcon className="text-white/40" />
          <Text size="body" variant="secondary">
            Drop images or click to upload
          </Text>
          <Text size="caption1" variant="tertiary">
            Up to {maxFiles} PNG, JPG, or WebP images
          </Text>
        </button>
      ) : (
        <div className="flex w-full flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3 px-2">
            <div>
              <Text size="callout">Scene sequence</Text>
              <Text size="caption1" variant="tertiary" className="mt-1">
                Images are arranged from left to right in the 3D scene
              </Text>
            </div>
            <Text size="caption1" variant="secondary" className="shrink-0">
              {images.length}/{maxFiles}
            </Text>
          </div>

          <div className="flex min-h-[235px] gap-3 overflow-x-auto pb-1">
            {images.map((image, index) => (
              <div
                key={`${image.file.name}-${image.file.lastModified}-${index}`}
                className={cn(
                  'group relative min-w-[160px] flex-1 overflow-hidden rounded-[24px] border border-white/10 bg-black/20',
                  images.length === 1 && 'min-w-full'
                )}
              >
                <Image
                  src={image.previewUrl}
                  alt={`Scene image ${index + 1}: ${image.file.name}`}
                  fill
                  sizes={images.length === 1 ? '780px' : '200px'}
                  unoptimized
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/80 to-transparent px-3 pt-10 pb-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white font-semibold text-black text-xs">
                    {index + 1}
                  </span>
                  <span className="truncate text-white/80 text-xs">{image.file.name}</span>
                </div>
                <button
                  type="button"
                  aria-label={`Remove ${image.file.name}`}
                  className="absolute top-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/55 text-white/70 backdrop-blur-md transition-colors hover:bg-red-500/70 hover:text-white"
                  onClick={() => onRemove(index)}
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden="true"
                    className="size-4"
                  >
                    <path d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
            ))}

            {canAddMore && (
              <button
                type="button"
                className="flex min-w-[132px] flex-col items-center justify-center gap-2 rounded-[24px] border border-white/20 border-dashed bg-white/5 text-white/45 transition-colors hover:border-white/35 hover:bg-white/10 hover:text-white/75"
                onClick={openPicker}
              >
                <PlusIcon />
                <span className="text-xs">Add images</span>
              </button>
            )}
          </div>
        </div>
      )}
    </Material>
  )
}
