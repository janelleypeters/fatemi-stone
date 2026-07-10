// /api/claude.js
// Vercel serverless function. Deploy this at the repo root under /api/claude.js
// (Vercel auto-detects anything in /api as a serverless route -> /api/claude).
//
// Set an environment variable in the Vercel project settings:
//   ANTHROPIC_API_KEY = sk-ant-...
// (Project Settings -> Environment Variables. Never put the key in the HTML/JS.)
//
// This function accepts the same shape the frontend already builds
// (messages, tools, system, stream, max_tokens) and forwards it to
// Anthropic with the key attached server-side. The model is fixed here
// so the client can't override it.

const MODEL = 'claude-sonnet-4-6';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server misconfigured: ANTHROPIC_API_KEY is not set' });
    return;
  }

  const { messages, tools, system, stream, max_tokens } = req.body || {};
  if (!messages) {
    res.status(400).json({ error: 'messages is required' });
    return;
  }

  const anthropicBody = {
    model: MODEL,
    max_tokens: max_tokens || 4096,
    system,
    messages,
  };
  if (tools) anthropicBody.tools = tools;
  if (stream) anthropicBody.stream = true;

  // If the client disconnects (user hit Stop, or closed the tab), stop
  // the upstream request too instead of burning tokens for nothing.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let anthropicRes;
  try {
    anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') return; // client already gone
    res.status(502).json({ error: `Upstream request failed: ${err.message}` });
    return;
  }

  // Non-streaming: just relay the JSON.
  if (!stream) {
    const data = await anthropicRes.json();
    res.status(anthropicRes.status).json(data);
    return;
  }

  // Streaming: relay Server-Sent Events as they arrive.
  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    res.status(anthropicRes.status).json({ error: errText });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const reader = anthropicRes.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (err) {
    // Client likely disconnected mid-stream; nothing more to do.
  } finally {
    res.end();
  }
}

// Vercel Hobby-plan serverless functions time out at 10s by default (60s on Pro).
// The search stage in this app can run longer than that while it does web
// lookups. If you're on Hobby, either upgrade to Pro or add a
// vercel.json with a longer maxDuration, e.g.:
//
// { "functions": { "api/claude.js": { "maxDuration": 60 } } }
