import { OpenMeteoService } from '../services/openmeteo.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { validateHistoricalWeatherParams } from '../utils/validation.js';
import { resolveUnitPreferences, UnitArgs } from '../utils/unitPreferences.js';
import { FormatConstants } from '../config/displayThresholds.js';

export async function handleGetHistoricalWeather(
  args: unknown,
  openMeteoService: OpenMeteoService,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const resolved = await resolveLocationAsync(
    args as { latitude?: number; longitude?: number; location_name?: string; city_name?: string },
    locationStore,
    geocodingService
  );
  const validated = validateHistoricalWeatherParams({
    ...(args as Record<string, unknown>),
    latitude: resolved.latitude,
    longitude: resolved.longitude
  });
  const prefs = resolveUnitPreferences(args as UnitArgs);
  const start = new Date(validated.start_date);
  const end = new Date(validated.end_date);
  if (start > new Date() || end > new Date()) throw new Error('Historical dates cannot be in the future');
  const dayCount = Math.ceil((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const hourly = dayCount <= 31;
  const response = await openMeteoService.getHistoricalWeather(
    resolved.latitude,
    resolved.longitude,
    validated.start_date.split('T')[0],
    validated.end_date.split('T')[0],
    hourly,
    prefs
  );

  let output = `# Philippine Historical Weather (${hourly ? 'Hourly' : 'Daily'})\n\n`;
  output += `**Period:** ${validated.start_date} to ${validated.end_date}\n`;
  output += '**Source:** Open-Meteo Historical Weather API\n\n';
  if (hourly && response.hourly) {
    const data = response.hourly;
    const units = response.hourly_units ?? {};
    const cap = Math.min(validated.limit ?? FormatConstants.defaultHistoricalLimit, data.time.length);
    for (let i = 0; i < cap; i += 1) {
      output += `## ${data.time[i]}\n`;
      if (data.weather_code?.[i] !== undefined) output += `- Conditions: ${openMeteoService.getWeatherDescription(data.weather_code[i])}\n`;
      if (data.temperature_2m?.[i] !== undefined) output += `- Temperature: ${data.temperature_2m[i]}${units.temperature_2m ?? ''}\n`;
      if (data.precipitation?.[i] !== undefined) output += `- Precipitation: ${data.precipitation[i]}${units.precipitation ?? ''}\n`;
      if (data.wind_speed_10m?.[i] !== undefined) output += `- Wind: ${data.wind_speed_10m[i]}${units.wind_speed_10m ?? ''}\n`;
      if (data.relative_humidity_2m?.[i] !== undefined) output += `- Humidity: ${data.relative_humidity_2m[i]}%\n`;
      output += '\n';
    }
  } else if (response.daily) {
    const data = response.daily;
    const units = response.daily_units ?? {};
    for (let i = 0; i < data.time.length; i += 1) {
      output += `## ${data.time[i]}\n`;
      if (data.weather_code?.[i] !== undefined) output += `- Conditions: ${openMeteoService.getWeatherDescription(data.weather_code[i])}\n`;
      if (data.temperature_2m_min?.[i] !== undefined && data.temperature_2m_max?.[i] !== undefined) {
        output += `- Temperature: ${data.temperature_2m_min[i]}${units.temperature_2m_min ?? ''} to ${data.temperature_2m_max[i]}${units.temperature_2m_max ?? ''}\n`;
      }
      if (data.precipitation_sum?.[i] !== undefined) output += `- Precipitation: ${data.precipitation_sum[i]}${units.precipitation_sum ?? ''}\n`;
      output += '\n';
    }
  }
  output += '---\n*Historical values are reanalysis/model data, not certified station records.*\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
