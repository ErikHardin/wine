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
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   ALLOWED_ORIGIN     — your app domain e.g. https://ech-technicalsolutions.com
 */

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL      = "claude-sonnet-5";

export default {
  async fetch(request, env) {

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
- Each note: the publication as "source", the individual critic's name as "critic" if known (else null), the 100-point score as an integer (else null), a faithful excerpt or close summary of the review in 40 words or less as "note", and the URL of the page you found it on as "url" (else null).
- Prefer reviews of the exact vintage${vintage ? ` (${vintage})` : ""}. If a found review is for a different vintage of the same wine, you may include it but set "vintageMatch" to false.
- Up to 3 notes from distinct publications.
- If you cannot find any genuine published review, return {"found": false, "criticNotes": []}.

After searching, respond ONLY with valid JSON, no markdown, no commentary:
{"found": true, "criticNotes": [{"source": "Wine Spectator", "critic": "name or null", "score": 93, "note": "...", "url": "https://...", "vintageMatch": true}]}`;

        const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }];
        const messages = [{ role: "user", content: prompt }];

        let response = await callClaude(env.ANTHROPIC_API_KEY, {
          model: MODEL, max_tokens: 4000, tools, messages,
        });
        // The server-side search loop may pause; continue until it finishes.
        for (let i = 0; i < 3 && response.stop_reason === "pause_turn"; i++) {
          messages.push({ role: "assistant", content: response.content });
          response = await callClaude(env.ANTHROPIC_API_KEY, {
            model: MODEL, max_tokens: 4000, tools, messages,
          });
        }

        // The final JSON is in the last text block (earlier ones interleave with searches).
        const textBlocks = (response.content || []).filter(b => b.type === "text");
        const text   = textBlocks.length ? textBlocks[textBlocks.length - 1].text : "{}";
        const parsed = safeParseJSON(text);

        const notes = (Array.isArray(parsed.criticNotes) ? parsed.criticNotes : [])
          .map(n => ({
            source:       String(n.source ?? "").trim(),
            critic:       n.critic ? String(n.critic).trim() : null,
            score:        Number.isFinite(+n.score) && +n.score >= 50 && +n.score <= 100 ? Math.round(+n.score) : null,
            note:         String(n.note ?? "").trim(),
            url:          typeof n.url === "string" && /^https?:\/\//.test(n.url) ? n.url : null,
            vintageMatch: n.vintageMatch !== false,
            criticSource: "web",
          }))
          .filter(n => n.source && n.note)
          .slice(0, 3);

        if (!notes.length) {
          return jsonResponse({ criticNotes: [], criticSource: "none", found: false }, corsHeaders);
        }
        return jsonResponse({ criticNotes: notes, criticSource: "web", found: true }, corsHeaders);
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error("Worker error:", err);
      return jsonError("Internal error: " + err.message, 500, corsHeaders);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────

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
