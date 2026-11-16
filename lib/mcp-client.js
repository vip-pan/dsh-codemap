/**
 * Minimal MCP (Model Context Protocol) stdio client used by the codemap plugin.
 *
 * Why hand-rolled instead of @modelcontextprotocol/sdk: the Host plugin runs
 * inside the DeepSeek Harness process, whose bundled node_modules is not on a
 * profile plugin's resolution path, and this client needs only the three calls
 * codemap implements (initialize, tools/list, tools/call). One JSON object per
 * line over stdio is the whole wire format.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const PROTOCOL_VERSION = '2024-11-05'

function abortError() {
  const error = new Error('codemap request aborted')
  error.name = 'AbortError'
  return error
}

function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
}

export class McpClient {
  #command
  #args
  #cwd
  #env
  #initTimeoutMs
  #callTimeoutMs
  #child
  #lines
  #nextId = 1
  #pending = new Map()
  #stderr = ''
  #closed = false
  #exitListeners = new Set()

  constructor(options = {}) {
    this.#command = options.command ?? 'codemap'
    this.#args = options.args ?? []
    this.#cwd = options.cwd
    this.#env = options.env ?? process.env
    this.#initTimeoutMs = options.initTimeoutMs ?? 30_000
    this.#callTimeoutMs = options.callTimeoutMs ?? 180_000
  }

  /** Whether the child process is still running and the client usable. */
  get alive() {
    return !this.#closed && this.#child !== undefined && this.#child.exitCode === null && !this.#child.killed
  }

  /** Register a listener invoked once when the child exits or the client closes. */
  onExit(listener) {
    this.#exitListeners.add(listener)
    return () => this.#exitListeners.delete(listener)
  }

  /** Spawn the child and complete the MCP initialize handshake. */
  async start(signal) {
    if (this.#child !== undefined) throw new Error('codemap client already started')
    this.#child = spawn(this.#command, this.#args, {
      cwd: this.#cwd,
      env: this.#env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child.on('error', error => this.#failAll(error))
    this.#child.on('exit', (code, signalName) => {
      const tail = this.#stderr.trim().split('\n').slice(-6).join('\n')
      this.#failAll(new Error(`codemap serve exited (code=${code}, signal=${signalName})${tail === '' ? '' : `\n${tail}`}`))
    })
    this.#child.stdin.on('error', () => {}) // EPIPE when the child dies mid-write
    this.#child.stderr.on('data', chunk => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-8192)
    })
    this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity })
    this.#lines.on('line', line => this.#onLine(line))

    const result = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-codemap', version: '0.1.0' },
    }, this.#initTimeoutMs, signal)
    this.#send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    return result
  }

  /** Call one MCP tool and return its raw CallToolResult. */
  async callTool(name, args, signal) {
    const result = await this.#request('tools/call', { name, arguments: args ?? {} }, this.#callTimeoutMs, signal)
    if (result?.isError) {
      const error = new Error(textOf(result) || `codemap tool "${name}" failed`)
      error.name = 'CodemapToolError'
      error.result = result
      throw error
    }
    return result
  }

  /** Ask codemap for its live tool list (used by diagnostics and tests). */
  async listTools(signal) {
    const result = await this.#request('tools/list', {}, this.#callTimeoutMs, signal)
    return result?.tools ?? []
  }

  /** Terminate the child; pending calls reject with a closed-client error. */
  dispose() {
    if (this.#closed) return
    this.#failAll(new Error('codemap client disposed'))
    try {
      this.#child?.kill('SIGTERM')
    } catch {
      // already gone
    }
    const child = this.#child
    if (child !== undefined && child.exitCode === null) {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }, 2_000)
      timer.unref?.()
    }
  }

  #send(message) {
    if (this.#closed || this.#child === undefined) return
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // the exit handler settles pending calls
    }
  }

  #onLine(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return // codemap logs on stderr; tolerate any stray stdout noise
    }
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && message.id !== null && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id)
      if (message.error !== undefined) {
        const error = new Error(`codemap error ${message.error.code}: ${message.error.message}`)
        error.code = message.error.code
        error.data = message.error.data
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    // A server-initiated request must be answered to keep the session healthy.
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      this.#send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
    }
  }

  #request(method, params, timeoutMs, signal) {
    if (this.#closed) return Promise.reject(new Error('codemap client is closed'))
    if (signal?.aborted) return Promise.reject(abortError())
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#pending.delete(id)
        callback(value)
      }
      const onAbort = () => {
        this.#send({
          jsonrpc: '2.0',
          method: 'notifications/cancelled',
          params: { requestId: id, reason: 'client aborted' },
        })
        settle(reject, abortError())
      }
      const timer = setTimeout(() => {
        settle(reject, new Error(`codemap ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.#pending.set(id, { resolve: value => settle(resolve, value), reject: error => settle(reject, error) })
      this.#send({ jsonrpc: '2.0', id, method, params })
    })
  }

  #failAll(error) {
    if (this.#closed) return
    this.#closed = true
    this.#lines?.close()
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) entry.reject(error)
    for (const listener of [...this.#exitListeners]) {
      try {
        listener(error)
      } catch {
        // listeners must not break settlement of the other pending calls
      }
    }
  }
}
