/**
 * Per-repository `codemap serve` process pool.
 *
 * DSH mounts tools once per profile and dispatches them for every session, so
 * the repository can only be decided per call. This broker lazily starts one
 * MCP child per repository root, reuses it for concurrent calls from every
 * session working in that repository, and recycles idle children so a daemon
 * does not outlive its usefulness.
 */

import { McpClient } from './mcp-client.js'

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_SWEEP_MS = 60 * 1000

export class Broker {
  #command
  #baseArgs
  #timeouts
  #idleMs
  #entries = new Map() // root -> { client, lastUsed }
  #inflight = new Map() // root -> Promise<McpClient>
  #sweepTimer
  #disposed = false

  constructor(options = {}) {
    this.#command = options.command ?? 'codemap'
    this.#baseArgs = options.args ?? ['serve']
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.#timeouts = {
      initTimeoutMs: options.initTimeoutMs,
      callTimeoutMs: options.callTimeoutMs,
    }
    this.#sweepTimer = setInterval(() => this.#sweep(), options.sweepMs ?? DEFAULT_SWEEP_MS)
    this.#sweepTimer.unref?.()
  }

  /** Get a live client for `root`, starting it on first use. */
  async acquire(root, signal) {
    if (this.#disposed) throw new Error('codemap broker is disposed')
    const entry = this.#entries.get(root)
    if (entry !== undefined && entry.client.alive) {
      entry.lastUsed = Date.now()
      return entry.client
    }
    if (entry !== undefined) this.#entries.delete(root)

    const inflight = this.#inflight.get(root)
    if (inflight !== undefined) return inflight

    const start = (async () => {
      const client = new McpClient({
        command: this.#command,
        args: [...this.#baseArgs, '-r', root],
        cwd: root,
        initTimeoutMs: this.#timeouts.initTimeoutMs,
        callTimeoutMs: this.#timeouts.callTimeoutMs,
      })
      client.onExit(() => {
        if (this.#entries.get(root)?.client === client) this.#entries.delete(root)
      })
      try {
        await client.start(signal)
      } catch (error) {
        client.dispose()
        throw error
      }
      if (this.#disposed) {
        client.dispose()
        throw new Error('codemap broker is disposed')
      }
      this.#entries.set(root, { client, lastUsed: Date.now() })
      return client
    })()

    this.#inflight.set(root, start)
    try {
      return await start
    } finally {
      if (this.#inflight.get(root) === start) this.#inflight.delete(root)
    }
  }

  /** Stop every child and the sweep timer. */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    clearInterval(this.#sweepTimer)
    for (const { client } of this.#entries.values()) client.dispose()
    this.#entries.clear()
    this.#inflight.clear()
  }

  #sweep() {
    const now = Date.now()
    for (const [root, entry] of this.#entries) {
      if (now - entry.lastUsed <= this.#idleMs) continue
      this.#entries.delete(root)
      entry.client.dispose()
    }
  }
}
