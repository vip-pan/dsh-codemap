import assert from 'node:assert/strict'
import { apply } from '../index.js'

const registered = []
const disposers = []
let ensureCalls = 0

const ctx = {
  tools: { register(definition) { registered.push(definition); return () => {} } },
  effect(setup) { disposers.push(setup()) },
  workingDirectory: {
    async ensure(agent) {
      ensureCalls += 1
      assert.ok(agent, 'agent must be forwarded')
      return agent.cwd
    },
  },
}

apply(ctx)
assert.equal(registered.length, 9, 'all nine codemap tools must register')
const names = registered.map(tool => tool.name).sort()
assert.deepEqual(names, [
  'find_symbol', 'get_call_chain', 'get_dependencies', 'get_graph_stats',
  'get_symbol_detail', 'get_type_hierarchy', 'query_cypher', 'search_code', 'search_knowledge',
])
for (const tool of registered) {
  assert.equal(typeof tool.description, 'string')
  assert.equal(tool.parameters?.type, 'object', `${tool.name} parameters must be an object schema`)
  assert.equal(typeof tool.output?.render, 'function')
  assert.equal(typeof tool.execute, 'function')
}
console.log('registered:', names.join(', '))

// A call without an agent must fail clearly instead of guessing a repository.
const find = registered.find(tool => tool.name === 'find_symbol')
await assert.rejects(
  find.execute({ symbol_name: 'X' }, { signal: new AbortController().signal }),
  /needs an agent session/,
)
console.log('agent requirement ok')

// End-to-end through the plugin entry point needs a real indexed repository.
const repo = process.env.CODEMAP_TEST_REPO
if (repo === undefined) {
  await Promise.all(disposers.map(dispose => dispose?.()))
  console.log('SKIP execute tests: set CODEMAP_TEST_REPO (and optionally CODEMAP_TEST_SYMBOL)')
  process.exit(0)
}

const symbol = process.env.CODEMAP_TEST_SYMBOL
const result = await find.execute(
  symbol === undefined ? { symbol_name: 'main' } : { symbol_name: symbol },
  { agent: { cwd: repo }, signal: new AbortController().signal, arguments: {} },
)
assert.equal(typeof result.content?.[0]?.text, 'string')
assert.equal(ensureCalls, 1, 'the working directory must be resolved once')
const blocks = find.output.render({}, result)
assert.equal(blocks[0].type, 'text')
console.log('find_symbol render:', blocks[0].text.split('\n')[0], '| ensure calls:', ensureCalls)
console.log('execute test passed against', repo)
await Promise.all(disposers.map(dispose => dispose?.()))

console.log('ALL PLUGIN TESTS PASSED')
