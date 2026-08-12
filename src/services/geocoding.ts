/**
 * Multi-Service Geocoding Service
 * Implements automatic fallback strategy across multiple geocoding providers
 * for maximum reliability and coverage
 */

import axios, { AxiosInstance } from 'axios';
import { DataNotFoundError, RateLimitError, ServiceUnavailableError } from '../errors/ApiError.js';
import { logger } from '../utils/logger.js';

/**
 * Serialize query parameters using RFC 3986 percent-encoding (spaces -> %20).
 *
 * Axios's default serializer encodes spaces as "+" (application/x-www-form-urlencoded
 * style). Nominatim treats such "+"-encoded queries inconsistently — notably it can
 * return ZERO matches at limit=1 for a query that returns matches with %20 encoding
 * (e.g. "Clare, MI"). Forcing %20 keeps geocoding results stable across providers and
 * result limits. Shared by every provider client below.
 */
export function rfc3986ParamsSerializer(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

/**
 * Minimum number of results requested from an upstream provider, regardless of the
 * caller's requested limit. Some providers (Nominatim in particular) rank or de-duplicate
 * unreliably when asked for a single result, so we always request a small floor and then
 * slice down to the caller's limit. Prevents fragile limit=1 lookups (e.g. the on-demand
 * city_name resolver) from spuriously returning "no results".
 */
const PROVIDER_RESULT_FLOOR = 5;

/**
 * Geocoding result with standardized format across all providers
 */
export interface GeocodingResult {
  name: string;
  display_name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;  // State/region
  admin2?: string;  // County/district
  timezone?: string;
  elevation?: number;
  population?: number;
  feature_code?: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'nominatim' | 'openmeteo';
}

/**
 * Geocoding provider interface
 */
interface GeocodingProvider {
  name: string;
  geocode(query: string, limit: number): Promise<GeocodingResult[]>;
}

/**
 * Rate limiter for controlling request frequency per provider
 */
class RateLimiter {
  private lastRequestTime: number = 0;
  private minInterval: number; // milliseconds between requests

  constructor(requestsPerSecond: number) {
    this.minInterval = 1000 / requestsPerSecond;
  }

  async throttle(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minInterval) {
      const delay = this.minInterval - timeSinceLastRequest;
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    this.lastRequestTime = Date.now();
  }
}

/**
 * Nominatim (OpenStreetMap) Provider
 * Best for: Worldwide locations, landmarks, natural language queries
 * Coverage: Global
 * Rate limit: 1 request/second (strictly enforced)
 */
class NominatimProvider implements GeocodingProvider {
  name = 'Nominatim';
  private client: AxiosInstance;
  private rateLimiter: RateLimiter;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://nominatim.openstreetmap.org',
      timeout: 10000,
      headers: {
        'User-Agent': 'weather-mcp-ph (github.com/tomohiro-owada/weather-mcp-ph)',
        'Accept': 'application/json'
      },
      paramsSerializer: { serialize: rfc3986ParamsSerializer }
    });

    // Strict 1 request/second rate limit as per Nominatim usage policy
    this.rateLimiter = new RateLimiter(1);
  }

  async geocode(query: string, limit: number): Promise<GeocodingResult[]> {
    await this.rateLimiter.throttle();

    try {
      logger.debug(`Nominatim geocode: "${query}"`);

      const response = await this.client.get('/search', {
        params: {
          q: query,
          format: 'json',
          addressdetails: 1,
          limit: Math.min(limit, 50), // Nominatim max is 50
          'accept-language': 'en'
        }
      });

      if (!response.data || response.data.length === 0) {
        logger.debug('Nominatim: No results found');
        return [];
      }

      const results: GeocodingResult[] = response.data.map((item: any) => {
        const address = item.address || {};

        // Determine confidence based on importance and type
        let confidence: 'high' | 'medium' | 'low' = 'medium';
        if (item.importance > 0.6) confidence = 'high';
        else if (item.importance < 0.3) confidence = 'low';

        return {
          name: item.name || item.display_name,
          display_name: item.display_name,
          latitude: parseFloat(item.lat),
          longitude: parseFloat(item.lon),
          country: address.country,
          country_code: address.country_code?.toUpperCase(),
          admin1: address.state || address.region,
          admin2: address.county,
          feature_code: this.mapTypeToFeatureCode(item.type),
          confidence,
          source: 'nominatim'
        };
      });

      logger.debug(`Nominatim: Found ${results.length} result(s)`);
      return results;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new ServiceUnavailableError('OpenMeteo', 'Nominatim geocoding service timed out');
        }
        if (error.response?.status === 429) {
          throw new RateLimitError('OpenMeteo', 'Nominatim geocoding rate limit exceeded (1 req/sec limit)');
        }
      }
      logger.debug(`Nominatim error: ${error instanceof Error ? error.message : 'Unknown'}`);
      return []; // Return empty array for fallback
    }
  }

  /**
   * Map Nominatim type to GeoNames-style feature code
   */
  private mapTypeToFeatureCode(type: string): string {
    const typeMap: { [key: string]: string } = {
      'city': 'PPL',
      'town': 'PPL',
      'village': 'PPL',
      'administrative': 'ADM1',
      'country': 'PCLI',
      'state': 'ADM1',
      'county': 'ADM2',
      'island': 'ISL',
      'airport': 'AIRP',
      'park': 'PRK',
      'lake': 'LAKE'
    };

    return typeMap[type.toLowerCase()] || type.toUpperCase();
  }
}

/**
 * Open-Meteo Geocoding Provider (existing implementation as fallback)
 * Best for: Reliable global coverage with detailed metadata
 * Coverage: Global
 * Rate limit: Part of 10,000 requests/day shared limit
 */
class OpenMeteoProvider implements GeocodingProvider {
  name = 'Open-Meteo';
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://geocoding-api.open-meteo.com/v1',
      timeout: 10000,
      headers: {
        'Accept': 'application/json'
      },
      paramsSerializer: { serialize: rfc3986ParamsSerializer }
    });
  }

  async geocode(query: string, limit: number): Promise<GeocodingResult[]> {
    try {
      logger.debug(`Open-Meteo geocode: "${query}"`);

      const response = await this.client.get('/search', {
        params: {
          name: query,
          count: Math.min(limit, 100),
          language: 'en',
          format: 'json'
        }
      });

      if (!response.data?.results || response.data.results.length === 0) {
        logger.debug('Open-Meteo: No results found');
        return [];
      }

      const results: GeocodingResult[] = response.data.results.map((item: any) => ({
        name: item.name,
        display_name: [item.name, item.admin1, item.admin2, item.country]
          .filter(Boolean)
          .join(', '),
        latitude: item.latitude,
        longitude: item.longitude,
        country: item.country,
        country_code: item.country_code,
        admin1: item.admin1,
        admin2: item.admin2,
        timezone: item.timezone,
        elevation: item.elevation,
        population: item.population,
        feature_code: item.feature_code,
        confidence: 'medium', // Open-Meteo is reliable but not authoritative
        source: 'openmeteo'
      }));

      logger.debug(`Open-Meteo: Found ${results.length} result(s)`);
      return results;

    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new ServiceUnavailableError('OpenMeteo', 'Open-Meteo geocoding service timed out');
        }
        if (error.response?.status === 429) {
          throw new RateLimitError('OpenMeteo', 'Open-Meteo geocoding rate limit exceeded');
        }
      }
      logger.debug(`Open-Meteo error: ${error instanceof Error ? error.message : 'Unknown'}`);
      return []; // Return empty array for fallback
    }
  }
}

/**
 * Multi-Service Geocoding Service
 * Automatically tries multiple providers in order with intelligent fallback
 */
export class GeocodingService {
  private nominatim: NominatimProvider;
  private openmeteo: OpenMeteoProvider;

  constructor() {
    this.nominatim = new NominatimProvider();
    this.openmeteo = new OpenMeteoProvider();
  }

  /**
   * Geocode a location query with automatic multi-service fallback
   *
   * Strategy: try Nominatim first, then Open-Meteo as a global fallback.
   *
   * @param query - Location search query (e.g., "Manila", "Cebu City")
   * @param limit - Maximum number of results to return
   * @returns Array of geocoding results from first successful provider
   */
  async geocode(query: string, limit: number = 5): Promise<GeocodingResult[]> {
    const providers: GeocodingProvider[] = [this.nominatim, this.openmeteo];
    logger.debug('Provider strategy: Global (Nominatim → Open-Meteo)');

    const errors: string[] = [];

    // Always request at least PROVIDER_RESULT_FLOOR from upstream (providers rank
    // unreliably at limit=1), then slice to the caller's requested limit.
    const providerLimit = Math.max(limit, PROVIDER_RESULT_FLOOR);

    // Try each provider in order
    for (const provider of providers) {
      try {
        logger.debug(`Trying provider: ${provider.name}`);
        const results = await provider.geocode(query, providerLimit);

        if (results.length > 0) {
          logger.info(`Geocoding successful via ${provider.name}: ${results.length} result(s)`);
          return results.slice(0, limit);
        }

        logger.debug(`${provider.name}: No results found`);
        errors.push(`${provider.name}: No results found`);

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.debug(`${provider.name} failed: ${errorMsg}`);
        errors.push(`${provider.name}: ${errorMsg}`);

        // Continue to next provider
        continue;
      }
    }

    // All providers failed or returned no results
    throw new DataNotFoundError(
      'OpenMeteo',
      `No locations found matching "${query}".\n\n` +
      `Tried ${providers.length} provider(s): ${errors.join('; ')}\n\n` +
      `Suggestions:\n` +
      `- Add more detail (e.g., "Paris, France" instead of "Paris")\n` +
      `- Check spelling\n` +
      `- Use a nearby major city\n` +
      `- Try providing coordinates directly (latitude, longitude)`
    );
  }

  /**
   * Get service information for debugging
   */
  getServiceInfo(): string {
    return `Multi-Service Geocoding:\n` +
           `- Nominatim/OpenStreetMap (worldwide, 1 req/sec limit)\n` +
           `- Open-Meteo (worldwide fallback)\n` +
           `Automatic global fallback strategy`;
  }
}
