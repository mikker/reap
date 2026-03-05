function warningLines(output) {
  const cleaned = stripAnsi(String(output || ''))
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const seen = new Set()
  const warnings = []
  for (const line of lines) {
    if (!/\bwarning\b/i.test(line)) continue
    const key = line.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    warnings.push(line)
  }
  return warnings
}

function hasLikelyError(output) {
  const cleaned = stripAnsi(String(output || ''))
  return /\b(error|errors|failed|failure|exception|traceback|bail|enoent|eacces)\b/i.test(cleaned)
}

function isWarningOnlyFailure(result) {
  const output = [result && result.stdout, result && result.stderr].filter(Boolean).join('\n')
  if (!result || result.code === 0) return false
  const warnings = warningLines(output)
  if (warnings.length === 0) return false
  return !hasLikelyError(output)
}

function formatOutputTail(output, maxLines = 8) {
  const cleaned = stripAnsi(String(output || ''))
  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length <= maxLines) return lines.join('\n')
  return lines.slice(-maxLines).join('\n')
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
}

module.exports = {
  formatOutputTail,
  hasLikelyError,
  isWarningOnlyFailure,
  warningLines
}
