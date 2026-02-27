/**
 * Forge — Cloudflare Worker Proxy for Anthropic API
 *
 * Deployment:
 *   1. Go to https://dash.cloudflare.com → Workers & Pages → Create
 *   2. Name it "forge-proxy" (or whatever you like)
 *   3. Paste this script into the editor
 *   4. Go to Settings → Variables and Secrets → Add:
 *        - ANTHROPIC_API_KEY = your sk-ant-... key (encrypt it)
 *   5. Deploy
 *   6. Update WORKER_URL in agents.js with your worker URL
 *
 * The worker:
 *   - Only accepts POST to /v1/messages
 *   - Only allows requests from your GitHub Pages origin
 *   - Injects your API key server-side
 *   - Forwards to api.anthropic.com and returns the response
 */

const ANTHROPIC_API = 'https://api.anthropic.com';

// Add your GitHub Pages origin here (and localhost for dev)
const ALLOWED_ORIGINS = [
  'https://tedfoley.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:8080',
];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, anthropic-version, anthropic-beta',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const isAllowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    const responseOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(responseOrigin) });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...corsHeaders(responseOrigin), 'Content-Type': 'application/json' },
      });
    }

    // Only allow /v1/messages
    const url = new URL(request.url);
    if (url.pathname !== '/v1/messages') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...corsHeaders(responseOrigin), 'Content-Type': 'application/json' },
      });
    }

    // Check origin
    if (!isAllowed) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { ...corsHeaders(responseOrigin), 'Content-Type': 'application/json' },
      });
    }

    // Check that the API key is configured
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: 'API key not configured on worker' }), {
        status: 500,
        headers: { ...corsHeaders(responseOrigin), 'Content-Type': 'application/json' },
      });
    }

    // Forward to Anthropic
    try {
      const body = await request.text();

      const forwardHeaders = {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': request.headers.get('anthropic-version') || '2023-06-01',
      };

      // Forward beta header if present (needed for web search tool)
      const betaHeader = request.headers.get('anthropic-beta');
      if (betaHeader) {
        forwardHeaders['anthropic-beta'] = betaHeader;
      }

      const anthropicResponse = await fetch(`${ANTHROPIC_API}/v1/messages`, {
        method: 'POST',
        headers: forwardHeaders,
        body: body,
      });

      const responseBody = await anthropicResponse.text();

      return new Response(responseBody, {
        status: anthropicResponse.status,
        headers: {
          ...corsHeaders(responseOrigin),
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
        status: 502,
        headers: { ...corsHeaders(responseOrigin), 'Content-Type': 'application/json' },
      });
    }
  },
};
