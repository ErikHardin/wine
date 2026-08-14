/**
 * ECH Wine Cellar — Cloudflare Worker
 * Handles five routes:
 *   POST /scan        — Claude Vision label scan (single bottle)
 *   POST /scan-multi  — Claude Vision label scan (multiple bottles)
 *   POST /enrich      — Claude AI wine data enrichment
 *   POST /pairings    — Claude AI food pairings + drink window
 *   POST /critics     — real critic reviews found via web search
 *
 * Environment variables (set in Cloudflare dashboard):
 *   ANTHROPIC_API_KEY   — your Anthropic API key
 *   ALLOWED_ORIGIN      — your app domain e.g. https://ech-technicalsolutions.com
 */

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL      = "claude-sonnet-5";
// Bump when changing behaviour worth identifying from /health.
const BUILD      = "critics-stream-3";

// /critics budget: a phone is waiting on the response, so bound how long the
// search may run before we force it to answer with what it has.
const MAX_SEARCH_ROUNDS   = 2;
// Measured against real wines: 54s / 126s / 155s / 160s to a good answer, and
// one that ran 588s. The budget has to clear the slowest wine that actually
// succeeds without waiting on the ones that never converge, so it sits above
// the observed successes and well below the runaway.
const SEARCH_BUDGET_MS    = 165000;
const FINALIZE_TIMEOUT_MS = 25000;

export default {
  async fetch(request, env, ctx) {

    // ── CORS ──────────────────────────────────────────────────────
    const origin  = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "https://ech-technicalsolutions.com";
    // Allow: matching domain, github.io subdomains, and null/empty origin (iOS PWA standalone mode)
    const corsOk  = !origin || origin === allowed || origin.endsWith("github.io");

    const corsHeaders = {
      "Access-Control-Allow-Origin":  corsOk ? (origin || allowed) : allowed,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Reports which build is live and whether each secret binding is visible,
    // so a misconfigured secret is diagnosable from outside. Booleans only —
    // no secret values are ever returned.
    if (new URL(request.url).pathname === "/health") {
      return jsonResponse({
        build: BUILD,
        model: MODEL,
        hasAnthropicKey:  !!env.ANTHROPIC_API_KEY,
      }, corsHeaders);
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Route: /scan ───────────────────────────────────────────
      if (path === "/scan") {
        const { image } = await request.json();
        if (!image) return jsonError("Missing image", 400, corsHeaders);

        const response = await callClaude(env.ANTHROPIC_API_KEY, {
          model: MODEL,
          max_tokens: 500,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: image },
              },
              {
                type: "text",
                text: `You are a wine label reader. Examine this wine bottle image and extract the label information.
Respond ONLY with valid JSON, no markdown, no explanation:
{
  "winery": "producer or winery name",
  "wine": "wine name or cuvée",
  "vintage": "4-digit year as string, or null",
  "varietal": "grape variety or null",
  "region": "region or appellation or null",
  "color": "Red or White or Rosé or Sparkling or null"
}
If this is not a wine bottle or label is unreadable, return: {"error": "not a wine bottle"}`,
              },
            ],
          }],
        });

        const text   = response.content?.find(b => b.type === "text")?.text || "{}";
        const parsed = safeParseJSON(text);
        return jsonResponse(parsed, corsHeaders);
      }

      // ── Route: /scan-multi ────────────────────────────────────
      if (path === "/scan-multi") {
        const { image } = await request.json();
        if (!image) return jsonError("Missing image", 400, corsHeaders);

        const response = await callClaude(env.ANTHROPIC_API_KEY, {
          model: MODEL,
          max_tokens: 1024,
          messages: [{
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: image },
              },
              {
                type: "text",
                text: `You are a wine label reader. Examine this photo and identify EVERY wine bottle that is visible.

For each bottle extract:
- winery: producer / winery name
- wine: wine name or cuvée
- vintage: 4-digit year as string, or null if not visible
- varietal: grape variety or blend, e.g. "Cabernet Sauvignon", "Rosé Blend", or null
- region: region or appellation, e.g. "Napa Valley", or null
- color: exactly one of "Red" | "White" | "Rosé" | "Sparkling" | "Dessert" | "Fortified"

Rules:
- Include every distinct bottle visible, even if partially obscured.
- Use null for any field not clearly readable on the label — never guess.
- Return ONLY valid JSON, no markdown, no explanation.

Format:
{"wines":[{"winery":"...","wine":"...","vintage":"2019","varietal":"...","region":"...","color":"Red"}]}

If no wine bottles are visible, return: {"wines":[]}`,
              },
            ],
          }],
        });

        const text   = response.content?.find(b => b.type === "text")?.text || '{"wines":[]}';
        const parsed = safeParseJSON(text);

        // Normalise: ensure wines is always an array, filter blank entries
        const VALID_COLORS = ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified"];
        const wines = (Array.isArray(parsed.wines) ? parsed.wines : [])
          .map(w => ({
            winery:   String(w.winery   ?? "").trim(),
            wine:     String(w.wine     ?? "").trim(),
            vintage:  w.vintage  ? String(w.vintage).trim()  : null,
            varietal: w.varietal ? String(w.varietal).trim() : null,
            region:   w.region   ? String(w.region).trim()   : null,
            color:    VALID_COLORS.includes(w.color) ? w.color : "Red",
          }))
          .filter(w => w.winery || w.wine);

        return jsonResponse({ wines }, corsHeaders);
      }

      // ── Route: /enrich ─────────────────────────────────────────
      if (path === "/enrich") {
        const { winery, wine, vintage } = await request.json();
        if (!wine) return jsonError("Missing wine name", 400, corsHeaders);

        const response = await callClaude(env.ANTHROPIC_API_KEY, {
          model: MODEL,
          max_tokens: 600,
          messages: [{
            role: "user",
            content: `You are a wine expert with deep knowledge of wines, vintages, critic scores, and pricing.
For the wine: "${[winery, wine, vintage].filter(Boolean).join(" ")}"

Provide your best knowledge about this wine. Respond ONLY with valid JSON, no markdown:
{
  "varietal": "primary grape variety",
  "region": "specific appellation or region",
  "color": "Red or White or Rosé or Sparkling",
  "score": 92,
  "avgPrice": 85,
  "drinkFrom": 2024,
  "drinkTo": 2032,
  "note": "one sentence about this wine or vintage (e.g. 'Excellent 2019 vintage for Napa Cabernet')"
}

Rules:
- score: typical critic score 85-100, or null if unknown
- avgPrice: typical retail price in USD as integer, or null if unknown
- drinkFrom/drinkTo: realistic drinking window years as integers, or null if unknown
- If you don't recognize the wine, return your best estimate based on varietal/region with note explaining
- Never return null for varietal, region, or color if you can infer from the name`,
          }],
        });

        const text   = response.content?.find(b => b.type === "text")?.text || "{}";
        const parsed = safeParseJSON(text);
        return jsonResponse(parsed, corsHeaders);
      }


      if (path === "/pairings") {
        const { winery, wine, vintage, varietal, region } = await request.json();
        if (!wine) return jsonError("Missing wine name", 400, corsHeaders);

        const wineDesc = [winery, wine, vintage].filter(Boolean).join(" ");
        const details  = [varietal, region].filter(Boolean).join(", ");

        const response = await callClaude(env.ANTHROPIC_API_KEY, {
          model: MODEL,
          max_tokens: 800,
          messages: [{
            role: "user",
            content: `You are an expert sommelier. For the wine "${wineDesc}"${details ? ` (${details})` : ""}, provide:
1. Exactly 5 specific food pairing suggestions (3-5 words each, specific dishes not just ingredients)
2. A prime drinking window description (1-2 sentences)
3. One serving tip (1 sentence, temperature and decanting)

Respond ONLY with valid JSON, no markdown:
{
  "pairings": ["pairing1","pairing2","pairing3","pairing4","pairing5"],
  "drinkWindow": "sentence about ideal drinking window",
  "servingTip": "sentence about how to serve"
}`,
          }],
        });

        const text   = response.content?.find(b => b.type === "text")?.text || "{}";
        const parsed = safeParseJSON(text);
        return jsonResponse(parsed, corsHeaders);
      }

      // ── Route: /critics ────────────────────────────────────────
      // Searches the web for real published critic reviews. Never invents
      // notes: if no genuine reviews are found it returns found:false.
      if (path === "/critics") {
        const { winery, wine, vintage, varietal, region } = await request.json();
        if (!wine) return jsonError("Missing wine name", 400, corsHeaders);


        const wineDesc = [winery, wine, vintage].filter(Boolean).join(" ");
        const details  = [varietal, region].filter(Boolean).join(", ");

        const prompt = `Search the web for professional critic reviews of the wine "${wineDesc}"${details ? ` (${details})` : ""}.

Look for scores and tasting notes from professional wine critics and publications — e.g. Wine Advocate / Robert Parker, Wine Spectator, Vinous, James Suckling, Decanter, Jancis Robinson, Wine Enthusiast. Retailer or aggregator pages that quote a named publication's score and review are acceptable sources; attribute the note to the original publication.

Strict rules:
- Report ONLY scores and review text you actually found in the search results. Never invent, estimate, or extrapolate a score or quote.
- Each note: the publication as "source", the individual critic's name as "critic" if known (else null), the score on the 100-point scale as an integer in "score" (else null), the score exactly as that critic published it in "scoreText" (e.g. "94", "17/20", "4.5/5") or null, a faithful excerpt or close summary of the review in 40 words or less as "note", and the URL of the page you found it on as "url" (else null).
- Never convert between scoring scales. If a critic rates out of 20 or 5, leave "score" null and put the published rating in "scoreText".
- Prefer reviews of the exact vintage${vintage ? ` (${vintage})` : ""}. If a found review is for a different vintage of the same wine, you may include it but set "vintageMatch" to false.
- Up to 3 notes from distinct publications.
- If you cannot find any genuine published review, return {"found": false, "criticNotes": []}.

After searching, respond ONLY with valid JSON, no markdown, no commentary:
{"found": true, "criticNotes": [{"source": "Wine Spectator", "critic": "name or null", "score": 93, "scoreText": "93", "note": "...", "url": "https://...", "vintageMatch": true}]}`;

        const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }];
        const messages = [{ role: "user", content: prompt }];

        const runSearch = async () => {
          let payload;
          try {
            // Each paused turn costs another full round trip, so cap both the
            // number of rounds and the wall-clock spent searching — a phone is
            // waiting on this.
            const startedAt = Date.now();
            // Overridable so the budget can be tuned, or shrunk under test,
            // without a redeploy.
            const searchBudget   = Number(env.SEARCH_BUDGET_MS)    || SEARCH_BUDGET_MS;
            const finalizeBudget = Number(env.FINALIZE_TIMEOUT_MS) || FINALIZE_TIMEOUT_MS;
            let response, rounds = 0, exhausted = false;
            const trace = [];

            for (;;) {
              const t0 = Date.now();
              // A round has to be cut off from the outside: the budget below
              // only applies between rounds, so without this one slow round
              // runs indefinitely and the app spins forever.
              const left = searchBudget - (Date.now() - startedAt);
              try {
                response = await callClaudeStreaming(env.ANTHROPIC_API_KEY, {
                  model: MODEL, max_tokens: 4000, tools, messages,
                }, Math.max(left, 5000));
              } catch (e) {
                rounds++;
                trace.push({ round: rounds, ms: Date.now() - t0, error: String(e.message).slice(0, 80) });
                // With earlier rounds banked there is real search material to
                // finalize from. With none, there is nothing to summarise, and
                // asking anyway would invite an answer from memory rather than
                // from sources — so report the timeout and let the user retry
                // instead of recording a false "no reviews exist".
                if (rounds > 1) { exhausted = true; break; }
                const timedOut = e.name === "AbortError" || /abort/i.test(e.message || "");
                throw timedOut ? new Error("Search timed out before finding anything") : e;
              }
              rounds++;
              trace.push({ round: rounds, ms: Date.now() - t0, stop: response.stop_reason });
              if (response.stop_reason !== "pause_turn") break;
              messages.push({ role: "assistant", content: response.content });
              if (rounds >= MAX_SEARCH_ROUNDS || Date.now() - startedAt > searchBudget) {
                exhausted = true;
                break;
              }
            }

            // Out of budget mid-search: ask for the JSON with no tools attached
            // so it has to answer from what it already found instead of leaving
            // us with a paused turn and no result at all.
            if (exhausted) {
              messages.push({ role: "user", content: `Stop searching. Using only the reviews you have already found, respond now with the JSON described earlier. If you found none, return {"found": false, "criticNotes": []}.` });
              const t0 = Date.now();
              try {
                response = await callClaudeStreaming(env.ANTHROPIC_API_KEY, {
                  model: MODEL, max_tokens: 1500, messages,
                }, finalizeBudget);
                trace.push({ round: "finalize", ms: Date.now() - t0, stop: response.stop_reason });
              } catch (e) {
                trace.push({ round: "finalize", ms: Date.now() - t0, error: String(e.message).slice(0, 120) });
              }
            }

            // Cited answers get split across several text blocks, so the JSON
            // is often spread over more than one — parse across all of them.
            const texts  = (response.content || []).filter(b => b.type === "text").map(b => b.text || "");
            const parsed = extractCriticsJSON(texts);
            trace.push({ textBlocks: texts.length, chars: texts.join("").length, parsed: !parsed.error });

            const notes = (Array.isArray(parsed.criticNotes) ? parsed.criticNotes : [])
              .map(n => ({
                source:       String(n.source ?? "").trim(),
                critic:       n.critic ? String(n.critic).trim() : null,
                score:        Number.isFinite(+n.score) && +n.score >= 50 && +n.score <= 100 ? Math.round(+n.score) : null,
                // Critics on a 20- or 5-point scale would otherwise lose their
                // rating entirely to the 100-point check above.
                scoreText:    n.scoreText ? String(n.scoreText).trim().slice(0, 12) : null,
                note:         String(n.note ?? "").trim(),
                url:          typeof n.url === "string" && /^https?:\/\//.test(n.url) ? n.url : null,
                vintageMatch: n.vintageMatch !== false,
                criticSource: "web",
              }))
              .filter(n => n.source && n.note)
              .slice(0, 3);

            payload = notes.length
              ? { criticNotes: notes, criticSource: "web", found: true }
              // Nothing found is a legitimate answer, but it is also what a
              // budget overrun looks like — keep the trace so the two are
              // tellable apart from the outside. The client ignores it.
              : { criticNotes: [], criticSource: "none", found: false, trace };
          } catch (err) {
            console.error("Critics error:", err);
            payload = { error: "Internal error: " + err.message };
          }
          return payload;
        };

        // Hold the connection open, trickling whitespace
        // so neither iOS nor Cloudflare kills an idle request mid-search
        // (JSON.parse ignores the leading spaces).
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        const keepalive = setInterval(() => { writer.write(enc.encode(" ")).catch(() => {}); }, 15000);

        const work = (async () => {
          let payload;
          try { payload = await runSearch(); }
          finally { clearInterval(keepalive); }
          await writer.write(enc.encode(JSON.stringify(payload))).catch(() => {});
          await writer.close().catch(() => {});
        })();
        if (ctx?.waitUntil) ctx.waitUntil(work);

        return new Response(readable, {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error("Worker error:", err);
      return jsonError("Internal error: " + err.message, 500, corsHeaders);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────

// A web-search turn can take longer than the 100s Cloudflare allows a
// subrequest to sit silent, which comes back as a 524. Streaming keeps
// bytes flowing, so we consume the SSE events and rebuild the message.
async function callClaudeStreaming(apiKey, body, timeoutMs) {
  // Covers the whole read, not just the connect: the stream can keep trickling
  // tokens for minutes, and nothing else can stop it once it starts.
  const abort = new AbortController();
  const timer = timeoutMs ? setTimeout(() => abort.abort(), timeoutMs) : null;
  try {
    return await streamClaude(apiKey, body, abort.signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamClaude(apiKey, body, signal) {
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    signal,
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  const blocks      = [];
  const partialJSON = [];
  let stopReason = null;
  let buffer     = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let evt;
      try { evt = JSON.parse(raw); } catch { continue; }

      if (evt.type === "content_block_start") {
        blocks[evt.index]      = evt.content_block;
        partialJSON[evt.index] = "";
      } else if (evt.type === "content_block_delta") {
        const b = blocks[evt.index];
        if (!b) continue;
        const d = evt.delta || {};
        if      (d.type === "text_delta")       b.text     = (b.text     || "") + d.text;
        else if (d.type === "thinking_delta")   b.thinking = (b.thinking || "") + d.thinking;
        else if (d.type === "input_json_delta") partialJSON[evt.index] += d.partial_json || "";
        else if (d.type === "citations_delta" && d.citation) (b.citations ||= []).push(d.citation);
      } else if (evt.type === "content_block_stop") {
        const b = blocks[evt.index];
        if (b && partialJSON[evt.index]) {
          try { b.input = JSON.parse(partialJSON[evt.index]); } catch { /* keep what we have */ }
        }
      } else if (evt.type === "message_delta") {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      } else if (evt.type === "error") {
        throw new Error(`Claude API stream error: ${JSON.stringify(evt.error)}`);
      }
    }
  }

  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

async function callClaude(apiKey, body) {
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  return res.json();
}


// The reply may arrive as one clean JSON block, as JSON wrapped in prose, or —
// when the model cites its sources — split across several text blocks. Try the
// individual blocks newest-first, then the whole thing joined together, and
// accept the first candidate that actually looks like our result shape.
function extractCriticsJSON(texts) {
  if (!texts.length) return { error: "no text blocks" };
  const candidates = [...texts].reverse();
  candidates.push(texts.join(""));
  for (const candidate of candidates) {
    const parsed = safeParseJSON(candidate);
    if (Array.isArray(parsed.criticNotes) || typeof parsed.found === "boolean") return parsed;
  }
  return { error: "no result JSON found" };
}

function safeParseJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Fall back to the outermost {...} in case the model added prose around it
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
    }
    return { error: "Failed to parse response" };
  }
}

function jsonResponse(data, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function jsonError(message, status, corsHeaders) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
