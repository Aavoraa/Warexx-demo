// Claude Vision for the demo: the one real server call behind it.
//
//   GET  /api/vision  → { enabled, model }          (is Vision on for this demo?)
//   POST /api/vision  { kind, files: [{ name, type, data }] }  (data = base64)
//                     → { ok, data, provider, notes }
//     kind "invoice" (default): a supplier's bill → the canonical invoice JSON
//     kind "po": a photographed purchase order → the draft order (po_extract.py)
//
// The visitor's invoice upload is caught by the demo's service worker
// (frontend/demo/public/sw.js), which sends the file here and shows what comes
// back in the real invoice-review screen. The prompt and schema are the ones the
// WAREXX backend uses (app/extraction/claude_vision.py), so the demo reads a bill
// the way the product does.
//
// Vercel settings (Project → Settings → Environment Variables):
//   ANTHROPIC_API_KEY     required — Vision is off without it
//   VISION_MODEL          optional, default claude-opus-5-5
//   VISION_PER_HOUR       optional, uploads per visitor per hour (default 6)
import Anthropic from '@anthropic-ai/sdk'

const MODEL = process.env.VISION_MODEL || 'claude-opus-5-5'
const PER_HOUR = Number(process.env.VISION_PER_HOUR || 6)
// Vercel accepts a request body up to 4.5 MB; base64 is 4/3 of the file
const MAX_BYTES = 3 * 1024 * 1024
const MAX_FILES = 4
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])

const FULL_SCHEMA = {
  document_type: 'purchase_invoice',
  supplier: {
    name: null, legal_name: null, gstin: null, pan: null, cin: null,
    state: null, state_code: null, address: null, phone: null, email: null,
    manufacturer: null,
    bank: { name: null, account_no: null, ifsc: null, branch: null },
  },
  buyer: { name: null, gstin: null, pan: null, state: null, state_code: null, address: null },
  invoice: {
    number: null, date: null, due_date: null, challan_no: null,
    order_no: null, order_date: null, reference_no: null,
    irn: null, ack_no: null, irn_date: null, eway_bill: null,
    lr_no: null, lr_date: null, transporter: null, destination: null,
    delivery_note: null, delivery_note_date: null, tran_id: null,
    book_city: null, broker: null, terms: null, agent: null,
  },
  line_items: [
    { sr: 1, barcode: null, description: null, brand: null, design: null,
      size: null, hsn: null, qty: null, uom: null, mrp: null, rate: null,
      discount_pct: 0, discount_amount: 0, taxable_value: null, amount: null },
  ],
  taxes: {
    cgst_rate: 0, cgst_amount: 0, sgst_rate: 0, sgst_amount: 0,
    igst_rate: 0, igst_amount: 0, tds_amount: 0,
    other_charges: 0, freight: 0, special_discount: 0, round_off: 0,
  },
  totals: { total_qty: null, sub_total: null, taxable_total: null,
    tax_total: null, grand_total: null, amount_in_words: null },
  meta: { grn_no: null, grn_date: null, received_by: null, notes: null, hsn_summary: [] },
}

const SYSTEM = `You are an expert accounts-payable data-entry assistant for an Indian
garment distributor. You read a supplier's purchase/tax invoice (often a phone
photo, skewed, with handwritten notes) and return ONE JSON object matching the
provided canonical schema. Capture the ENTIRE invoice — do not skip fields.

Capture ALL of the following when present anywhere on the page (header, footer,
stamps, or handwriting):
- Supplier block: name, legal/trading name, GSTIN, PAN, CIN, full address, phone,
  email, manufacturer/MFG-by, and the BANK details (bank name, account number,
  IFSC, branch).
- Invoice block: invoice number, date, due date, challan/DC number, order number
  & date, reference number, IRN + ACK number + IRN date (e-invoices), e-way bill
  number, LR number & date, transporter/courier, destination, delivery note,
  transport/EWB tran-id, broker, payment terms, agent.
- EVERY line item with: serial no, barcode, description, brand, design, size, HSN,
  qty, unit (UOM), MRP, rate, discount, taxable value, line amount.
  MRP, rate and discount are PER PIECE; taxable value and line amount are line
  totals. \`discount_amount\` is the per-piece discount (MRP − rate) — if the bill
  prints a discount for the whole line, divide it by the quantity. Where the bill
  states no discount at all, leave both discount fields null rather than working
  one out from the MRP.
- Taxes: CGST/SGST rates+amounts OR IGST rate+amount, TDS (even handwritten),
  other charges, freight, special discount, round off.
- Totals: total quantity, sub total, taxable total, tax total, grand total, and
  the amount-in-words text.
- Meta: handwritten GRN number & date, "received by" name, and any other notes.

Rules: Use CGST+SGST when supplier and buyer GSTINs start with the same 2 digits
(same state), otherwise IGST. Dates in ISO YYYY-MM-DD. Numbers as numbers, not
strings. Do not invent data; use null for anything genuinely absent. Return ONLY
the JSON object, no prose.

LANGUAGE
This page may be written in Tamil — printed, handwritten, or a mix of Tamil and
English. Read it in whatever language it is written and RETURN EVERY TEXT VALUE
IN ENGLISH. Translate the WORDS ONLY. Numbers, amounts, quantities, dates,
invoice numbers, LR/docket numbers, GSTIN, HSN and any other code must come
through EXACTLY as printed or written. Whenever you translate a value, add an
"original_values" key to the object that value belongs to, mapping the field
name to the text exactly as it appears on the page.

If the document is not an invoice, bill, challan or similar purchase document,
return {"not_an_invoice": true, "what_it_is": "<a few words>"} instead.`

// app/services/po_extract.py, PO_PROMPT — a purchase order is our own request
// to a supplier: no tax block, no supplier profile; one call, one shape back
const PO_PROMPT = `You are reading an Indian garment wholesaler's PURCHASE ORDER —
the document the BUYER issues to a supplier saying what they want. It may be a
printed order, a letterhead form filled in by hand, or a photograph of a page
from an order book.

Return a JSON object with these keys (use null for anything the page does not
show — do NOT invent a value):
- po_no (the order number printed on the page, if any)
- po_date (ISO YYYY-MM-DD)
- supplier_name (who the order is ADDRESSED TO — the seller)
- company (the buying firm issuing the order, usually on the letterhead)
- brand
- item (the general description of the goods ordered)
- place (delivery place / destination, if named)
- transport (transporter or delivery mode, if named)
- agent (selling / commission agent, if named)
- purchaser (the buyer or purchase manager who raised it)
- discount_pct (a percentage discount stated for the whole order, as a number)
- lines: an array, ONE OBJECT PER ROW of the order's item table, each with:
    - particulars (the description column, verbatim)
    - size (the size or size mix exactly as written, e.g. "30:2, 32:4, 34:4")
    - qty (a number)
    - uom (PCS, DOZ, MTR, SET …)
    - rate (price per unit, a number)
    - amount (the row total as PRINTED — do not compute it if it is not there)
    - brand, design_no, hsn (if the table has those columns)

IMPORTANT:
- The supplier is who the order is sent TO. The company is who sent it. Getting
  these the wrong way round is the single most common error on this document.
- Transcribe EVERY row of the item table.
- Numbers as numbers, with no currency symbols, commas or units.
- An order carries no tax block and usually no grand total. Do not invent one.

LANGUAGE
The page may be written in Tamil. Read it in whatever language it is written and
return every text value in English; numbers, dates and codes exactly as written.
Whenever you translate a value, add an "original_values" key to the object it
belongs to, mapping the field name to the text as it appears on the page.

If the page is not a purchase order or similar order form, return
{"not_an_order": true, "what_it_is": "<a few words>"} instead.

Return ONLY the JSON object.`

// Uploads per visitor per hour, per running instance — a brake on a public demo
// spending the key, not an exact quota.
const seen = new Map()
function allowed(ip) {
  const now = Date.now(), hour = 3600_000
  const list = (seen.get(ip) || []).filter((t) => now - t < hour)
  if (list.length >= PER_HOUR) { seen.set(ip, list); return false }
  list.push(now); seen.set(ip, list)
  if (seen.size > 5000) seen.clear()
  return true
}

function parseJson(text) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?/, '').replace(/```\s*$/, '')
  try { return JSON.parse(t) } catch { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch { /* fall through */ } }
  return null
}

const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  const chunks = []
  for await (const c of req) chunks.push(c)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

export default async function handler(req, res) {
  const enabled = !!process.env.ANTHROPIC_API_KEY
  if (req.method === 'GET') return send(res, 200, { enabled, model: enabled ? MODEL : null })
  if (req.method !== 'POST') return send(res, 405, { ok: false, message: 'Use POST' })
  if (!enabled) return send(res, 503, { ok: false, message: 'Vision is not switched on for this demo.' })
  // the demo's own pages only (the service worker sends this header)
  if (req.headers['x-warexx-demo'] !== '1') return send(res, 403, { ok: false, message: 'Not allowed' })

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown'
  if (!allowed(ip)) {
    return send(res, 429, { ok: false, message: `The demo reads up to ${PER_HOUR} invoices an hour per visitor. Please try again later.` })
  }

  let body
  try { body = await readBody(req) } catch { return send(res, 400, { ok: false, message: 'Could not read the upload' }) }
  const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : []
  if (!files.length) return send(res, 400, { ok: false, message: 'No file was uploaded' })
  let total = 0
  for (const f of files) {
    if (!TYPES.has(f.type)) return send(res, 415, { ok: false, message: 'Upload a photo (JPG, PNG, WebP) or a PDF of the invoice.' })
    if (typeof f.data !== 'string') return send(res, 400, { ok: false, message: 'Could not read the upload' })
    total += Math.floor(f.data.length * 3 / 4)
  }
  if (total > MAX_BYTES) return send(res, 413, { ok: false, message: 'That file is too large for the demo (3 MB at most).' })

  const kind = body.kind === 'po' ? 'po' : 'invoice'
  const n = files.length
  let guidance = `Canonical schema to fill:\n${JSON.stringify(FULL_SCHEMA, null, 2)}`
  if (n > 1) {
    guidance += `\n\nThis is ONE invoice photographed as ${n} pages, in order. Return ONE invoice, not one per page: ` +
      'line_items is every row from every page in printed order; read the repeated header once; ' +
      'take totals, tax lines and amount in words from the last page; a row continued across the page break is one row.'
  }
  const content = []
  files.forEach((f, i) => {
    if (n > 1) content.push({ type: 'text', text: `--- page ${i + 1} of ${n} ---` })
    content.push(f.type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.type, data: f.data } })
  })
  content.push({ type: 'text', text: kind === 'po' ? PO_PROMPT : guidance + '\n\nReturn the JSON now.' })

  const client = new Anthropic()
  let msg
  try {
    // streamed: the reply (thinking + a long invoice's JSON) can run past the
    // SDK's non-streaming timeout; finalMessage() is the same object create() returns
    msg = await client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      ...(kind === 'po' ? {} : { system: SYSTEM }),
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages: [{ role: 'user', content }],
    }).finalMessage()
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { ok: false, message: 'Vision is busy right now — please try again in a minute.' })
    if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { ok: false, message: 'Vision is not set up correctly for this demo.' })
    if (e instanceof Anthropic.BadRequestError) return send(res, 422, { ok: false, message: 'Vision could not read that file. Try a clearer photo or a PDF.' })
    if (e instanceof Anthropic.APIError) return send(res, 502, { ok: false, message: 'Vision is unavailable right now — please try again.' })
    return send(res, 502, { ok: false, message: 'Vision is unavailable right now — please try again.' })
  }
  if (msg.stop_reason === 'refusal') return send(res, 422, { ok: false, message: 'Vision declined to read that file.' })

  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const data = parseJson(text)
  if (!data) {
    return send(res, 422, { ok: false, message: msg.stop_reason === 'max_tokens'
      ? 'That invoice is too long for one reading.' : 'Vision could not make sense of that file.' })
  }
  if (data.not_an_order) {
    return send(res, 422, { ok: false, message: `That does not look like a purchase order${data.what_it_is ? ` (it looks like ${data.what_it_is})` : ''}.` })
  }
  if (data.not_an_invoice) {
    return send(res, 422, { ok: false, message: `That does not look like an invoice${data.what_it_is ? ` (it looks like ${data.what_it_is})` : ''}. Upload a supplier's bill.` })
  }
  return send(res, 200, { ok: true, provider: 'claude_vision', model: msg.model, data, notes: ['vision extraction'] })
}
