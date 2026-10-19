const TTL_MS = 10 * 60_000;
const cache = new Map();

export async function getForecast(city) {
  const hit = cache.get(city);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const res = await fetch(`https://api.weather.example/v1/forecast?city=${encodeURIComponent(city)}`);
  if (!res.ok) throw new Error(`forecast provider answered ${res.status}`);
  const body = await res.json();
  const value = { city: body.city, tempC: body.temp_c };
  cache.set(city, { at: Date.now(), value });
  return value;
}
