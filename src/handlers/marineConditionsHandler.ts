import { OpenMeteoService } from '../services/openmeteo.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { validateOptionalBoolean, validatePositiveInteger } from '../utils/validation.js';
import { getWaveHeightCategory, getSafetyAssessment } from '../utils/marine.js';

interface MarineConditionsArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  forecast?: boolean;
  forecast_days?: number;
}

export async function handleGetMarineConditions(
  args: unknown,
  openMeteoService: OpenMeteoService,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as MarineConditionsArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const forecast = validateOptionalBoolean(typedArgs.forecast, 'forecast', false);
  const days = typedArgs.forecast_days === undefined
    ? 5
    : validatePositiveInteger(typedArgs.forecast_days, 'forecast_days', 1, 16);
  const response = await openMeteoService.getMarine(resolved.latitude, resolved.longitude, forecast, days);
  const current = response.current;
  const units = response.current_units ?? {};
  let output = '# Philippine Marine Conditions\n\n';
  output += `**Timezone:** ${response.timezone}\n`;
  output += '**Source:** Open-Meteo Marine API\n\n';
  if (current) {
    output += `## Current conditions — ${current.time}\n\n`;
    if (current.wave_height !== undefined) {
      const category = getWaveHeightCategory(current.wave_height);
      output += `- Significant wave height: **${current.wave_height}${units.wave_height ?? ''}** (${category.description})\n`;
      const safety = getSafetyAssessment(
        current.wave_height,
        current.wind_wave_height,
        current.swell_wave_height,
        current.wave_period
      );
      output += `- Safety: ${safety.level} — ${safety.description}. ${safety.recommendation}\n`;
    }
    if (current.wave_period !== undefined) output += `- Wave period: ${current.wave_period}${units.wave_period ?? ''}\n`;
    if (current.wave_direction !== undefined) output += `- Wave direction: ${current.wave_direction}°\n`;
    if (current.swell_wave_height !== undefined) output += `- Swell: ${current.swell_wave_height}${units.swell_wave_height ?? ''} at ${current.swell_wave_period ?? '?'}${units.swell_wave_period ?? ''}\n`;
    if (current.ocean_current_velocity !== undefined) output += `- Ocean current: ${current.ocean_current_velocity}${units.ocean_current_velocity ?? ''} toward ${current.ocean_current_direction ?? '?'}°\n`;
    output += '\n';
  }
  if (forecast && response.daily) {
    output += '## Daily forecast\n\n';
    const daily = response.daily;
    const dailyUnits = response.daily_units ?? {};
    for (let i = 0; i < Math.min(days, daily.time.length); i += 1) {
      if (daily.wave_height_max?.[i] === null || daily.wave_height_max?.[i] === undefined) continue;
      output += `- ${daily.time[i]}: waves up to **${daily.wave_height_max[i]}${dailyUnits.wave_height_max ?? ''}**`;
      if (daily.wave_period_max?.[i] !== undefined) output += `, period ${daily.wave_period_max[i]}${dailyUnits.wave_period_max ?? ''}`;
      output += '\n';
    }
    output += '\n';
  }
  output += '⚠️ Model data is not suitable as the sole source for navigation. Consult PAGASA marine bulletins and local port authorities.\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
