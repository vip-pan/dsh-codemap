import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Broker } from '../lib/broker.js'
import { findRepoRoot } from '../lib/roots.js'

// Root discovery is pure filesystem logic, so it needs no codemap index.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-codemap-'))
try {
  const plain = join(scratch, 'plain-git-repo')
  await mkdir(join(plain, '.git'), { recursive: true })
  await mkdir(join(plain, 'src', 'main'), { recursive: true })
  assert.equal(findRepoRoot(plain), plain)
  assert.equal(findRepoRoot(join(plain, 'src', 'main')), plain)

  const nested = join(plain, 'vendor', 'nested')
  await mkdir(join(nested, '.codemaker'), { recursive: true })
  assert.equal(findRepoRoot(nested), nested, 'the nearest .codemaker wins over a parent .git')
} finally {
  await rm(scratch, { recursive: true, force: true })
}
console.log('root discovery ok')

// Everything below needs a real repository that codemap has indexed.
const repo = process.env.CODEMAP_TEST_REPO
if (repo === undefined) {
  console.log('SKIP broker tests: set CODEMAP_TEST_REPO to a repository indexed by codemap')
  process.exit(0)
}

const broker = new Broker({ idleMs: 60_000, initTimeoutMs: 30_000, callTimeoutMs: 120_000 })
try {
  const first = await broker.acquire(repo, AbortSignal.timeout(60_000))
  assert.equal(first.alive, true)
  const stats = await first.callTool('get_graph_stats', {})
  console.log('stats:', stats.content?.[0]?.text?.slice(0, 200))

  // Same root => same reused client; concurrent calls must both settle.
  const again = await broker.acquire(repo, AbortSignal.timeout(60_000))
  assert.equal(again, first, 'same repository must reuse one client')
  const [a, b] = await Promise.all([
    first.callTool('get_graph_stats', {}),
    first.callTool('search_code', { matches: ['main'] }),
  ])
  assert.ok(a.content?.[0]?.text?.length > 0)
  assert.ok(b.content?.[0]?.text?.length > 0)
  console.log('concurrent calls ok')

  const symbol = process.env.CODEMAP_TEST_SYMBOL
  if (symbol !== undefined) {
    const found = await first.callTool('find_symbol', { symbol_name: symbol })
    assert.ok(found.content?.[0]?.text?.includes(symbol), 'find_symbol must report the symbol')
    console.log('find_symbol:', found.content[0].text.split('\n')[0])
  } else {
    console.log('find_symbol check skipped: set CODEMAP_TEST_SYMBOL to a symbol in that repository')
  }

  const second = process.env.CODEMAP_TEST_REPO_2
  if (second !== undefined) {
    const other = await broker.acquire(second, AbortSignal.timeout(120_000))
    assert.notEqual(other, first, 'different repositories must not share a client')
    const otherStats = await other.callTool('get_graph_stats', {})
    assert.ok(otherStats.content?.[0]?.text?.length > 0)
    console.log('second repository got its own client')
  }

  // Cancellation must reject promptly with an AbortError.
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    first.callTool('get_graph_stats', {}, controller.signal),
    error => error.name === 'AbortError',
  )
  console.log('abort ok')

  // Unknown symbols resolve with an explanatory answer instead of hanging.
  const missing = await first.callTool('find_symbol', { symbol_name: '__definitely_missing_symbol__' })
  assert.equal(typeof missing.content?.[0]?.text, 'string')
  console.log('unknown symbol ok:', missing.content[0].text.slice(0, 120))
} finally {
  broker.dispose()
}
console.log('ALL BROKER TESTS PASSED')
