const fs = require('fs')
const path = require('path')

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  const payload = JSON.stringify(value, null, 2) + '\n'
  fs.writeFileSync(file, payload)
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function resolveFrom(baseDir, maybeRelative) {
  if (!maybeRelative) return null
  const expanded = maybeRelative.startsWith('~/')
    ? path.join(process.env.HOME || '~', maybeRelative.slice(2))
    : maybeRelative
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(baseDir, expanded)
}

function parseLink(link) {
  if (typeof link !== 'string') return null
  const match = /^pear:\/\/(?:(\d+)\.(\d+)\.)?([a-z0-9]+)$/i.exec(link.trim())
  if (!match) return null
  return {
    fork: match[1] ? Number(match[1]) : null,
    length: match[2] ? Number(match[2]) : null,
    key: match[3].toLowerCase()
  }
}

function toVersionedLink(key, length, fork = 0) {
  return `pear://${fork}.${length}.${key}`
}

function readJsonLines(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

module.exports = {
  ensureDir,
  exists,
  parseLink,
  readJson,
  readJsonLines,
  resolveFrom,
  toVersionedLink,
  writeJson
}
