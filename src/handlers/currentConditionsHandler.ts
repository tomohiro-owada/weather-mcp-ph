import { OpenMeteoService } from '../services/openmeteo.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { validateOptionalBoolean } from '../utils/validation.js';
import { resolveUnitPreferences, UnitArgs } from '../utils/unitPreferences.js';

interface CurrentConditionsArgs extends UnitArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  include_normals?: boolean;
}

export async function handleGetCurrentConditions(
  args: unknown,
  openMeteoService: OpenMeteoService,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as CurrentConditionsArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const prefs = resolveUnitPreferences(typedArgs);
  const includeNormals = validateOptionalBoolean(typedArgs.include_normals, 'include_normals', false);
  const response = await openMeteoService.getCurrentConditions(resolved.latitude, resolved.longitude, prefs);
  const current = response.current;
  const units = response.current_units ?? {};
  if (!current) throw new Error('No current weather data is available');

  let output = '# Current Philippine Weather\n\n';
  output += `**Time:** ${current.time} (${response.timezone})\n`;
  if (current.weather_code !== undefined) {
    output += `**Conditions:** ${openMeteoService.getWeatherDescription(current.weather_code)}\n`;
  }
  if (current.temperature_2m !== undefined) output += `**Temperature:** ${current.temperature_2m}${units.temperature_2m ?? ''}\n`;
  if (current.apparent_temperature !== undefined) output += `**Feels like:** ${current.apparent_temperature}${units.apparent_temperature ?? ''}\n`;
  if (current.relative_humidity_2m !== undefined) output += `**Humidity:** ${current.relative_humidity_2m}%\n`;
  if (current.dew_point_2m !== undefined) output += `**Dew point:** ${current.dew_point_2m}${units.dew_point_2m ?? ''}\n`;
  if (current.pressure_msl !== undefined) output += `**Pressure:** ${current.pressure_msl}${units.pressure_msl ?? ''}\n`;
  if (current.cloud_cover !== undefined) output += `**Cloud cover:** ${current.cloud_cover}%\n`;
  if (current.precipitation !== undefined) output += `**Precipitation:** ${current.precipitation}${units.precipitation ?? ''}\n`;
  if (current.wind_speed_10m !== undefined) {
    output += `**Wind:** ${current.wind_speed_10m}${units.wind_speed_10m ?? ''}`;
    if (current.wind_direction_10m !== undefined) output += ` from ${current.wind_direction_10m}°`;
    if (current.wind_gusts_10m !== undefined) output += `, gusts ${current.wind_gusts_10m}${units.wind_gusts_10m ?? ''}`;
    output += '\n';
  }
  if (response.daily?.temperature_2m_max?.[0] !== undefined) {
    output += `**Today's high / low:** ${response.daily.temperature_2m_max[0]}${response.daily_units?.temperature_2m_max ?? ''} / ${response.daily.temperature_2m_min?.[0]}${response.daily_units?.temperature_2m_min ?? ''}\n`;
  }

  if (includeNormals) {
    const today = new Date();
    const normals = await openMeteoService.getClimateNormals(
      resolved.latitude,
      resolved.longitude,
      today.getMonth() + 1,
      today.getDate()
    );
    output += `\n**30-year reference high / low:** ${normals.tempHigh.toFixed(1)}°F / ${normals.tempLow.toFixed(1)}°F\n`;
  }
  output += '\n*Open-Meteo values are model-based. For official warnings, use PAGASA alerts.*\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
