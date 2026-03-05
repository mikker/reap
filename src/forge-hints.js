const fs = require('fs')
const path = require('path')
const { exists } = require('./utils')

function detectForgeHints(projectDir) {
  const candidates = ['forge.config.cjs', 'forge.config.js']
  for (const file of candidates) {
    const abs = path.join(projectDir, file)
    if (!exists(abs)) continue
    const source = fs.readFileSync(abs, 'utf8')
    return {
      identity: extractLiteral(source, /identity\s*:\s*['"`]([^'"`]+)['"`]/),
      keychainProfile: extractLiteral(source, /keychainProfile\s*:\s*['"`]([^'"`]+)['"`]/),
      teamId: extractLiteral(source, /teamId\s*:\s*['"`]([^'"`]+)['"`]/)
    }
  }

  return {
    identity: '',
    keychainProfile: '',
    teamId: ''
  }
}

function extractLiteral(source, pattern) {
  const match = pattern.exec(source)
  return match ? match[1] : ''
}

module.exports = {
  detectForgeHints
}
