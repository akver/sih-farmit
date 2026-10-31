/**
 * Farmit photo-analysis proxy — Cloudflare Worker.
 * Keeps the Anthropic API key server-side; the client never sees it.
 * Deploy this, then set PHOTO_ANALYSIS_ENDPOINT in index.html to its URL
 * (same pattern as NEARBY_PROXY_ENDPOINT / maps-proxy-worker.js).
 *
 * Env var required: ANTHROPIC_API_KEY (set via `wrangler secret put ANTHROPIC_API_KEY`)
 *
 * What this replaces: the client used to fake a "analyzing…" delay with
 * setTimeout and add a flat +5 confidence bump for any attached photo,
 * with no actual look at the image. This worker sends the photo to a
 * vision-capable Claude model and asks it to name only what is visibly
 * present (skin/coat, discharge, posture, lesions) relevant to the
 * species — never to diagnose. The client folds the count of named
 * indicators into assessRisk() and shows the raw list to the farmer/vet,
 * so nothing here is presented as more certain than it is.
 *
 * This is assistive triage support, not a diagnosis — every response
 * includes a disclaimer, and the model is explicitly told not to name a
 * disease.
 */

const MODEL = 'claude-sonnet-4-6';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB, base64-decoded size
const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Basic rate limiting should be configured at the Cloudflare level
    // (e.g. a Rate Limiting rule on this route) — not done in-code here.

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400 });
    }

    const { imageBase64, mediaType, species, lang } = body;

    if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
      return new Response(JSON.stringify({ error: 'missing imageBase64' }), { status: 400 });
    }
    if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
      return new Response(JSON.stringify({ error: 'unsupported mediaType' }), { status: 400 });
    }
    // Rough size guard so a huge upload can't be forwarded blindly.
    const approxBytes = imageBase64.length * 0.75;
    if (approxBytes > MAX_IMAGE_BYTES) {
      return new Response(JSON.stringify({ error: 'image too large' }), { status: 413 });
    }

    const allowedSpecies = ['cattle', 'buffalo', 'goat', 'sheep'];
    const speciesForPrompt = allowedSpecies.includes(species) ? species : 'farm animal';
    const languageCode = (typeof lang === 'string' && lang.length <= 5) ? lang : 'en';

    const systemPrompt =
      'You are assisting a photo-triage feature in a livestock health app used by ' +
      'smallholder farmers and field veterinary workers in India. You will be shown ' +
      'one photo of a ' + speciesForPrompt + '. List ONLY visibly observable physical ' +
      'signs that a field worker would also be able to see with their own eyes: things ' +
      'like skin lesions, nodules, blisters, hair/coat loss, visible discharge from ' +
      'eyes/nose/mouth, drooling, swelling, lameness/abnormal stance, visible wounds, or ' +
      'poor body condition. Do NOT name or suggest a specific disease, and do NOT give a ' +
      'diagnosis, treatment, or severity judgment — that is the job of the app\'s existing ' +
      'symptom-based logic and a real veterinarian, not this step. If the photo does not ' +
      'clearly show the animal, or shows nothing notable, say so plainly. Respond with ' +
      'strict JSON only, no markdown fences, matching exactly this shape: ' +
      '{"indicators": string[], "imageQualityOk": boolean, "note": string}. ' +
      '"indicators" is a short list (0-6 items) of plain-language visible signs, each ' +
      'under 8 words, in the language with code "' + languageCode + '" if you can, ' +
      'otherwise in English. "note" is at most one short sentence, only used when ' +
      'imageQualityOk is false (e.g. blurry, animal not visible) or indicators is empty.';

    try {
      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: mediaType, data: imageBase64 }
                },
                {
                  type: 'text',
                  text: 'Look at this photo and respond with the JSON object described in your instructions, nothing else.'
                }
              ]
            }
          ]
        })
      });

      if (!anthropicRes.ok) {
        return new Response(JSON.stringify({ error: 'upstream error' }), { status: 502 });
      }

      const data = await anthropicRes.json();
      const textBlock = (data.content || []).find(b => b.type === 'text');
      const raw = textBlock ? textBlock.text : '';

      let parsed;
      try {
        // Model is instructed to return bare JSON, but strip code fences
        // defensively in case one slips through.
        const cleaned = raw.replace(/^```json\s*|^```\s*|```$/gm, '').trim();
        parsed = JSON.parse(cleaned);
      } catch (e) {
        return new Response(JSON.stringify({ error: 'could not parse model output' }), { status: 502 });
      }

      const indicators = Array.isArray(parsed.indicators)
        ? parsed.indicators.filter(x => typeof x === 'string').slice(0, 6)
        : [];
      const imageQualityOk = parsed.imageQualityOk !== false;
      const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : '';

      return new Response(JSON.stringify({ indicators, imageQualityOk, note }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'proxy failure' }), { status: 500 });
    }
  }
};
