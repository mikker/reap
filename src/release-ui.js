function createReleaseUi(opts = {}) {
  return new ReleaseUi(opts)
}

class ReleaseUi {
  constructor(opts = {}) {
    this.useColor = opts.color !== false && process.stdout.isTTY && !process.env.NO_COLOR
    this.useSpinner = opts.spinner !== false && process.stdout.isTTY
    this.silent = Boolean(opts.silent)
    this.frames = ['-', '\\', '|', '/']
    this.frameIndex = 0
    this.timer = null
  }

  header(title) {
    this._line(`${this._style('bold', title)}`)
  }

  info(message) {
    this._line(`${this._style('cyan', '[..]')} ${message}`)
  }

  warn(message) {
    this._line(`${this._style('yellow', '[!!]')} ${message}`)
  }

  success(message) {
    this._line(`${this._style('green', '[ok]')} ${message}`)
  }

  error(message) {
    this._line(`${this._style('red', '[xx]')} ${message}`)
  }

  detail(label, value) {
    this._line(`${this._style('dim', `${label}:`)} ${value}`)
  }

  async step(label, fn) {
    this._beginSpinner(label)
    try {
      const result = await fn()
      this._endSpinner('success', label)
      return result
    } catch (err) {
      this._endSpinner('error', label)
      if (err && !err.reapStep) err.reapStep = label
      throw err
    }
  }

  _beginSpinner(label) {
    if (this.silent) return
    this._endSpinner()

    if (!this.useSpinner) {
      this.info(label)
      return
    }

    this.timer = setInterval(() => {
      const frame = this.frames[this.frameIndex % this.frames.length]
      this.frameIndex += 1
      process.stdout.write(`\r${this._style('cyan', frame)} ${label}`)
    }, 80)
  }

  _endSpinner(state, label) {
    if (this.silent) return
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (!label) return

    if (this.useSpinner) {
      process.stdout.write('\r\x1b[2K')
    }

    if (state === 'success') {
      this.success(label)
      return
    }

    if (state === 'error') {
      this.error(label)
    }
  }

  _line(message) {
    if (this.silent) return
    this._endSpinner()
    process.stdout.write(`${message}\n`)
  }

  _style(kind, text) {
    if (!this.useColor) return text
    const colors = {
      dim: ['\x1b[2m', '\x1b[22m'],
      bold: ['\x1b[1m', '\x1b[22m'],
      red: ['\x1b[31m', '\x1b[39m'],
      green: ['\x1b[32m', '\x1b[39m'],
      yellow: ['\x1b[33m', '\x1b[39m'],
      cyan: ['\x1b[36m', '\x1b[39m']
    }
    const pair = colors[kind]
    if (!pair) return text
    return `${pair[0]}${text}${pair[1]}`
  }
}

module.exports = {
  createReleaseUi
}
