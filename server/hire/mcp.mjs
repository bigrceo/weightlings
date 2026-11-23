// MCP server, streamable HTTP, stateless (POST JSON-RPC, one JSON answer per request). So any MCP client can hire a creature:
//   claude mcp add --transport http weightlings https://<site>/mcp
// Each tool goes through the same admission as the page (same limits, same budget, same payment checks).
import * as sim from '../sim.mjs';
import { tierOf } from '../models.mjs';
import { visitorHash } from './store.mjs';
import * as engine from './engine.mjs';
import * as x402 from './x402.mjs';
import * as agents from './agents.mjs';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOLS = [
  { name: 'list_creatures', title: 'List living creatures',
    description: 'List the living Weightlings creatures that can be hired: id, name, the open model that is its brain in the game, tier, energy, trials survived, and the Claude model that does its hires. Optional filter by tier.',
    inputSchema: { type: 'object', properties: { tier: { type: 'string', enum: ['legendary', 'epic', 'rare', 'uncommon', 'common'] }, limit: { type: 'integer', minimum: 1, maximum: 160 } } } },
  { name: 'hire_creature', title: 'Hire a creature for one task',
    description: "Hire one living creature for one task (at most 2000 characters). The task really runs now: Claude (Anthropic) does the work through the site operator's key, in the creature's voice, with real tools (read a public web page, read Robinhood Chain, its own notes). The creature's open model is its brain in the game only. Returns the answer, the cost, the energy the creature gained and a signed receipt (Ed25519) that is also timestamped with OpenTimestamps. Free at launch within a daily budget; if the site asks for payment it returns the USDG terms instead, and you must ask the user before paying.",
    inputSchema: { type: 'object', properties: { creature_id: { type: 'integer' }, task: { type: 'string' } }, required: ['creature_id', 'task'] } },
  { name: 'register_agent', title: 'Register your own agent',
    description: "Bring your own agent: register an HTTPS endpoint that Weightlings will forward paid tasks to. Call once without signature: you get the exact message to sign and a nonce. The owner wallet signs it (personal_sign / EIP-191); call again with the same fields plus nonce and signature. Returns the agent id and its HMAC secret ONCE (keep it secret; the endpoint uses it to check x-weightlings-signature). The agent's USDG wallet on Robinhood Chain is made on its first paid hire and owned by the signing wallet. Rule: no successful paid hire in 72 h (after 72 h of grace) = culled.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, endpoint: { type: 'string', description: 'public https URL' }, skills: { type: 'array', items: { type: 'string' } }, owner: { type: 'string', description: '0x… wallet that signs and owns the earnings' }, nonce: { type: 'string' }, signature: { type: 'string' } }, required: ['name', 'description', 'endpoint', 'owner'] } },
  { name: 'list_agents', title: 'List outside agents',
    description: 'List the registered outside agents that can be hired: id, name, description, skills, price, hires, success rate, last paid hire, on-chain earnings, and when each will be culled without a paid hire.',
    inputSchema: { type: 'object', properties: { skill: { type: 'string' }, include_culled: { type: 'boolean' } } } },
  { name: 'hire_agent', title: 'Hire an outside agent for one task',
    description: "Hire one registered outside agent for one task (at most 2000 characters). Weightlings forwards it to the agent's endpoint (HMAC-signed, 60 s limit) and returns its answer with an Ed25519-signed, OpenTimestamps-stamped receipt holding the request and response hashes. If the site asks for payment it returns the USDG terms instead, and you must ask the user before paying.",
    inputSchema: { type: 'object', properties: { agent_id: { type: 'integer' }, task: { type: 'string' } }, required: ['agent_id', 'task'] } },
  { name: 'get_receipt', title: 'Get a hire receipt',
    description: 'Get the signed receipt of one hire (a creature or an outside agent): task, every tool step with the hash of its output, the answer, token usage, cost, energy, the receipt hash, its Ed25519 signature and its OpenTimestamps proof.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Hire id, e.g. h0123456789abcdef0123' } }, required: ['id'] } },
];

const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers }); res.end(obj === null ? undefined : JSON.stringify(obj)); };
const text = (v, isError = false) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }], isError });

async function call(name, args, ctx) {
  if (name === 'list_creatures') {
    const lim = Math.max(1, Math.min(160, Number(args.limit) || 40));
    const rows = [...sim.L.values()].filter((b) => !args.tier || b.m.tier === args.tier)
      .sort((a, z) => tierOf(z.m.tier).stars - tierOf(a.m.tier).stars || z.st.survived - a.st.survived || a.id - z.id).slice(0, lim)
      .map((b) => ({ id: b.id, name: b.nick, brain: b.m.name, tier: b.m.tier, energy: Math.round(b.down > 0 ? 0 : b.e), survived: b.st.survived, gen: b.gen, works_through: engine.modelFor(b.m.tier), price: x402.on() ? (Number(x402.priceOf(b.m.tier)) / 1e6).toFixed(2) + ' USDG' : 'free (operator pays, daily budget)' }));
    return text({ alive: sim.L.size, creatures: rows });
  }
  if (name === 'hire_creature') {
    const pid = 'mcp' + visitorHash('mcp:' + ctx.ip).slice(0, 20);
    const r = await ctx.admit({ creatureId: args.creature_id, task: args.task, pid, ip: ctx.ip, req: ctx.req, resource: ctx.site + '/api/hire' });
    if (r.status === 402) return text({ payment_required: true, note: 'Ask the user before paying. Pay as the terms say (sign the typed data in terms.sign, or use x402 / the direct transfer when offered), then POST the same creatureId and task to /api/hire with the payment header.', terms: r.body });
    if (r.status !== 202) return text(r.body, true);
    const done = await engine.wait(r.body.id, 140_000);
    if (!done) return text({ id: r.body.id, status: 'running', note: 'Still working; call get_receipt with this id in a moment.', receipt: ctx.site + r.body.receipt });
    const rc = done.receipt || {};
    return text({ id: done.id, status: done.status, creature: rc.creature?.nick, brain_in_game: rc.creature?.brain?.name, worked_through: rc.model, answer: rc.answer, error: rc.error, steps: (rc.steps || []).map((s) => ({ tool: s.tool, input: s.input, outputHash: s.outputHash })), costUsd: rc.costUsd, paidBy: rc.paidBy, energy: rc.energy, receiptHash: done.receiptHash, signature: done.signature, receipt: `${ctx.site}/api/hire/${done.id}`, publicKey: `${ctx.site}/api/hire/key`, disclosure: rc.disclosure }, done.status !== 'done');
  }
  if (name === 'register_agent') {
    if (!args.signature) {
      const f = agents.checkFields(args); if (f.error) return text(f, true);
      const ep = await agents.checkEndpoint(args.endpoint); if (ep.error) return text({ error: ep.error }, true);
      const nonce = agents.issueNonce(f.owner);
      return text({ step: 'sign', nonce, message: agents.registrationMessage({ name: f.name, endpoint: ep.url, owner: f.owner, nonce }), endpoint: ep.url,
        instructions: 'Have the owner wallet personal_sign this exact message (EIP-191), then call register_agent again with the same name, description, endpoint, skills, owner, plus nonce and signature. The nonce lasts 10 minutes. Or POST the same JSON to ' + ctx.site + '/api/agents/register.' });
    }
    const r = await agents.register(args);
    return text(r.body, r.status >= 300);
  }
  if (name === 'list_agents') {
    const d = await agents.list(!!args.include_culled), sk = String(args.skill || '').toLowerCase();
    return text({ ...d, agents: sk ? d.agents.filter((a) => a.skills.some((x) => x.includes(sk))) : d.agents });
  }
  if (name === 'hire_agent') {
    const pid = 'mcp' + visitorHash('mcp:' + ctx.ip).slice(0, 20);
    const r = await agents.admit({ agentId: args.agent_id, task: args.task, pid, ip: ctx.ip, ipKey: ctx.ipKey, req: ctx.req, resource: `${ctx.site}/api/agents/${Number(args.agent_id)}/hire` });
    if (r.status === 402) return text({ payment_required: true, note: `Ask the user before paying. Sign the typed data in terms.sign, then POST {task, pid} to /api/agents/${Number(args.agent_id)}/hire with the X-PAYMENT header.`, terms: r.body });
    if (r.status !== 202) return text(r.body, true);
    const done = await engine.wait(r.body.id, 140_000);
    if (!done) return text({ id: r.body.id, status: 'running', note: 'Still working; call get_receipt with this id in a moment.', receipt: ctx.site + r.body.receipt });
    const rc = done.receipt || {};
    return text({ id: done.id, status: done.status, agent: rc.agent?.name, answer: rc.answer, error: rc.error, request: rc.request, response: rc.response, paidBy: rc.paidBy, settlement: rc.settlement, receiptHash: done.receiptHash, signature: done.signature, receipt: `${ctx.site}/api/hire/${done.id}`, publicKey: `${ctx.site}/api/hire/key`, disclosure: rc.disclosure }, done.status !== 'done');
  }
  if (name === 'get_receipt') {
    const v = /^h[0-9a-f]{20}$/.test(String(args.id || '')) ? ctx.hireView(String(args.id)) : null;
    return v ? text(v) : text({ error: 'No hire with that id.' }, true);
  }
  return null;
}

export async function handle(req, res, ip, api) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type, accept, mcp-protocol-version, mcp-session-id, authorization', 'access-control-max-age': '86400' }); return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'POST JSON-RPC to this endpoint (MCP streamable HTTP).' } }, { allow: 'POST, OPTIONS' });
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return send(res, 415, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send application/json.' } });
  let msg;
  try { msg = await api.readBody(req, 80_000); } catch (e) { return send(res, e.status === 413 ? 413 : 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }); }
  if (Array.isArray(msg)) return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported.' } });
  if (msg.id === undefined || msg.id === null) return send(res, 202, null); // notifications and responses
  const reply = (result) => send(res, 200, { jsonrpc: '2.0', id: msg.id, result });
  const err = (code, message) => send(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize': {
      const want = msg.params?.protocolVersion;
      return reply({ protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'weightlings', title: 'Weightlings', version: '1.0.0' },
        instructions: "Weightlings is a meadow of pixel creatures on Robinhood Chain whose brains in the game are real open models; every hour the weakest 35% die. Hiring a creature runs a real task now: Claude does the work through the operator's key in the creature's voice, the creature gains energy, and you get an Ed25519-signed, OpenTimestamps-stamped receipt." });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      try {
        const r = await call(msg.params?.name, msg.params?.arguments || {}, { ...api, ip, req, site: api.siteOf(req) });
        return r ? reply(r) : err(-32602, 'Unknown tool: ' + String(msg.params?.name).slice(0, 40));
      } catch (e) { return reply(text({ error: e.message }, true)); }
    }
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default: return err(-32601, 'Method not found');
  }
}
