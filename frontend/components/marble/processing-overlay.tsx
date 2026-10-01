'use client'

import { Check, CircleAlert, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/core/button'
import { Material } from '@/components/core/material'
import { estimateStepRemaining, formatDuration } from '@/lib/generation-progress'
import type { GenerationJob } from '@/lib/marble-atoms'

interface ProcessingOverlayProps {
  job: GenerationJob | null
  onDismiss?: () => void
  onViewScene?: () => void
}

function isRunning(job: GenerationJob) {
  return ['imagining', 'uploading', 'processing'].includes(job.status)
}

function getJobMessage(job: GenerationJob) {
  if (job.status === 'error') return job.error
  if (job.progress) return job.progress.message
  if (job.status !== 'imagining') return 'Preparing images…'
  return job.sourceUrl ? 'Finding an image on the page…' : 'Generating the source image…'
}

function getRemainingTime(job: GenerationJob, now: number) {
  const current = job.progress
  if (current?.stage === 'queued' && current.eta_seconds != null) {
    return `About ${formatDuration(current.eta_seconds)} in the queue; generation time unknown`
  }
  const estimate = estimateStepRemaining(current, job.history?.at(-1)?.receivedAt, now)
  if (estimate === null) return 'Not yet available for this step'
  return `About ${formatDuration(estimate)} for this step (estimated)`
}

function imageState(
  index: number,
  job: GenerationJob,
  complete: Set<number | undefined>,
  failed: Set<number | undefined>
) {
  if (complete.has(index)) return 'Ready'
  if (failed.has(index)) return 'Failed'
  if (!isRunning(job)) return 'Not processed'
  if (job.progress?.image_index === index) return 'Processing'
  return 'Waiting'
}

function ImageProgress({
  job,
  complete,
  failed,
}: {
  job: GenerationJob
  complete: Set<number | undefined>
  failed: Set<number | undefined>
}) {
  const colors: Record<string, string> = { Ready: 'text-green-400', Failed: 'text-red-400' }
  return (
    <ol className="space-y-2 text-sm" aria-label="Image processing status">
      {job.imageNames?.map((name, index) => {
        const state = imageState(index + 1, job, complete, failed)
        return (
          <li key={`${index}-${name}`} className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-all text-white/70">
              {index + 1}. {name}
            </span>
            <span className={`shrink-0 ${colors[state] ?? 'text-white/50'}`}>{state}</span>
          </li>
        )
      })}
    </ol>
  )
}

function ActivityLog({ job }: { job: GenerationJob }) {
  const logRef = useRef<HTMLOListElement>(null)
  const followLog = useRef(true)
  const history = job.history ?? []
  useEffect(() => {
    if (history.length && followLog.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [history])
  return (
    <div className="min-h-0 border-white/10 border-t pt-4">
      <h3 className="mb-3 font-medium text-sm">Activity log</h3>
      <ol
        ref={logRef}
        tabIndex={0}
        aria-label="Activity log"
        onScroll={() => {
          const log = logRef.current
          if (log) followLog.current = log.scrollHeight - log.scrollTop - log.clientHeight < 32
        }}
        className="max-h-44 space-y-3 overflow-y-auto pr-2 text-xs"
      >
        {history.length === 0 && <li className="text-white/50">Waiting for the first update…</li>}
        {history.map((entry, index) => (
          <li key={`${index}-${entry.receivedAt}`} className="flex gap-3">
            <time className="w-12 shrink-0 text-white/40 tabular-nums">
              {formatDuration((entry.receivedAt - job.createdAt) / 1000)}
            </time>
            <span
              className={`min-w-0 break-words ${entry.stage === 'image_error' ? 'text-red-400' : entry.stage === 'warning' ? 'text-amber-300' : 'text-white/70'}`}
            >
              {entry.filename && <span className="font-medium">{entry.filename} · </span>}
              {entry.message}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function CurrentStep({ job }: { job: GenerationJob }) {
  const running = isRunning(job)
  const current = job.progress
  const count = job.imageCount ?? 1
  const message = getJobMessage(job)
  const fraction = current?.step_progress
  const hasFraction = running && typeof fraction === 'number' && Number.isFinite(fraction)
  const percent = hasFraction ? Math.round(Math.min(1, Math.max(0, fraction)) * 100) : undefined
  return (
    <>
      <div className="flex items-start gap-3" role="status" aria-live="polite">
        {running ? (
          <LoaderCircle className="mt-1 size-5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : job.status === 'error' ? (
          <CircleAlert className="mt-1 size-5 shrink-0 text-red-400" />
        ) : (
          <Check className="mt-1 size-5 shrink-0 text-green-400" />
        )}
        <div className="min-w-0">
          <p className="break-words font-medium text-base">{message}</p>
          {current?.filename && running && (
            <p className="mt-1 break-all text-sm text-white/60">
              Image {current.image_index} of {count} · {current.filename}
            </p>
          )}
        </div>
      </div>

      {hasFraction && (
        <div className="space-y-2">
          <div className="flex justify-between gap-3 text-white/60 text-xs">
            <span>
              Current step
              {current?.step_total
                ? ` · ${current.step_index ?? 0} / ${current.step_total} ${current.unit ?? 'steps'}`
                : ''}
            </span>
            <span className="tabular-nums">{percent}%</span>
          </div>
          <progress
            aria-label="Current step progress"
            max={100}
            value={percent}
            className="h-1.5 w-full accent-white"
          />
        </div>
      )}
    </>
  )
}

export function ProcessingDetails({ job }: { job: GenerationJob }) {
  const [now, setNow] = useState(Date.now())
  const running = isRunning(job)
  const history = job.history ?? []
  const current = job.progress
  const end = job.finishedAt ?? now
  const elapsed = (end - job.createdAt) / 1000
  const stageElapsed = (end - (history.at(-1)?.receivedAt ?? job.createdAt)) / 1000
  const lastActivity = (now - (job.lastActivityAt ?? job.createdAt)) / 1000
  const complete = new Set(
    history.filter((event) => event.stage === 'image_completed').map((event) => event.image_index)
  )
  const failed = new Set(
    history.filter((event) => event.stage === 'image_error').map((event) => event.image_index)
  )
  const count = job.imageCount ?? 1
  const remaining = getRemainingTime(job, now)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])

  return (
    <div className="flex min-h-0 flex-col gap-5 text-white">
      <CurrentStep job={job} />

      <dl className="grid grid-cols-2 gap-x-5 gap-y-3 border-white/10 border-y py-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-white/50">Elapsed</dt>
          <dd className="mt-1 tabular-nums">{formatDuration(elapsed)}</dd>
        </div>
        <div>
          <dt className="text-white/50">Scenes ready</dt>
          <dd className="mt-1 tabular-nums">
            {complete.size} / {count}
            {failed.size > 0 ? ` · ${failed.size} failed` : ''}
          </dd>
        </div>
        <div>
          <dt className="text-white/50">Images remaining</dt>
          <dd className="mt-1 tabular-nums">{Math.max(0, count - complete.size - failed.size)}</dd>
        </div>
        {running && (
          <div>
            <dt className="text-white/50">Current step</dt>
            <dd className="mt-1 tabular-nums">{formatDuration(stageElapsed)}</dd>
          </div>
        )}
        {running && (
          <div className="col-span-2">
            <dt className="text-white/50">Estimated time remaining</dt>
            <dd className="mt-1 text-white/75">{remaining}</dd>
          </div>
        )}
      </dl>

      {current?.stage === 'queued' && current.queue_position != null && running && (
        <p className="text-sm text-white/70">Queue position: {current.queue_position}</p>
      )}
      {running && (
        <p className={`text-xs ${lastActivity > 30 ? 'text-amber-300' : 'text-white/50'}`}>
          {job.status === 'uploading'
            ? 'Uploading images; waiting for the server to confirm receipt.'
            : lastActivity > 30
              ? `No server update for ${formatDuration(lastActivity)}. The connection may be interrupted; completion is not confirmed.`
              : 'Live connection · Waiting for updates during long model operations.'}
        </p>
      )}

      <ImageProgress job={job} complete={complete} failed={failed} />

      <ActivityLog job={job} />
    </div>
  )
}

export function ProcessingOverlay({ job, onDismiss, onViewScene }: ProcessingOverlayProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (job && !dialogRef.current?.open) dialogRef.current?.showModal()
    if (!job) dialogRef.current?.close()
  }, [job?.id])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="generation-title"
      onCancel={(event) => {
        event.preventDefault()
        if (job && !isRunning(job)) onDismiss?.()
      }}
      className="fixed inset-0 m-auto max-h-[92dvh] w-[min(640px,calc(100%-2rem))] max-w-none overflow-y-auto border-0 bg-transparent p-0 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      {job && (
        <Material thickness="thick" className="flex flex-col gap-5 p-6 sm:p-8">
          <h2 id="generation-title" className="font-semibold text-xl">
            {isRunning(job) ? 'Creating your 3D world' : 'Generation report'}
          </h2>
          <ProcessingDetails job={job} />
          {!isRunning(job) && (
            <div className="flex flex-wrap justify-end gap-3">
              <Button variant="secondary" onClick={onDismiss}>
                Close
              </Button>
              {!!job.plyUrls?.length && (
                <Button variant="primary" onClick={onViewScene}>
                  Open scene
                </Button>
              )}
            </div>
          )}
        </Material>
      )}
    </dialog>
  )
}
