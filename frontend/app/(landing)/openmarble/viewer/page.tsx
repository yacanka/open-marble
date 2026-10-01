'use client'

import { Suspense, useCallback, useMemo, useRef, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { Stack } from '@/components/core/stack'
import { Button } from '@/components/core/button'
import { Text } from '@/components/core/text'
import { Material } from '@/components/core/material'
import { ActivityIndicator } from '@/components/activity-indicator'
import {
  SceneViewer,
  type SceneViewerHandle,
  type TransformMode,
} from '@/components/marble/scene-viewer'
import { AssetPanel } from '@/components/marble/asset-panel'
import { cn } from '@/lib/utils'
import { useAtomValue } from 'jotai'
import { currentJobAtom } from '@/lib/marble-atoms'
import { ProcessingOverlay } from '@/components/marble/processing-overlay'

function TransformToolbar({
  mode,
  onModeChange,
  hasSelection,
}: {
  mode: TransformMode
  onModeChange: (mode: TransformMode) => void
  hasSelection: boolean
}) {
  if (!hasSelection) return null

  const modes: { key: TransformMode; label: string; shortcut: string }[] = [
    { key: 'translate', label: 'Move', shortcut: 'W' },
    { key: 'rotate', label: 'Rotate', shortcut: 'E' },
    { key: 'scale', label: 'Scale', shortcut: 'R' },
  ]

  return (
    <Material
      thickness="thinnest"
      className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 px-2 py-1.5"
    >
      {modes.map((m) => (
        <Button
          key={m.key}
          variant={mode === m.key ? 'selected' : 'secondary'}
          className="rounded-full px-3 text-sm"
          onClick={() => onModeChange(m.key)}
        >
          <span>{m.label}</span>
          <span
            className={cn(
              'ml-1.5 text-[10px] opacity-40',
              mode === m.key && 'opacity-60',
            )}
          >
            {m.shortcut}
          </span>
        </Button>
      ))}
      <Text size="caption2" variant="tertiary" className="ml-2 px-1">
        Del to remove · Esc to deselect
      </Text>
    </Material>
  )
}

function ViewerContent() {
  const job = useAtomValue(currentJobAtom)
  const [showReport, setShowReport] = useState(false)
  const searchParams = useSearchParams()
  const router = useRouter()
  const sceneQuery = searchParams.toString()
  const plyUrls = useMemo(
    () => new URLSearchParams(sceneQuery).getAll('ply').filter(Boolean),
    [sceneQuery],
  )
  const plyUrl = plyUrls[0]
  const viewerRef = useRef<SceneViewerHandle>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [transformMode, setTransformMode] = useState<TransformMode>('translate')

  const handleAddAsset = useCallback(
    (url: string, name: string, defaultScale?: number) => {
      viewerRef.current?.addModel(url, name, defaultScale)
    },
    [],
  )

  const handleRemoveSelected = useCallback(() => {
    viewerRef.current?.removeSelected()
    setSelectedModelId(null)
  }, [])

  const handleModeChange = useCallback((mode: TransformMode) => {
    setTransformMode(mode)
    viewerRef.current?.setTransformMode(mode)
  }, [])

  if (!plyUrl) {
    return (
      <Stack material options={{ title: 'Viewer', headerShown: true }}>
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <Text size="title3" variant="secondary">
            No world selected
          </Text>
          <Button
            variant="primary"
            className="rounded-full px-6"
            onClick={() => router.push('/openmarble')}
          >
            Create World
          </Button>
        </div>
      </Stack>
    )
  }

  return (
    <div className="grid h-full w-full grid-cols-[1fr_220px] gap-7">
      <Stack
        material
        options={{
          title: 'World Viewer',
          headerShown: true,
          headerLeft: (
            <Button
              variant="secondary"
              className="rounded-full"
              onClick={() => router.back()}
            >
              Back
            </Button>
          ),
          headerRight: (
            <div className="flex items-center gap-2">
              {job?.status === 'completed' && job.plyUrls?.includes(plyUrl) && (
                <Button variant="secondary" className="rounded-full" onClick={() => setShowReport(true)}>
                  Generation report
                </Button>
              )}
              {plyUrls.length > 1 && (
                <Text size="caption1" variant="secondary">
                  {plyUrls.length} scene layers
                </Text>
              )}
              <Button variant="secondary" className="rounded-full" asChild>
                <a href={plyUrl} download>
                  Download
                </a>
              </Button>
            </div>
          ),
        }}
      >
        <div className="relative flex h-full overflow-hidden rounded-b-[var(--view-radius)]">
          <SceneViewer
            ref={viewerRef}
            plyUrls={plyUrls}
            className="flex-1"
            onSelectModel={setSelectedModelId}
            onTransformModeChange={setTransformMode}
          />
          <TransformToolbar
            mode={transformMode}
            onModeChange={handleModeChange}
            hasSelection={selectedModelId !== null}
          />
        </div>
      </Stack>
      <ProcessingOverlay job={showReport ? job : null} onDismiss={() => setShowReport(false)} onViewScene={() => setShowReport(false)} />
      <AssetPanel
        onAddAsset={handleAddAsset}
        selectedModelId={selectedModelId}
        onRemoveSelected={handleRemoveSelected}
      />
    </div>
  )
}

export default function ViewerPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <ActivityIndicator className="size-8 animate-spin text-white" />
        </div>
      }
    >
      <ViewerContent />
    </Suspense>
  )
}
