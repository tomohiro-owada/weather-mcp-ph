import { pagasaService } from '../services/pagasa.js';
import { openMeteoFloodService } from '../services/openmeteoFlood.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { validateDetail } from '../utils/validation.js';
import { calculateDistance } from '../utils/distance.js';

interface RiverConditionsArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  radius?: number;
  detail?: 'summary' | 'standard' | 'full';
}

function parsePagasaTime(value: string): Date {
  return new Date(value.replace(' ', 'T') + '+08:00');
}

export async function handleGetRiverConditions(
  args: unknown,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as RiverConditionsArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const detail = validateDetail(typedArgs.detail);
  const radius = Math.max(1, Math.min(typedArgs.radius ?? 50, 500));
  const [gaugesResult, forecastResult] = await Promise.allSettled([
    pagasaService.getRiverGauges(),
    openMeteoFloodService.getForecast(resolved.latitude, resolved.longitude, 7)
  ]);

  let output = '# Philippine River Conditions\n\n';
  output += `**Search radius:** ${radius} km\n\n`;

  if (gaugesResult.status === 'fulfilled') {
    const nearby = gaugesResult.value
      .map(gauge => ({
        gauge,
        distance: calculateDistance(
          resolved.latitude,
          resolved.longitude,
          gauge.latitude,
          gauge.longitude
        )
      }))
      .filter(item => item.distance <= radius && item.gauge.waterLevelMeters !== null)
      .sort((a, b) => a.distance - b.distance);
    const cap = detail === 'full' ? 25 : detail === 'summary' ? 3 : 5;
    if (nearby.length === 0) {
      output += `ℹ️ No PAGASA gauge with a current value was found within ${radius} km.\n\n`;
    } else {
      output += `## PAGASA observed water levels (${nearby.length} found)\n\n`;
      for (const { gauge, distance } of nearby.slice(0, cap)) {
        const observed = parsePagasaTime(gauge.observedAt);
        const ageHours = Math.max(0, (Date.now() - observed.getTime()) / 3_600_000);
        output += `### ${gauge.name}\n`;
        output += `- Water level: **${gauge.waterLevelMeters?.toFixed(2)} m**\n`;
        output += `- Distance: ${distance.toFixed(1)} km\n`;
        output += `- Observed: ${observed.toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`;
        if (ageHours > 3) output += ` ⚠️ ${Math.round(ageHours)} hours old`;
        output += '\n\n';
      }
      if (nearby.length > cap) output += `*${nearby.length - cap} additional gauges omitted.*\n\n`;
    }
  } else {
    output += `⚠️ PAGASA observed water levels are temporarily unavailable.\n\n`;
  }

  if (forecastResult.status === 'fulfilled' && forecastResult.value.dates.length > 0) {
    const forecast = forecastResult.value;
    output += '## GloFAS modeled river discharge\n\n';
    output += `**Model grid:** ${forecast.latitude.toFixed(3)}, ${forecast.longitude.toFixed(3)}\n\n`;
    const limit = detail === 'summary' ? 3 : 7;
    for (let i = 0; i < Math.min(limit, forecast.dates.length); i += 1) {
      const value = forecast.discharge[i];
      if (value === null || value === undefined) continue;
      const range = forecast.p25[i] !== null && forecast.p75[i] !== null
        ? ` (ensemble P25–P75: ${forecast.p25[i]?.toFixed(1)}–${forecast.p75[i]?.toFixed(1)})`
        : '';
      output += `- ${forecast.dates[i]}: **${value.toFixed(1)} m³/s**${range}\n`;
    }
    output += '\n';
  } else {
    output += '⚠️ Modeled river-discharge forecast is temporarily unavailable.\n\n';
  }

  output += '⚠️ PAGASA gauge values and GloFAS discharge are different measurements and must not be compared directly. Flood-stage thresholds are not inferred. Follow PAGASA and LGU evacuation guidance.\n\n';
  output += '---\n';
  output += '*Data sources: PAGASA Nationwide Hydromet Observation Network; Open-Meteo Flood API / GloFAS v4*\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
