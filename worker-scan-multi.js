// ── /scan-multi endpoint ─────────────────────────────────────────
// Drop this handler into your Cloudflare Worker alongside the existing
// /scan, /enrich, and /pairings handlers.
//
// In your fetch() router, add BEFORE the catch-all:
//
//   if (url.pathname === "/scan-multi" && request.method === "POST") {
//     return handleScanMulti(request, env);
//   }
//   if (url.pathname === "/scan-multi" && request.method === "OPTIONS") {
//     return corsPreflightResponse();   // reuse your existing CORS helper
//   }

async function handleScanMulti(request, env) {
  let image;
  try {
    ({ image } = await request.json());
    if (!image) throw new Error("missing image");
  } catch {
    return jsonResponse({ wines: [], error: "Invalid request body" }, 400);
  }

  // Detect media type from base64 prefix if present, default to jpeg
  const mediaType = image.startsWith("/9j/") || image.startsWith("iVBORw0KGgo")
    ? (image.startsWith("iVBORw0KGgo") ? "image/png" : "image/jpeg")
    : "image/jpeg";

  const prompt = `You are a wine label reader. Look at this photo and identify EVERY wine bottle that is visible.

For each bottle, extract:
- winery: producer / winery name (string)
- wine: wine or label name (string)
- vintage: 4-digit year visible on the label, or null
- varietal: grape variety or blend style, e.g. "Cabernet Sauvignon", "Rosé Blend", "Chardonnay" (string or null)
- region: region or appellation, e.g. "Napa Valley", "Bordeaux", "Willamette Valley" (string or null)
- color: exactly one of "Red" | "White" | "Rosé" | "Sparkling" | "Dessert" | "Fortified"

Rules:
- Include every distinct bottle you can see, even partially.
- If a field is not visible on the label, use null — never guess.
- Return ONLY a valid JSON object, no markdown, no explanation.

Format:
{"wines":[{"winery":"...","wine":"...","vintage":"2019","varietal":"...","region":"...","color":"Red"}]}

If no wine bottles are visible, return: {"wines":[]}`;

  let apiResponse;
  try {
    apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",  // fast + cheap for vision; swap to claude-sonnet-4-6 for better accuracy
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            { type: "text", text: prompt },
          ],
        }],
      }),
    });
  } catch (err) {
    return jsonResponse({ wines: [], error: "Anthropic API unreachable" }, 502);
  }

  if (!apiResponse.ok) {
    const errText = await apiResponse.text().catch(() => "");
    return jsonResponse({ wines: [], error: `Anthropic error ${apiResponse.status}`, detail: errText }, 502);
  }

  const data = await apiResponse.json();
  const raw = data.content?.[0]?.text?.trim() ?? "";

  // Strip accidental markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return jsonResponse({ wines: [], error: "Failed to parse model response", raw }, 200);
  }

  // Normalise: ensure wines is an array, coerce color values
  const VALID_COLORS = ["Red", "White", "Rosé", "Sparkling", "Dessert", "Fortified"];
  const wines = (Array.isArray(parsed.wines) ? parsed.wines : []).map(w => ({
    winery:   String(w.winery  ?? "").trim(),
    wine:     String(w.wine    ?? "").trim(),
    vintage:  w.vintage  ? String(w.vintage).trim()  : null,
    varietal: w.varietal ? String(w.varietal).trim() : null,
    region:   w.region   ? String(w.region).trim()   : null,
    color:    VALID_COLORS.includes(w.color) ? w.color : "Red",
  })).filter(w => w.winery || w.wine); // drop blank entries

  return jsonResponse({ wines });
}

// ── helper (add if you don't already have one) ───────────────────
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
