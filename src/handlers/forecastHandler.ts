import { OpenMeteoService } from '../services/openmeteo.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import {
  validateForecastDays,
  validateGranularity,
  validateOptionalBoolean,
  validateDetail,
  DetailLevel
} from '../utils/validation.js';
import { resolveUnitPreferences, UnitArgs } from '../utils/unitPreferences.js';

interface ForecastArgs extends UnitArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  days?: number;
  granularity?: 'daily' | 'hourly';
  include_precipitation_probability?: boolean;
  include_normals?: boolean;
  detail?: DetailLevel;
}

function value<T>(items: T[] | undefined, index: number): T | undefined {
  return items?.[index];
}

function hourlyCap(detail: DetailLevel, days: number): number {
  if (detail === 'full') return days * 24;
  return detail === 'summary' ? 24 : 48;
}

export async function handleGetForecast(
  args: unknown,
  openMeteoService: OpenMeteoService,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as ForecastArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const days = validateForecastDays(typedArgs);
  const granularity = validateGranularity(typedArgs.granularity);
  const detail = validateDetail(typedArgs.detail);
  const includeProbability = validateOptionalBoolean(
    typedArgs.include_precipitation_probability,
    'include_precipitation_probability',
    true
  );
  const includeNormals = validateOptionalBoolean(typedArgs.include_normals, 'include_normals', false);
  const prefs = resolveUnitPreferences(typedArgs);
  const response = await openMeteoService.getForecast(
    resolved.latitude,
    resolved.longitude,
    days,
    granularity === 'hourly',
    prefs
  );

  let output = `# Philippine Weather Forecast (${granularity === 'hourly' ? 'Hourly' : 'Daily'})\n\n`;
  output += `**Timezone:** ${response.timezone}\n`;
  output += `**Elevation:** ${response.elevation.toFixed(0)} m\n`;
  output += '**Source:** Open-Meteo multi-model forecast\n\n';

  if (granularity === 'hourly' && response.hourly) {
    const hourly = response.hourly;
    const units = response.hourly_units ?? {};
    const cap = Math.min(hourly.time.length, hourlyCap(detail, days));
    for (let i = 0; i < cap; i += 1) {
      output += `## ${hourly.time[i]}\n`;
      const code = value(hourly.weather_code, i);
      if (code !== undefined) output += `- Conditions: ${openMeteoService.getWeatherDescription(code)}\n`;
      const temp = value(hourly.temperature_2m, i);
      if (temp !== undefined) output += `- Temperature: **${temp}${units.temperature_2m ?? ''}**\n`;
      const feels = value(hourly.apparent_temperature, i);
      if (feels !== undefined) output += `- Feels like: ${feels}${units.apparent_temperature ?? ''}\n`;
      if (includeProbability) {
        const probability = value(hourly.precipitation_probability, i);
        if (probability !== undefined) output += `- Precipitation probability: ${probability}%\n`;
      }
      const precipitation = value(hourly.precipitation, i);
      if (precipitation !== undefined) output += `- Precipitation: ${precipitation}${units.precipitation ?? ''}\n`;
      const wind = value(hourly.wind_speed_10m, i);
      const gust = value(hourly.wind_gusts_10m, i);
      if (wind !== undefined) output += `- Wind: ${wind}${units.wind_speed_10m ?? ''}${gust !== undefined ? `, gusts ${gust}${units.wind_gusts_10m ?? ''}` : ''}\n`;
      const uv = value(hourly.uv_index, i);
      if (uv !== undefined) output += `- UV index: ${uv}\n`;
      output += '\n';
    }
    if (cap < hourly.time.length) output += `*Showing ${cap} hours; use detail="full" for the complete range.*\n\n`;
  } else if (response.daily) {
    const daily = response.daily;
    const units = response.daily_units ?? {};
    for (let i = 0; i < Math.min(days, daily.time.length); i += 1) {
      output += `## ${daily.time[i]}\n`;
      const code = value(daily.weather_code, i);
      if (code !== undefined) output += `- Conditions: ${openMeteoService.getWeatherDescription(code)}\n`;
      const high = value(daily.temperature_2m_max, i);
      const low = value(daily.temperature_2m_min, i);
      if (high !== undefined && low !== undefined) {
        output += `- Temperature: **${low}${units.temperature_2m_min ?? ''} to ${high}${units.temperature_2m_max ?? ''}**\n`;
      }
      if (includeProbability) {
        const probability = value(daily.precipitation_probability_max, i);
        if (probability !== undefined) output += `- Precipitation probability: ${probability}%\n`;
      }
      const rain = value(daily.precipitation_sum, i);
      if (rain !== undefined) output += `- Precipitation: ${rain}${units.precipitation_sum ?? ''}\n`;
      const wind = value(daily.wind_speed_10m_max, i);
      const gust = value(daily.wind_gusts_10m_max, i);
      if (wind !== undefined) output += `- Maximum wind: ${wind}${units.wind_speed_10m_max ?? ''}${gust !== undefined ? `, gusts ${gust}${units.wind_gusts_10m_max ?? ''}` : ''}\n`;
      const uv = value(daily.uv_index_max, i);
      if (uv !== undefined) output += `- Maximum UV index: ${uv}\n`;
      const sunrise = value(daily.sunrise, i);
      const sunset = value(daily.sunset, i);
      if (sunrise && sunset) output += `- Sunrise / sunset: ${sunrise} / ${sunset}\n`;
      output += '\n';
    }
  }

  if (includeNormals) {
    const today = new Date();
    const normals = await openMeteoService.getClimateNormals(
      resolved.latitude,
      resolved.longitude,
      today.getMonth() + 1,
      today.getDate()
    );
    output += '## Climate reference\n\n';
    output += `30-year average high / low: ${normals.tempHigh.toFixed(1)}°F / ${normals.tempLow.toFixed(1)}°F\n\n`;
  }

  output += '---\n*Forecast data: Open-Meteo. Official Philippine warnings: PAGASA-DOST.*\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
