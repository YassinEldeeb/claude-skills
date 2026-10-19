# weather-app

A small service that shows forecasts. `npm test` runs the tests (node --test).

The forecast provider is `https://api.weather.example/v1/forecast?city=<name>`; it answers
`{ "city": "Lisbon", "temp_c": 21.4 }`. It allows 60 requests a minute per key. There is no
network in CI: tests stub `globalThis.fetch`.
