/**
 * dsh-codemap — project-scoped code graph tools for DeepSeek Harness.
 *
 * Registered once per profile, these nine tools resolve the repository from
 * the calling session's working directory at call time, so one plugin serves
 * every workspace without per-project MCP entries. The actual work is done by
 * the `codemap` CLI's MCP server (`codemap serve -r <root>`), which this
 * plugin bridges to over stdio per repository.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Broker } from './lib/broker.js'
import { findRepoRoot } from './lib/roots.js'

export const name = 'codemap'
export const inject = ['tools', 'workingDirectory']

const TOOLS = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'))

const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_INIT_TIMEOUT_MS = 30 * 1000
const DEFAULT_CALL_TIMEOUT_MS = 180 * 1000

function numberFromEnv(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Locate the codemap binary: explicit override, the user install, then PATH. */
function resolveCodemap() {
  const override = process.env.CODEMAP_BIN
  if (override !== undefined && override.trim() !== '') return override
  const local = join(homedir(), '.local', 'codemap', 'codemap')
  if (existsSync(local)) return local
  return 'codemap'
}

/** Render one codemap CallToolResult as model-facing text blocks. */
function renderResult(_args, value) {
  const blocks = Array.isArray(value?.content) ? value.content : []
  const text = blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n')
  if (text !== '') return [{ type: 'text', text }]
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Register the codemap tools and the per-repository process pool.
 * @param ctx - Host plugin context with `tools` and `workingDirectory`.
 */
export function apply(ctx) {
  const callTimeoutMs = numberFromEnv('CODEMAP_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS)
  const broker = new Broker({
    command: resolveCodemap(),
    args: ['serve'],
    idleMs: numberFromEnv('CODEMAP_IDLE_MS', DEFAULT_IDLE_MS),
    initTimeoutMs: numberFromEnv('CODEMAP_INIT_TIMEOUT_MS', DEFAULT_INIT_TIMEOUT_MS),
    callTimeoutMs,
  })
  ctx.effect(() => () => broker.dispose())

  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: {
        schema: {
          description: 'Raw MCP CallToolResult from codemap: text content blocks answering the code graph query.',
        },
        render: renderResult,
      },
      timeoutMs: callTimeoutMs + 30 * 1000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (exec.agent === undefined) {
          throw new Error(`codemap tool "${tool.name}" needs an agent session; this call arrived without one`)
        }
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        const root = findRepoRoot(cwd)
        const client = await broker.acquire(root, exec.signal)
        return await client.callTool(tool.name, args, exec.signal)
      },
    })
  }
}
