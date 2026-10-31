/**
 * Farmit nearby-resources proxy — Cloudflare Worker.
 * Keeps the Google Places API key server-side; the client never sees it.
 * Deploy this, then set NEARBY_PROXY_ENDPOINT in index.html to its URL.
 *
 * Env var required: GOOGLE_MAPS_API_KEY (set via `wrangler secret put GOOGLE_MAPS_API_KEY`)
 *
 * Key restriction (Google Cloud Console → Credentials):
 *   - Application restriction: "IP addresses" is not available for
 *     Cloudflare Workers' shared egress IPs, so restrict by API only
 *     (API restrictions → Places API) and rely on this proxy being the
 *     only caller. Never ship this key in index.html.
 *   - Enable "Places API (New)" on the same Google Cloud project.
 *     Billing must be enabled on the project (Places API is not free,
 *     though Google provides a monthly credit).
 */

const SEARCH_RADIUS_METERS = 15000; // 15 km
const MAX_RESULTS = 5;

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

    const { lat, lon, lang } = body;
    if (typeof lat !== 'number' || typeof lon !== 'number' || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return new Response(JSON.stringify({ error: 'invalid coordinates' }), { status: 400 });
    }

    const languageCode = (typeof lang === 'string' && lang.length <= 5) ? lang : 'en';

    try {
      // Places API (New) — searchNearby. Two parallel queries (vet care +
      // pet/agri stores) so results cover both use cases from Task 2A,
      // merged and sorted by distance below.
      const requestBody = (includedTypes) => ({
        includedTypes,
        maxResultCount: MAX_RESULTS,
        languageCode,
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lon },
            radius: SEARCH_RADIUS_METERS
          }
        }
      });

      const fieldMask = 'places.displayName,places.location,places.id,places.formattedAddress,places.primaryTypeDisplayName';

      const [vetRes, shopRes] = await Promise.all([
        fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': fieldMask
          },
          body: JSON.stringify(requestBody(['veterinary_care']))
        }),
        fetch('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
            'X-Goog-FieldMask': fieldMask
          },
          body: JSON.stringify(requestBody(['pharmacy', 'hardware_store', 'store']))
        })
      ]);

      if (!vetRes.ok && !shopRes.ok) {
        return new Response(JSON.stringify({ error: 'upstream error' }), { status: 502 });
      }

      const vetData = vetRes.ok ? await vetRes.json() : { places: [] };
      const shopData = shopRes.ok ? await shopRes.json() : { places: [] };
      const raw = [...(vetData.places || []), ...(shopData.places || [])];

      const places = raw
        .map(p => ({
          name: p.displayName?.text || 'Unnamed',
          type: p.primaryTypeDisplayName?.text || '',
          lat: p.location?.latitude,
          lon: p.location?.longitude,
          placeId: p.id,
          distanceMeters: haversineMeters(lat, lon, p.location?.latitude, p.location?.longitude)
        }))
        .filter(p => p.lat != null && p.lon != null)
        .sort((a, b) => a.distanceMeters - b.distanceMeters)
        .slice(0, MAX_RESULTS);

      return new Response(JSON.stringify({ places }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'proxy failure' }), { status: 500 });
    }
  }
};

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
