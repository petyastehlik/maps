// Live weather for the map centre via Open-Meteo (no key, CC-BY-4.0):
// cloud cover drives the cloud-shadow density, wind drives its drift.
// Offline or blocked → the baked-in defaults stay and nothing breaks.

export function initWeather(terrainUniforms, lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + '&current=cloud_cover,wind_speed_10m,wind_direction_10m,temperature_2m';
  const state = { live: false };

  async function refresh() {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { current } = await res.json();
      terrainUniforms.uCloudCover.value =
        Math.min(0.62, (current.cloud_cover / 100) * 0.62);
      // wind blows FROM wind_direction — clouds drift the opposite way
      const toward = (current.wind_direction_10m + 180) * Math.PI / 180;
      const speed = 0.003 + current.wind_speed_10m * 0.0011;
      terrainUniforms.uCloudDrift.value.set(
        Math.sin(toward) * speed, Math.cos(toward) * speed);
      Object.assign(state, current, { live: true });
      console.info(`[weather] ${current.cloud_cover} % oblačnost · `
        + `vítr ${current.wind_speed_10m} km/h · ${current.temperature_2m} °C`);
    } catch (err) {
      console.warn('[weather] nedostupné — výchozí oblačnost', err.message);
    }
  }

  refresh();
  setInterval(refresh, 15 * 60 * 1000);
  return state;
}
