/**
 * ECH Wine Cellar — Cloudflare Worker
 * Handles four routes:
 *   POST /scan        — Claude Vision label scan (single bottle)
 *   POST /scan-multi  — Claude Vision label scan (multiple bottles)
 *   POST /enrich      — Claude AI wine data enrichment
 *   POST /pairings    — Claude AI food pairings + drink window + critic notes
 *
 * Environment variables (set in Cloudflare dashboard):
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   ALLOWED_ORIGIN     — your app domain e.g. https://ech-technicalsolutions.com
 */

const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL      = "claude-sonnet-4-20250514";

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
          max_tokens: 1500,
          messages: [{
            role: "user",
            content: `You are an expert sommelier and wine critic. For the wine "${wineDesc}"${details ? ` (${details})` : ""}, provide:
1. Exactly 5 specific food pairing suggestions (3-5 words each, specific dishes not just ingredients)
2. A prime drinking window description (1-2 sentences)
3. One serving tip (1 sentence, temperature and decanting)
4. Exactly 3 critic-style tasting notes as they would appear in major wine publications. Each note 2-3 sentences in that publication's distinctive voice:
   - Wine Advocate: bold, analytical, fruit-forward, mentions structure and aging potential
   - Wine Spectator: accessible, balanced, food-friendly framing
   - Vinous: lyrical, terroir-focused, emphasizes texture and energy
   Scores within a 4-point range of each other (85-100).

Respond ONLY with valid JSON, no markdown:
{
  "pairings": ["pairing1","pairing2","pairing3","pairing4","pairing5"],
  "drinkWindow": "sentence about ideal drinking window",
  "servingTip": "sentence about how to serve",
  "criticNotes": [
    {"source": "Wine Advocate",  "score": 94, "note": "..."},
    {"source": "Wine Spectator", "score": 93, "note": "..."},
    {"source": "Vinous",         "score": 92, "note": "..."}
  ]
}`,
          }],
        });

        const text   = response.content?.find(b => b.type === "text")?.text || "{}";
        const parsed = safeParseJSON(text);
        return jsonResponse(parsed, corsHeaders);
      }

      // ── Route: /critics ────────────────────────────────────────
      if (path === "/critics") {
        const { winery, wine, vintage, varietal, region } = await request.json();
        if (!wine) return jsonError("Missing wine name", 400, corsHeaders);

        const wineDesc = [winery, wine, vintage].filter(Boolean).join(" ");
        const details  = [varietal, region].filter(Boolean).join(", ");

        // Try CellarTracker community API
        if (env.CELLARTRACKER_USER) {
          try {
            const ctQuery = encodeURIComponent(wineDesc);
            const ctUrl = `https://www.cellartracker.com/api.asp?q=list&type=Wine&wine=${ctQuery}&format=json&user=${encodeURIComponent(env.CELLARTRACKER_USER)}&password=${encodeURIComponent(env.CELLARTRACKER_PASS||"")}`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            const ctRes = await fetch(ctUrl, { signal: controller.signal });
            clearTimeout(timeout);
            if (ctRes.ok) {
              const ctData = await ctRes.json();
              const wines = Array.isArray(ctData) ? ctData : (ctData?.Table === "Wine" ? [ctData] : []);
              const match = wines[0];
              if (match?.iWine) {
                const notesUrl = `https://www.cellartracker.com/api.asp?q=list&type=CommunityTastingNotes&iWine=${match.iWine}&format=json&user=${encodeURIComponent(env.CELLARTRACKER_USER)}&password=${encodeURIComponent(env.CELLARTRACKER_PASS||"")}`;
                const notesRes = await fetch(notesUrl, { signal: new AbortController().signal });
                if (notesRes.ok) {
                  const notesData = await notesRes.json();
                  const notesList = Array.isArray(notesData) ? notesData : [];
                  if (notesList.length) {
                    const top = notesList.slice(0, 3);
                    return jsonResponse({
                      criticNotes: top.map(n => ({
                        source: n.Reviewer || "CellarTracker Community",
                        score:  n.Valuation ? Math.round(parseFloat(n.Valuation)) : null,
                        note:   n.Note || "",
                        criticSource: "community",
                      })),
                      criticSource: "community",
                    }, corsHeaders);
                  }
                  // CT found the wine but no tasting notes — use community score in AI prompt
                  const ctScore = match.CommunityCount > 0 ? Math.round(parseFloat(match.CommunityAvg || 0)) : null;
                  if (ctScore) {
                    const ctNotes = await generateCriticNotes(env.ANTHROPIC_API_KEY, wineDesc, details, ctScore);
                    return jsonResponse({ criticNotes: ctNotes, criticSource: "community" }, corsHeaders);
                  }
                }
              }
            }
          } catch (_) { /* fall through to AI */ }
        }

        // Fallback: pure AI-generated notes
        const aiNotes = await generateCriticNotes(env.ANTHROPIC_API_KEY, wineDesc, details, null);
        return jsonResponse({ criticNotes: aiNotes, criticSource: "ai" }, corsHeaders);
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error("Worker error:", err);
      return jsonError("Internal error: " + err.message, 500, corsHeaders);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────

async function generateCriticNotes(apiKey, wineDesc, details, anchorScore) {
  const scoreHint = anchorScore
    ? ` Community consensus score is ${anchorScore}/100 — keep all three scores within 3 points of that.`
    : " Scores within a 4-point range of each other (85-100).";
  const response = await callClaude(apiKey, {
    model: MODEL,
    max_tokens: 900,
    messages: [{
      role: "user",
      content: `You are an expert wine critic. For the wine "${wineDesc}"${details ? ` (${details})` : ""}, write exactly 3 critic-style tasting notes as they would appear in major wine publications. Each note 2-3 sentences in that publication's distinctive voice:
   - Wine Advocate: bold, analytical, fruit-forward, mentions structure and aging potential
   - Wine Spectator: accessible, balanced, food-friendly framing
   - Vinous: lyrical, terroir-focused, emphasizes texture and energy
${scoreHint}

Respond ONLY with valid JSON, no markdown:
{"criticNotes":[{"source":"Wine Advocate","score":94,"note":"..."},{"source":"Wine Spectator","score":93,"note":"..."},{"source":"Vinous","score":92,"note":"..."}]}`
    }],
  });
  const text = response.content?.find(b => b.type === "text")?.text || "{}";
  const parsed = safeParseJSON(text);
  return (parsed.criticNotes || []).map(n => ({ ...n, criticSource: "ai" }));
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

function safeParseJSON(text) {
  try {
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch {
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
