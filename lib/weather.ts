// ---------------------------------------------------------------------------
// 天气：open-meteo（免密钥、开放 CORS，无需扩展额外权限）。
// ---------------------------------------------------------------------------
export interface WeatherNow {
  city: string;
  temp: number;
  code: number;
  wind: number;
}

export async function geocodeCity(
  city: string,
): Promise<{ lat: number; lon: number; name: string } | null> {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('地理编码失败');
  const j = (await r.json()) as {
    results?: { latitude: number; longitude: number; name: string }[];
  };
  const hit = j.results?.[0];
  return hit ? { lat: hit.latitude, lon: hit.longitude, name: hit.name } : null;
}

export async function fetchWeather(lat: number, lon: number, city: string): Promise<WeatherNow> {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
  const r = await fetch(u);
  if (!r.ok) throw new Error('天气获取失败');
  const j = (await r.json()) as {
    current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number };
  };
  const c = j.current;
  if (!c) throw new Error('天气数据为空');
  return { city, temp: c.temperature_2m, code: c.weather_code, wind: c.wind_speed_10m };
}

/** WMO weather code -> 中文描述 + emoji。 */
export function weatherLabel(code: number): { text: string; emoji: string } {
  if (code === 0) return { text: '晴', emoji: '☀️' };
  if (code <= 2) return { text: '多云', emoji: '🌤️' };
  if (code === 3) return { text: '阴', emoji: '☁️' };
  if (code <= 48) return { text: '雾', emoji: '🌫️' };
  if (code <= 57) return { text: '毛毛雨', emoji: '🌦️' };
  if (code <= 67) return { text: '雨', emoji: '🌧️' };
  if (code <= 77) return { text: '雪', emoji: '🌨️' };
  if (code <= 82) return { text: '阵雨', emoji: '🌧️' };
  if (code <= 86) return { text: '阵雪', emoji: '🌨️' };
  if (code <= 99) return { text: '雷暴', emoji: '⛈️' };
  return { text: '—', emoji: '🌡️' };
}
