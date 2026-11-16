import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const KEEP = ['find_symbol','search_code','get_symbol_detail','get_call_chain','get_type_hierarchy','get_dependencies','get_graph_stats','query_cypher','search_knowledge']
const root = process.argv[2]
const bin = process.argv[3] ?? 'codemap'
const child = spawn(bin, ['serve', '-r', root], { stdio: ['pipe','pipe','pipe'] })
let buf = ''
const pending = new Map()
child.stdout.on('data', d => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i+1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
})
child.stderr.on('data', () => {})
const send = o => child.stdin.write(JSON.stringify(o) + '\n')
function rpc(method, params) {
  const id = Math.floor(Math.random()*1e9)
  return new Promise((res, rej) => {
    pending.set(id, res)
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)) } }, 30000)
    send({ jsonrpc: '2.0', id, method, params })
  })
}
await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-codemap-capture', version: '1.0.0' } })
send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
const res = await rpc('tools/list', {})
const tools = (res.result?.tools ?? []).filter(t => KEEP.includes(t.name))
const out = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
writeFileSync(new URL('../tools.json', import.meta.url), JSON.stringify(out, null, 2) + '\n')
console.log('captured', out.length, 'tools:', out.map(t => t.name).join(', '))
child.kill()
process.exit(0)
