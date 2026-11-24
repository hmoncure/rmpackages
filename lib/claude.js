// Reads an order / shipping screenshot with Claude and returns the package details.
// Key + workspace come from .env (shared with the inventory app at Houston's say-so).
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

function headers() {
  const h = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) h['anthropic-workspace-id'] = process.env.ANTHROPIC_WORKSPACE_ID;
  return h;
}

const enabled = () => !!process.env.ANTHROPIC_API_KEY;

function prompt(today) {
  return `This is a screenshot of an online order, shipping confirmation or tracking page.
Today is ${today} (US Eastern). The office address is 726 N Washington St, Alexandria, VA 22314.

Extract every SHIPMENT / package shown. Return ONLY a JSON object, no prose:
{"packages":[{
  "description": "short: what it is, e.g. 'Carbon brushes for Hitachi sander (2)'",
  "vendor": "store or seller, e.g. Amazon, Home Depot",
  "carrier": "UPS / FedEx / USPS / DHL / Amazon if shown, else null",
  "tracking": "tracking number exactly as shown (Amazon's start with TBA), else null",
  "order_number": "order number exactly as shown, else null",
  "expected_date": "YYYY-MM-DD. Resolve 'Arriving Friday', 'tomorrow', 'Dec 4 - Dec 28' against today; for a range use the LAST day; null if none",
  "label_name": "recipient name on the order, else null",
  "ship_to": "the ship-to address as shown, else null",
  "ship_to_office": true if the ship-to is the office address above (Amazon may show only 'ALEXANDRIA, VA'), false if it is clearly elsewhere, null if not shown,
  "status": "ordered | shipped | out_for_delivery | delivered | delayed | null"
}],
"note": "anything the person should double-check, else null"}
If the image is not an order or shipment, return {"packages":[],"note":"why"}.
Never invent a tracking or order number — use null when it is not visible.`;
}

async function readScreenshot(buf, mediaType, today) {
  // Local tests only: a canned reply instead of calling the API (never set in production).
  if (process.env.CLAUDE_MOCK_JSON && process.env.NODE_ENV !== 'production') {
    return JSON.parse(require('fs').readFileSync(process.env.CLAUDE_MOCK_JSON, 'utf8'));
  }
  if (!enabled())throw Object.assign(new Error('Screenshot reading is not set up.'), { status: 503 });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          { type: 'text', text: prompt(today) },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('[claude] extract failed', r.status, data && data.error && data.error.message);
    throw Object.assign(new Error('Could not read the screenshot right now. Fill it in by hand.'), { status: 502 });
  }
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const m = /\{[\s\S]*\}/.exec(text);
  let out;
  try { out = JSON.parse(m ? m[0] : text); } catch {
    throw Object.assign(new Error('Could not understand the screenshot. Fill it in by hand.'), { status: 422 });
  }
  return { packages: Array.isArray(out.packages) ? out.packages.slice(0, 10) : [], note: out.note || null, usage: data.usage };
}

module.exports = { readScreenshot, enabled };
