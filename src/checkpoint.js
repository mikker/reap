function createCheckpointManager({ releaseCfg, save, resume = false }) {
  if (!releaseCfg.state) releaseCfg.state = {}

  const previous = releaseCfg.state.checkpoint || null
  const canResume = Boolean(
    resume &&
      previous &&
      (previous.status === 'failed' || previous.status === 'running') &&
      previous.data &&
      typeof previous.data === 'object'
  )

  const runId = canResume ? previous.runId : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const checkpoint = canResume
    ? {
        ...previous,
        status: 'running',
        updatedAt: new Date().toISOString()
      }
    : {
        runId,
        status: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        step: 'start',
        steps: {},
        data: {},
        error: null
      }

  releaseCfg.state.checkpoint = checkpoint
  save()

  return {
    runId,
    canResume,
    data: checkpoint.data || {},
    markStep(step, patch) {
      checkpoint.step = step
      checkpoint.updatedAt = new Date().toISOString()
      if (!checkpoint.steps) checkpoint.steps = {}
      checkpoint.steps[step] = 'done'
      if (patch && typeof patch === 'object') {
        checkpoint.data = {
          ...(checkpoint.data || {}),
          ...patch
        }
      }
      save()
    },
    fail(step, err) {
      checkpoint.status = 'failed'
      checkpoint.step = step || checkpoint.step
      checkpoint.updatedAt = new Date().toISOString()
      checkpoint.error = err ? summarizeError(err) : null
      save()
    },
    complete(summaryPatch) {
      checkpoint.status = 'completed'
      checkpoint.step = 'done'
      checkpoint.updatedAt = new Date().toISOString()
      checkpoint.error = null
      checkpoint.data = {
        ...(checkpoint.data || {}),
        ...(summaryPatch || {})
      }
      save()
    }
  }
}

function summarizeError(err) {
  const message = err && err.message ? String(err.message) : String(err)
  return message.replace(/\s+/g, ' ').trim().slice(0, 500)
}

module.exports = {
  createCheckpointManager
}
