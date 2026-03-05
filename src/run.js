const { spawn } = require('child_process')

function run(command, args = [], opts = {}) {
  const {
    cwd,
    env,
    input,
    allowFailure = false,
    streamOutput = true,
    label,
    inheritStdio = false,
    timeoutMs = 0
  } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: inheritStdio ? 'inherit' : 'pipe'
    })

    let stdout = ''
    let stderr = ''

    if (!inheritStdio) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')

      child.stdout.on('data', (chunk) => {
        stdout += chunk
        if (streamOutput) process.stdout.write(chunk)
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk
        if (streamOutput) process.stderr.write(chunk)
      })
    }

    child.on('error', reject)

    let timedOut = false
    let timeout = null
    if (timeoutMs && Number(timeoutMs) > 0) {
      timeout = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGTERM')
        } catch {}
      }, Number(timeoutMs))
    }

    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout)

      const out = {
        code,
        stdout,
        stderr,
        command: [command, ...args].join(' ')
      }

      if (timedOut) {
        const timeoutError = `timed out after ${timeoutMs}ms`
        if (allowFailure) {
          resolve({
            ...out,
            code: code == null ? 124 : code,
            stderr: [stderr, timeoutError].filter(Boolean).join('\n')
          })
          return
        }
        const where = label ? ` (${label})` : ''
        const err = new Error(`Command failed${where}: ${out.command}\n${timeoutError}`)
        err.result = out
        reject(err)
        return
      }

      if (code === 0 || allowFailure) {
        resolve(out)
        return
      }

      const where = label ? ` (${label})` : ''
      const err = new Error(
        `Command failed${where}: ${out.command}\n` +
          `${stderr.trim() || stdout.trim() || `exit code ${code}`}`
      )
      err.result = out
      reject(err)
    })

    if (!inheritStdio && input) {
      child.stdin.write(input)
    }
    if (!inheritStdio) child.stdin.end()
  })
}

async function commandExists(command) {
  const res = await run('sh', ['-lc', `command -v ${escapeForShell(command)}`], {
    allowFailure: true,
    streamOutput: false
  })
  return res.code === 0
}

function escapeForShell(value) {
  return String(value).replace(/[^A-Za-z0-9_./:-]/g, '')
}

module.exports = {
  commandExists,
  run
}
