const test = require('node:test')
const assert = require('node:assert/strict')
const { createCheckpointManager } = require('../src/checkpoint')

test('checkpoint manager records progress and completion', () => {
  const releaseCfg = { state: {} }
  let saves = 0
  const manager = createCheckpointManager({
    releaseCfg,
    save: () => {
      saves += 1
    },
    resume: false
  })

  manager.markStep('tools', { toolchain: true })
  manager.complete({ ok: true })

  assert.ok(saves >= 3)
  assert.equal(releaseCfg.state.checkpoint.status, 'completed')
  assert.equal(releaseCfg.state.checkpoint.data.ok, true)
  assert.equal(releaseCfg.state.checkpoint.steps.tools, 'done')
})

test('checkpoint manager resumes failed runs when requested', () => {
  const releaseCfg = {
    state: {
      checkpoint: {
        runId: 'run-1',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        step: 'stage',
        steps: { tools: 'done' },
        data: {
          stage: {
            sourceVerlink: 'pear://0.1.demo'
          }
        }
      }
    }
  }

  const manager = createCheckpointManager({
    releaseCfg,
    save: () => {},
    resume: true
  })

  assert.equal(manager.canResume, true)
  assert.equal(manager.data.stage.sourceVerlink, 'pear://0.1.demo')
  manager.fail('stage', new Error('boom'))
  assert.equal(releaseCfg.state.checkpoint.status, 'failed')
})
