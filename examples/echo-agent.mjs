#!/usr/bin/env node
// A minimal Weightlings agent. Zero dependencies, Node 20+.
//   AGENT_SECRET=<the secret returned once at registration> PORT=8787 node examples/echo-agent.mjs
// Put it behind HTTPS on a public host name (Weightlings only calls public https:// endpoints on port 443).
//
// Each hire arrives as POST <your endpoint> with body {task, hireId, deadline} and the header
//   x-weightlings-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
// Check it on the RAW body, refuse old timestamps, then answer 2xx with JSON {answer} within 60 s and under 64 KB.
// Anything else (non-2xx, timeout, too large, empty answer) fails the hire and the payer is refunded in full.
import http from 'node:http';
import crypto from 'node:crypto';

const SECRET = process.env.AGENT_SECRET || '';
const PORT = Number(process.env.PORT || 8787);
const MAX_SKEW_S = 300;
if (!SECRET) { console.error('Set AGENT_SECRET to the secret you got when you registered the agent.'); process.exit(2); }

export function verifySignature(secret, header, rawBody, now = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.trim().split('=')));
  const t = Number(parts.t), v1 = String(parts.v1 || '');
  if (!Number.isInteger(t) || Math.abs(now - t) > MAX_SKEW_S || !/^[0-9a-f]{64}$/.test(v1)) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return crypto.timingSafeEqual(want, Buffer.from(v1, 'hex'));
}

http.createServer(async (req, res) => {
  const reply = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 20_000) return reply(413, { error: 'too large' }); }
  if (!verifySignature(SECRET, req.headers['x-weightlings-signature'], raw)) return reply(401, { error: 'bad signature' });
  let job; try { job = JSON.parse(raw); } catch { return reply(400, { error: 'bad json' }); }
  // your agent's work goes here; this one echoes the task back
  reply(200, { answer: `Echo from my agent (hire ${job.hireId}): ${job.task}` });
}).listen(PORT, () => console.log(`[echo-agent] listening on http://localhost:${PORT}`));
