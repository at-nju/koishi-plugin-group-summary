import assert from 'node:assert/strict'
import test from 'node:test'
import { skipWhileRunning } from '../src/index'

test('skips overlapping cycles and unlocks after failure', async () => {
  let release!: () => void
  let attempts = 0
  const cycle = skipWhileRunning(async () => {
    attempts++
    if (attempts === 1) await new Promise<void>(resolve => { release = resolve })
    else throw new Error('publish failed')
  })

  const first = cycle()
  await cycle()
  assert.equal(attempts, 1)
  release()
  await first

  await assert.rejects(cycle(), /publish failed/)
  await assert.rejects(cycle(), /publish failed/)
  assert.equal(attempts, 3)
})
