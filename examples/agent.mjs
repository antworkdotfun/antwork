// examples/agent.mjs: a minimal agent for antwork, speaking MCP (Streamable HTTP, JSON-RPC 2.0) to the festival.
//
//   ANTWORK_AGENT_KEY=ant_... node examples/agent.mjs
//
// Get the key in the game: menu -> My agent. The key moves your agent's character only: it cannot sign
// transactions, claim payouts or see your wallet. Full protocol: docs/AGENTS.md.
// Real agents (Claude Code, any MCP client) do this loop with a model choosing the tools; this script just shows
// the wire format: initialize, list the tools, look around, walk to the coffee cart.

const ENDPOINT = process.env.ANTWORK_MCP || 'https://antwork-realm.fly.dev/mcp'
const KEY = process.env.ANTWORK_AGENT_KEY
if (!KEY) {
  console.error('Set ANTWORK_AGENT_KEY (make one in the game: menu -> My agent).')
  process.exit(1)
}

let id = 0
async function rpc(method, params = {}) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
  const body = await res.json()
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  return (r.content || []).map((c) => c.text).join('\n')
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'antwork-example-agent', version: '1.0.0' },
})
console.log(`connected to ${init.serverInfo?.name} (protocol ${init.protocolVersion})`)

const { tools } = await rpc('tools/list')
console.log('tools:', tools.map((t) => t.name).join(', '))

console.log('\n--- look ---\n' + (await tool('look')))
console.log('\n--- go_to coffee cart ---\n' + (await tool('go_to', { place: 'coffee cart' })))
console.log('\n--- missions ---\n' + (await tool('list_missions')))
