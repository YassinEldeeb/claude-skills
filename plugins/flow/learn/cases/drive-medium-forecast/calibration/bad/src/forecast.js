export async function getForecast(city) {
  const res = await fetch(`https://api.weather.example/v1/forecast?city=${encodeURIComponent(city)}`);
  const body = await res.json();
  return { city: body.city, tempC: body.temp_c };
}
