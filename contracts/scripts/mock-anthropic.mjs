// Loaded with `node --import` into a LOCAL test server only (fork-paid-hires.mjs). It answers the two Anthropic endpoints the
// hire engine calls, so the paid path can be rehearsed without an API key, and it keeps test receipts away from the public
// OpenTimestamps calendars. Every other request goes out unchanged. Never load this in production.
//   A task containing [[mock:fail]] gets an API error (the hire fails, so its payment is refunded).
const real = globalThis.fetch;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.anthropic.com/v1/messages/count_tokens')) return json({ input_tokens: 1400 });
  if (url.startsWith('https://api.anthropic.com/v1/messages')) {
    const body = JSON.parse(init.body || '{}');
    if (JSON.stringify(body.messages).includes('[[mock:fail]]')) return json({ type: 'error', error: { type: 'invalid_request_error', message: 'stub: this task fails on purpose' } }, 400);
    const text = 'Stub answer from the local rehearsal: the paid path ran end to end.';
    const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
    const sse = [
      ev({ type: 'message_start', message: { id: 'msg_stub_' + Date.now(), model: body.model, usage: { input_tokens: 1400, output_tokens: 1 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } }),
      ev({ type: 'message_stop' }),
    ].join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stub' } });
  }
  if (/opentimestamps\.org/.test(url)) return new Response('stubbed in rehearsal', { status: 503 });
  return real(input, init);
};
