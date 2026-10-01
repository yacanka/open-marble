import assert from 'node:assert/strict'
import test from 'node:test'
import { appendProgress, estimateStepRemaining, formatDuration, readGenerationStream } from '../lib/generation-progress.ts'

const encoder = new TextEncoder()
function streamText(text, chunkSize = 7) {
  const bytes = encoder.encode(text)
  return new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += chunkSize) {
        controller.enqueue(bytes.slice(index, index + chunkSize))
      }
      controller.close()
    },
  })
}

test('reads fragmented UTF-8, progress, heartbeats, and a final result without newline', async () => {
  const events = []
  let heartbeats = 0
  const result = await readGenerationStream(streamText([
    JSON.stringify({ type: 'progress', stage: 'model', message: 'İşleniyor: dünya.jpg' }),
    JSON.stringify({ type: 'heartbeat' }),
    JSON.stringify({ type: 'result', result: { scenes: ['scene.ply'] } }),
  ].join('\n'), 1), (event) => events.push(event), () => heartbeats++)
  assert.deepEqual(result, { scenes: ['scene.ply'] })
  assert.equal(events[0].message, 'İşleniyor: dünya.jpg')
  assert.equal(heartbeats, 1)
})

test('rejects terminal errors and connections closed before a result', async () => {
  await assert.rejects(readGenerationStream(streamText('{"type":"error","message":"Unavailable"}\n'), () => {}), /Unavailable/)
  await assert.rejects(readGenerationStream(streamText('{"type":"heartbeat"}\n'), () => {}), /closed before completion/)
})

test('rejects malformed events rather than reporting success', async () => {
  await assert.rejects(readGenerationStream(streamText('invalid\n'), () => {}), SyntaxError)
})

test('retains phase transitions and distinct images, coalesces repeated counters', () => {
  const first = { type: 'progress', stage: 'model', message: 'Rendering', image_index: 1, step_progress: 0.1, receivedAt: 1000 }
  const updated = appendProgress([first], { ...first, step_progress: 0.5, receivedAt: 2000 })
  assert.equal(updated.length, 1)
  assert.equal(updated[0].receivedAt, 1000)
  assert.equal(updated[0].step_progress, 0.5)
  const secondImage = appendProgress(updated, { ...first, image_index: 2, receivedAt: 3000 })
  assert.equal(secondImage.length, 2)
  assert.equal(appendProgress(secondImage, { ...first, stage: 'saving', receivedAt: 4000 }).length, 3)
})

test('formats elapsed durations without negative values', () => {
  assert.equal(formatDuration(-1), '0s')
  assert.equal(formatDuration(61.9), '1m 1s')
})

test('estimates only a measured step and expires outdated estimates', () => {
  const event = { type: 'progress', stage: 'model', message: 'Rendering', step_progress: 0.5, receivedAt: 11000 }
  assert.equal(estimateStepRemaining(event, 1000, 12000), 9)
  assert.equal(estimateStepRemaining(event, 1000, 22000), null)
  assert.equal(estimateStepRemaining({ ...event, step_progress: null }, 1000, 12000), null)
  assert.equal(estimateStepRemaining({ ...event, step_progress: 0 }, 1000, 12000), null)
})
