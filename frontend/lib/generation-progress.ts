export interface GenerationProgress {
  type: 'progress'
  stage: string
  message: string
  elapsed_seconds?: number
  image_index?: number
  image_count?: number
  filename?: string
  completed_count?: number
  step_progress?: number | null
  step_index?: number | null
  step_total?: number | null
  unit?: string | null
  queue_position?: number | null
  eta_seconds?: number | null
}

export interface ProgressEntry extends GenerationProgress {
  receivedAt: number
}

function parseGenerationEvent<T>(
  line: string,
  onProgress: (event: GenerationProgress) => void,
  onHeartbeat?: () => void
): { result: T } | undefined {
  const event = JSON.parse(line)
  if (event.type === 'error') throw new Error(event.message || 'Generation failed')
  if (event.type === 'result') return { result: event.result as T }
  if (event.type === 'progress') onProgress(event)
  if (event.type === 'heartbeat') onHeartbeat?.()
}

/** Parse NDJSON across arbitrary UTF-8 and network chunk boundaries. */
export async function readGenerationStream<T>(
  stream: ReadableStream<Uint8Array>,
  onProgress: (event: GenerationProgress) => void,
  onHeartbeat?: () => void
): Promise<T> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      pending += decoder.decode(value, { stream: !done })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      if (done) lines.push(pending)
      for (const line of lines.filter((line) => line.trim())) {
        const parsed = parseGenerationEvent<T>(line, onProgress, onHeartbeat)
        if (parsed) return parsed.result
      }
      if (done)
        throw new Error(
          'Progress connection closed before completion. Check the gallery before retrying.'
        )
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Keep phase transitions, while replacing repeated frame/download counters. */
export function appendProgress(history: ProgressEntry[], event: ProgressEntry): ProgressEntry[] {
  const last = history.at(-1)
  if (
    last?.stage === event.stage &&
    last.message === event.message &&
    last.image_index === event.image_index
  ) {
    return [...history.slice(0, -1), { ...event, receivedAt: last.receivedAt }]
  }
  return [...history, event]
}

export function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(rounded / 60)
  return minutes > 0 ? `${minutes}m ${rounded % 60}s` : `${rounded}s`
}

/** Estimate only the current measured step; never extrapolate whole-model loading. */
export function estimateStepRemaining(
  current: ProgressEntry | undefined,
  startedAt: number | undefined,
  now: number
): number | null {
  const fraction = current?.step_progress
  if (!current || startedAt === undefined || typeof fraction !== 'number') return null
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return null
  const sampledSeconds = (current.receivedAt - startedAt) / 1000
  const remaining = (sampledSeconds * (1 - fraction)) / fraction - (now - current.receivedAt) / 1000
  return remaining > 0 ? remaining : null
}
