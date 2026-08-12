import { firmsService } from '../services/firms.js';
import { LocationStore } from '../services/locationStore.js';
import { GeocodingService } from '../services/geocoding.js';
import { resolveLocationAsync, prependLocationLine } from '../utils/locationResolver.js';
import { calculateDistance } from '../utils/distance.js';
import { validateDetail } from '../utils/validation.js';

interface WildfireArgs {
  latitude?: number;
  longitude?: number;
  location_name?: string;
  city_name?: string;
  radius?: number;
  detail?: 'summary' | 'standard' | 'full';
}

export async function handleGetWildfireInfo(
  args: unknown,
  locationStore: LocationStore,
  geocodingService: GeocodingService
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const typedArgs = (args ?? {}) as WildfireArgs;
  const resolved = await resolveLocationAsync(typedArgs, locationStore, geocodingService);
  const detail = validateDetail(typedArgs.detail);
  const radius = Math.max(1, Math.min(typedArgs.radius ?? 100, 500));
  let output = '# Satellite Fire Detections\n\n';
  output += `**Search radius:** ${radius} km\n\n`;

  if (!firmsService.isConfigured()) {
    output += '⚙️ **NASA FIRMS is not configured.**\n\n';
    output += 'Set `FIRMS_MAP_KEY` to a free NASA FIRMS map key to enable this optional tool.\n';
    return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
  }

  const latOffset = radius / 111;
  const lonOffset = radius / (111 * Math.max(0.1, Math.cos(resolved.latitude * Math.PI / 180)));
  const detections = await firmsService.getDetections(
    resolved.longitude - lonOffset,
    resolved.latitude - latOffset,
    resolved.longitude + lonOffset,
    resolved.latitude + latOffset
  );
  const nearby = detections
    .map(detection => ({
      detection,
      distance: calculateDistance(
        resolved.latitude,
        resolved.longitude,
        detection.latitude,
        detection.longitude
      )
    }))
    .filter(item => item.distance <= radius)
    .sort((a, b) => a.distance - b.distance);

  if (nearby.length === 0) {
    output += '✅ **No VIIRS heat detections were found in the last 24 hours within this radius.**\n\n';
  } else {
    output += `🔥 **${nearby.length} satellite heat detection${nearby.length === 1 ? '' : 's'} found**\n\n`;
    const cap = detail === 'full' ? 25 : detail === 'summary' ? 3 : 10;
    for (const { detection, distance } of nearby.slice(0, cap)) {
      output += `- **${distance.toFixed(1)} km away** at `;
      output += `${detection.latitude.toFixed(4)}, ${detection.longitude.toFixed(4)} — `;
      output += `${detection.acquiredAt.toISOString()}`;
      if (detection.fireRadiativePower !== null) {
        output += ` · FRP ${detection.fireRadiativePower.toFixed(1)} MW`;
      }
      output += ` · confidence ${detection.confidence}\n`;
    }
    output += '\n';
  }

  output += '⚠️ FIRMS reports satellite heat anomalies, not confirmed named wildfires. Industrial heat, agricultural burning, and other sources may appear. It does not provide containment or evacuation status.\n\n';
  output += '---\n';
  output += '*Data source: NASA LANCE FIRMS, VIIRS S-NPP near-real-time active fire product*\n';
  return prependLocationLine({ content: [{ type: 'text', text: output }] }, resolved);
}
