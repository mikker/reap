const chalk = require('chalk')
const ora = require('ora')

function createReleaseUi(opts = {}) {
  return new ReleaseUi(opts)
}

class ReleaseUi {
  constructor(opts = {}) {
    this.useColor = opts.color !== false && process.stdout.isTTY && !process.env.NO_COLOR
    this.silent = Boolean(opts.silent)
    this.useSpinner = opts.spinner !== false && process.stdout.isTTY && !this.silent
    this.spinner = null
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
    this._stopSpinner()

    if (!this.useSpinner) {
      this.info(label)
      return
    }

    this.spinner = ora({
      text: label,
      discardStdin: false
    }).start()
  }

  _endSpinner(state, label) {
    if (this.silent) return
    if (this.spinner) {
      if (state === 'success') this.spinner.succeed(label)
      else if (state === 'error') this.spinner.fail(label)
      else this.spinner.stop()
      this.spinner = null
      return
    }

    if (!label) return
    if (state === 'success') this.success(label)
    else if (state === 'error') this.error(label)
  }

  _stopSpinner() {
    if (!this.spinner) return
    this.spinner.stop()
    this.spinner = null
  }

  _line(message) {
    if (this.silent) return
    if (this.spinner) {
      const activeText = this.spinner.text
      this.spinner.stop()
      process.stdout.write(`${message}\n`)
      this.spinner = ora({
        text: activeText,
        discardStdin: false
      }).start()
      return
    }

    process.stdout.write(`${message}\n`)
  }

  _style(kind, text) {
    if (!this.useColor) return text
    if (kind === 'dim') return chalk.dim(text)
    if (kind === 'bold') return chalk.bold(text)
    if (kind === 'red') return chalk.red(text)
    if (kind === 'green') return chalk.green(text)
    if (kind === 'yellow') return chalk.yellow(text)
    if (kind === 'cyan') return chalk.cyan(text)
    return text
  }
}

module.exports = {
  createReleaseUi
}
