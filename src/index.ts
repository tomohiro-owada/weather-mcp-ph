#!/usr/bin/env node

/**
 * Weather MCP Server
 * Philippines-focused weather data via Model Context Protocol
 */

// Load environment variables from .env file (for local development)
import 'dotenv/config';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import type { Request, Response } from 'express';
import { OpenMeteoService } from './services/openmeteo.js';
import { NominatimService } from './services/nominatim.js';
import { GeocodingService } from './services/geocoding.js';
import { LocationStore } from './services/locationStore.js';
import { blitzortungService } from './services/blitzortung.js';
import { CacheConfig } from './config/cache.js';
import { toolConfig } from './config/tools.js';
import { logger } from './utils/logger.js';
import { formatErrorForUser } from './errors/ApiError.js';
import { handleGetForecast } from './handlers/forecastHandler.js';
import { handleGetCurrentConditions } from './handlers/currentConditionsHandler.js';
import { handleGetAlerts } from './handlers/alertsHandler.js';
import { handleGetHistoricalWeather } from './handlers/historicalWeatherHandler.js';
import { handleCheckServiceStatus } from './handlers/statusHandler.js';
import { handleSearchLocation } from './handlers/locationHandler.js';
import { handleGetAirQuality } from './handlers/airQualityHandler.js';
import { handleGetMarineConditions } from './handlers/marineConditionsHandler.js';
import { handleGetWeatherImagery } from './handlers/weatherImageryHandler.js';
import { handleGetLightningActivity } from './handlers/lightningHandler.js';
import { handleGetRiverConditions } from './handlers/riverConditionsHandler.js';
import { handleGetWildfireInfo } from './handlers/wildfireHandler.js';
import { handleGetWeatherSummary } from './handlers/weatherSummaryHandler.js';
import { GoogleOAuthProvider, GOOGLE_OAUTH_SCOPE } from './auth/googleOAuthProvider.js';
import {
  handleSaveLocation,
  handleListSavedLocations,
  handleGetSavedLocation,
  handleRemoveSavedLocation
} from './handlers/savedLocationsHandler.js';
import { withAnalytics, analytics } from './analytics/index.js';

/**
 * Server information
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Read version from package.json to ensure single source of truth
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '../package.json'), 'utf-8')
);

const SERVER_NAME = 'weather-mcp-ph';
const SERVER_VERSION = packageJson.version;

/**
 * Redact sensitive fields from tool arguments before logging
 * Removes PII like coordinates, location names, addresses
 */
function redactSensitiveFields(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) {
    return args;
  }

  const redacted: Record<string, unknown> = {};
  const sensitiveFields = [
    'latitude', 'longitude', 'lat', 'lon',
    'location', 'city', 'city_name', 'state', 'address', 'query',
    'zipcode', 'postalCode', 'place', 'coordinates'
  ];

  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (sensitiveFields.includes(key)) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      redacted[key] = redactSensitiveFields(value);
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Initialize the Open-Meteo service for historical data
 * No API key required - free for non-commercial use
 */
const openMeteoService = new OpenMeteoService();

/**
 * Initialize the Nominatim service for geocoding
 * No API key required - uses OpenStreetMap data
 * Better coverage for small towns and villages than GeoNames
 * Rate limited to 1 request/second as per OSM usage policy
 */
const nominatimService = new NominatimService();

/**
 * Initialize the LocationStore for managing saved/favorite locations
 * Stores locations in ~/.weather-mcp/locations.json
 * No configuration required
 */
const locationStore = new LocationStore();

/**
 * Initialize the Geocoding service with multi-provider support
 * No API key required - uses Nominatim and Open-Meteo
 * Automatic fallback strategy for maximum reliability
 */
const geocodingService = new GeocodingService();

/**
 * Shared unit / localization parameters. Spread into weather tools so the AI can
 * request output units per call. Omitting them falls back to the server default
 * (WEATHER_UNITS env, default metric).
 */
const UNIT_SCHEMA_PROPERTIES = {
  units: {
    type: 'string' as const,
    description: 'Unit system for output: "metric" (°C, km/h, hPa) or "imperial" (°F, mph, inHg). Defaults to metric. Individual *_unit overrides below take precedence.',
    enum: ['imperial', 'metric']
  },
  temperature_unit: {
    type: 'string' as const,
    description: 'Override temperature unit: "F" or "C".',
    enum: ['F', 'C']
  },
  wind_speed_unit: {
    type: 'string' as const,
    description: 'Override wind speed unit: "mph", "kmh", "ms", or "kn" (knots).',
    enum: ['mph', 'kmh', 'ms', 'kn']
  },
  precipitation_unit: {
    type: 'string' as const,
    description: 'Override precipitation unit: "inch" or "mm".',
    enum: ['inch', 'mm']
  },
  pressure_unit: {
    type: 'string' as const,
    description: 'Override pressure unit: "inHg" or "hPa".',
    enum: ['inHg', 'hPa']
  },
  distance_unit: {
    type: 'string' as const,
    description: 'Override distance/visibility/elevation unit: "mi" or "km".',
    enum: ['mi', 'km']
  },
  time_format: {
    type: 'string' as const,
    description: 'Clock format for times: "12h" or "24h".',
    enum: ['12h', '24h']
  }
};

/**
 * Shared location parameters. Spread into every location-based weather tool so
 * the AI can provide a location in ONE of three consistent ways: coordinates,
 * a saved location name, or a free-text city name (geocoded on demand). Tools
 * using this fragment must declare `required: []` — resolveLocationAsync enforces
 * that at least one usable form is present at call time.
 */
const LOCATION_SCHEMA_PROPERTIES = {
  latitude: {
    type: 'number' as const,
    description: 'Latitude of the location (-90 to 90). Not required if location_name or city_name is provided.',
    minimum: -90,
    maximum: 90
  },
  longitude: {
    type: 'number' as const,
    description: 'Longitude of the location (-180 to 180). Not required if location_name or city_name is provided.',
    minimum: -180,
    maximum: 180
  },
  location_name: {
    type: 'string' as const,
    description: 'Name of a saved location (e.g., "home", "cabin"). Use instead of coordinates to reference a saved location. List them with list_saved_locations.'
  },
  city_name: {
    type: 'string' as const,
    description: 'Free-text place name to geocode (e.g., "Paris, France", "Bend, Oregon"). Use instead of coordinates when you only have a place name and it is not a saved location. Include state/country for disambiguation when possible.'
  }
};

/**
 * Shared output-verbosity parameter for high-volume tools.
 */
const DETAIL_SCHEMA_PROPERTY = {
  detail: {
    type: 'string' as const,
    description: 'Output verbosity: "summary" (shortest), "standard" (default, balanced), or "full" (everything the source provides, e.g. full alert descriptions, uncapped hourly forecast, embedded imagery).',
    enum: ['summary', 'standard', 'full']
  }
};

/**
 * Tool definitions - each tool defined separately for conditional registration
 */
const TOOL_DEFINITIONS = {
  get_forecast: {
    name: 'get_forecast' as const,
    description: 'Get an Open-Meteo weather forecast for a location, with up to 16 days of daily or hourly data. Includes temperature, precipitation, wind, conditions, UV, and sunrise/sunset. Provide coordinates, a saved location_name, or a free-text city_name such as "Manila".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        days: {
          type: 'number' as const,
          description: 'Number of days to include in forecast (1-16, default: 7)',
          minimum: 1,
          maximum: 16,
          default: 7
        },
        granularity: {
          type: 'string' as const,
          description: 'Forecast granularity: "daily" for day/night periods or "hourly" for hour-by-hour detail (default: "daily")',
          enum: ['daily', 'hourly'],
          default: 'daily'
        },
        include_precipitation_probability: {
          type: 'boolean' as const,
          description: 'Include precipitation probability in the forecast output (default: true)',
          default: true
        },
        include_normals: {
          type: 'boolean' as const,
          description: 'Include climate normals (30-year averages) for comparison with forecasted temperatures (default: false, daily forecasts only). Shows normal high/low and departure from normal for the first forecast day.',
          default: false
        },
        ...DETAIL_SCHEMA_PROPERTY,
        ...UNIT_SCHEMA_PROPERTIES
      },
      required: []
    }
  },

  get_current_conditions: {
    name: 'get_current_conditions' as const,
    description: 'Get current Open-Meteo model conditions including temperature, apparent temperature, wind, humidity, pressure, precipitation, and cloud cover. Provide coordinates, a saved location_name, or a free-text city_name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        include_normals: {
          type: 'boolean' as const,
          description: 'Include climate normals (30-year averages) for comparison with current conditions (default: false). Shows normal high/low temperatures and precipitation, with departure from normal.',
          default: false
        },
        ...UNIT_SCHEMA_PROPERTIES
      },
      required: []
    }
  },

  get_alerts: {
    name: 'get_alerts' as const,
    description: 'Get active PAGASA-DOST alerts for a location in the Philippines from the official CAP feed. Returns severity, urgency, certainty, validity times, affected areas, and safety instructions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        active_only: {
          type: 'boolean' as const,
          description: 'Whether to show only active alerts (default: true)',
          default: true
        },
        ...DETAIL_SCHEMA_PROPERTY
      },
      required: []
    }
  },

  get_historical_weather: {
    name: 'get_historical_weather' as const,
    description: 'Get Open-Meteo historical weather for a past date range, with coverage back to 1940. Provide coordinates, a saved location_name, or a free-text city_name. Use get_current_conditions for current weather.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        start_date: {
          type: 'string' as const,
          description: 'Start date in ISO format (YYYY-MM-DD or ISO 8601 datetime)',
        },
        end_date: {
          type: 'string' as const,
          description: 'End date in ISO format (YYYY-MM-DD or ISO 8601 datetime)',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of hourly observations to return (default: 168 = one week, max: 744 = full 31-day hourly window). Applies to hourly output only; daily-granularity output for ranges over 31 days always shows the full range.',
          minimum: 1,
          maximum: 744,
          default: 168
        },
        ...UNIT_SCHEMA_PROPERTIES
      },
      required: ['start_date', 'end_date']
    }
  },

  get_weather_summary: {
    name: 'get_weather_summary' as const,
    description: 'Get a combined overview with current conditions, forecast, and PAGASA alerts in one call. Air quality and lightning can be added. Best for broad questions such as "What is the weather in Manila?".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        include: {
          type: 'array' as const,
          description: 'Which sections to include (default: ["current", "forecast", "alerts"]). Add "air_quality" and/or "lightning" for a fuller picture.',
          items: {
            type: 'string' as const,
            enum: ['current', 'forecast', 'alerts', 'air_quality', 'lightning']
          }
        },
        days: {
          type: 'number' as const,
          description: 'Number of forecast days to include when the forecast section is requested (1-16, default: 7)',
          minimum: 1,
          maximum: 16,
          default: 7
        },
        ...DETAIL_SCHEMA_PROPERTY,
        ...UNIT_SCHEMA_PROPERTIES
      },
      required: []
    }
  },

  check_service_status: {
    name: 'check_service_status' as const,
    description: 'Check Open-Meteo and PAGASA upstream availability and report local cache statistics.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },

  search_location: {
    name: 'search_location' as const,
    description: 'Search for locations by name to get coordinates for weather queries. Uses Nominatim (OpenStreetMap) for excellent coverage of cities, towns, villages, and hamlets worldwide. Use this when the user provides a location name instead of coordinates (e.g., "Paris", "New York", "Tokyo", "San Francisco, CA", "Small Village, County"). Returns location matches with coordinates, timezone, elevation, and other metadata. Enables natural language location queries like "What\'s the weather in Paris?" by converting location names to coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string' as const,
          description: 'Location name to search for (e.g., "Paris", "New York, NY", "Tokyo")'
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of results to return (1-100, default: 5)',
          minimum: 1,
          maximum: 100,
          default: 5
        }
      },
      required: ['query']
    }
  },

  get_air_quality: {
    name: 'get_air_quality' as const,
    description: 'Get Open-Meteo air quality data including US AQI, European AQI, pollutants, UV index, health guidance, and an optional forecast of up to 7 days.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        forecast: {
          type: 'boolean' as const,
          description: 'Include hourly air quality forecast grouped by day (default: false, shows current only). Number of days controlled by forecast_days.',
          default: false
        },
        forecast_days: {
          type: 'number' as const,
          description: 'Number of forecast days when forecast=true (1-7, default: 5). 7 days is the maximum the air quality model provides (168 hours).',
          minimum: 1,
          maximum: 7,
          default: 5
        }
      },
      required: []
    }
  },

  get_marine_conditions: {
    name: 'get_marine_conditions' as const,
    description: 'Get marine conditions including wave height, swell, ocean currents, and sea state for a location (global coverage). Use this when asked about "ocean conditions", "wave height", "surf conditions", "safe to boat", "marine forecast", "swell", or "sea state". Returns current conditions and an optional daily forecast (up to 16 days via forecast_days; the marine model typically provides ~10 days). Includes significant wave height, wind waves, swell, wave period, and ocean currents. Shows safety assessment for maritime activities. Provide the location as coordinates (latitude+longitude), a saved location_name, or a free-text city_name. NOTE: Data has limited accuracy in coastal areas and is NOT suitable for coastal navigation - always consult official marine forecasts.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        forecast: {
          type: 'boolean' as const,
          description: 'Include daily marine forecast (default: false, shows current only). Number of days controlled by forecast_days.',
          default: false
        },
        forecast_days: {
          type: 'number' as const,
          description: 'Number of forecast days when forecast=true (1-16, default: 5). The marine model typically provides ~10 days of data; trailing days without data are omitted with a note.',
          minimum: 1,
          maximum: 16,
          default: 5
        }
      },
      required: []
    }
  },

  get_weather_imagery: {
    name: 'get_weather_imagery' as const,
    description: 'Get RainViewer precipitation imagery or Himawari-9 infrared satellite imagery via NASA GIBS. Returns timestamped image URLs and optional animation frames.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        type: {
          type: 'string' as const,
          description: 'Type of imagery: "radar" or "precipitation" (RainViewer), or "satellite" (Himawari-9 infrared via NASA GIBS).',
          enum: ['radar', 'satellite', 'precipitation'],
          default: 'precipitation'
        },
        animated: {
          type: 'boolean' as const,
          description: 'Return animated frames showing progression over time (default: false)',
          default: false
        },
        ...DETAIL_SCHEMA_PROPERTY
      },
      required: ['type']
    }
  },

  get_lightning_activity: {
    name: 'get_lightning_activity' as const,
    description: 'Get real-time lightning strike activity and safety assessment for a location (global coverage). Use this when asked about "lightning nearby", "lightning strikes", "thunderstorm activity", "is it safe from lightning", or "lightning danger". Returns recent strikes within specified radius and time window, including distance, polarity, intensity, and critical safety recommendations. Provides 4-level safety assessment (safe/elevated/high/extreme) based on proximity. Provide the location as coordinates (latitude+longitude), a saved location_name, or a free-text city_name. SAFETY-CRITICAL tool for outdoor activities and severe weather monitoring.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 100)',
          minimum: 1,
          maximum: 500,
          default: 100
        },
        timeWindow: {
          type: 'number' as const,
          description: 'Time window in minutes for historical strikes (5-120, default: 60)',
          minimum: 5,
          maximum: 120,
          default: 60
        },
        ...DETAIL_SCHEMA_PROPERTY
      },
      required: []
    }
  },

  get_river_conditions: {
    name: 'get_river_conditions' as const,
    description: 'Get nearby PAGASA hydromet water-level observations and Open-Meteo/GloFAS river-discharge forecasts for the Philippines. This is situational information, not a substitute for official flood warnings.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 50)',
          minimum: 1,
          maximum: 500,
          default: 50
        },
        ...DETAIL_SCHEMA_PROPERTY
      },
      required: []
    }
  },

  get_wildfire_info: {
    name: 'get_wildfire_info' as const,
    description: 'Find recent NASA FIRMS satellite heat anomalies near a location. Requires FIRMS_MAP_KEY. Detections are not confirmed wildfires and do not include containment or evacuation status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...LOCATION_SCHEMA_PROPERTIES,
        radius: {
          type: 'number' as const,
          description: 'Search radius in kilometers (1-500, default: 100)',
          minimum: 1,
          maximum: 500,
          default: 100
        },
        ...DETAIL_SCHEMA_PROPERTY
      },
      required: []
    }
  },

  save_location: {
    name: 'save_location' as const,
    description: 'Save a location for easy reuse in weather queries. Use this when a user wants to save a frequently used location like "home", "work", "cabin", or "aunt lisa\'s house". Accepts either a location query (which will be geocoded automatically) or direct coordinates. Saved locations can be used with all weather tools by providing location_name instead of coordinates. Makes it easy to ask "What\'s the weather forecast at home?" without repeatedly providing coordinates. SMART UPDATES: If the alias already exists and you only provide name/activities (without location details), it will update just those fields while preserving coordinates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'Short name/alias for this location (e.g., "home", "work", "cabin"). Will be lowercased automatically. Max 50 characters.',
          maxLength: 50
        },
        location_query: {
          type: 'string' as const,
          description: 'Location to geocode and save (e.g., "Manila" or "Cebu City"). Not required if latitude/longitude is provided.'
        },
        latitude: {
          type: 'number' as const,
          description: 'Latitude if providing coordinates directly. Not required if location_query provided.',
          minimum: -90,
          maximum: 90
        },
        longitude: {
          type: 'number' as const,
          description: 'Longitude if providing coordinates directly. Not required if location_query provided.',
          minimum: -180,
          maximum: 180
        },
        name: {
          type: 'string' as const,
          description: 'Display name for the location (required when using latitude/longitude), e.g. "Home in Makati".'
        },
        description: {
          type: 'string' as const,
          description: 'Short description for natural language matching (e.g., "My sister\'s house", "The lake house"). Helps Claude understand contextual references.'
        },
        alternateNames: {
          type: 'array' as const,
          description: 'Alternate names/aliases for this location (e.g., ["sister\'s place", "Jane\'s house"]). Enables more natural language queries.',
          items: {
            type: 'string' as const
          }
        },
        notes: {
          type: 'string' as const,
          description: 'Freeform notes about this location for future reference'
        },
        activities: {
          type: 'array' as const,
          items: {
            type: 'string' as const
          },
          description: 'Optional activities you do at this location (e.g., ["boating", "fishing"], ["hiking", "camping"]). Helps AI provide relevant weather information. Each activity max 50 characters.'
        }
      },
      required: ['alias']
    }
  },

  list_saved_locations: {
    name: 'list_saved_locations' as const,
    description: 'List all saved locations. Use this when a user wants to see their saved locations or asks "what locations do I have saved?" or "show my saved places". Returns all saved locations with their aliases, names, coordinates, and other metadata. Helpful for reminding users what location names they can use with weather tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: []
    }
  },

  get_saved_location: {
    name: 'get_saved_location' as const,
    description: 'Get details for a specific saved location. Use this when a user wants to view information about a particular saved location, like "show me details for my home location" or "what are the coordinates for my cabin?".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'The alias/name of the saved location to retrieve (e.g., "home", "work")'
        }
      },
      required: ['alias']
    }
  },

  remove_saved_location: {
    name: 'remove_saved_location' as const,
    description: 'Remove a saved location. Use this when a user wants to delete a saved location, like "remove my work location" or "delete the cabin from saved locations".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        alias: {
          type: 'string' as const,
          description: 'The alias/name of the saved location to remove (e.g., "home", "work")'
        }
      },
      required: ['alias']
    }
  }
};

/**
 * Handler for listing available tools
 * Only returns tools that are enabled in the configuration
 */
function createWeatherServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const enabledTools = toolConfig.getEnabledTools();
  const tools = enabledTools
    .map(toolName => TOOL_DEFINITIONS[toolName])
    .filter(Boolean); // Filter out any undefined tools

  return { tools };
});

/**
 * Handler for tool execution
 * Validates that tools are enabled before execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // Check if tool is enabled
    if (!toolConfig.isEnabled(name as any)) {
      throw new Error(`Tool '${name}' is not enabled. Please check your ENABLED_TOOLS configuration.`);
    }

    switch (name) {
      case 'get_forecast':
        return await withAnalytics('get_forecast', async () =>
          handleGetForecast(args, openMeteoService, locationStore, geocodingService)
        );

      case 'get_current_conditions':
        return await withAnalytics('get_current_conditions', async () =>
          handleGetCurrentConditions(args, openMeteoService, locationStore, geocodingService)
        );

      case 'get_alerts':
        return await withAnalytics('get_alerts', async () =>
          handleGetAlerts(args, locationStore, geocodingService)
        );

      case 'get_historical_weather':
        return await withAnalytics('get_historical_weather', async () =>
          handleGetHistoricalWeather(args, openMeteoService, locationStore, geocodingService)
        );

      case 'get_weather_summary':
        return await withAnalytics('get_weather_summary', async () =>
          handleGetWeatherSummary(args, openMeteoService, locationStore, geocodingService)
        );

      case 'check_service_status':
        return await withAnalytics('check_service_status', async () =>
          handleCheckServiceStatus(openMeteoService, SERVER_VERSION)
        );

      case 'search_location':
        return await withAnalytics('search_location', async () =>
          handleSearchLocation(args, geocodingService)
        );

      case 'get_air_quality':
        return await withAnalytics('get_air_quality', async () =>
          handleGetAirQuality(args, openMeteoService, locationStore, geocodingService)
        );

      case 'get_marine_conditions':
        return await withAnalytics('get_marine_conditions', async () =>
          handleGetMarineConditions(args, openMeteoService, locationStore, geocodingService)
        );

      case 'get_weather_imagery':
        return await withAnalytics('get_weather_imagery', async () =>
          handleGetWeatherImagery(args, locationStore, geocodingService)
        );

      case 'get_lightning_activity':
        return await withAnalytics('get_lightning_activity', async () =>
          handleGetLightningActivity(args, locationStore, geocodingService)
        );

      case 'get_river_conditions':
        return await withAnalytics('get_river_conditions', async () =>
          handleGetRiverConditions(args, locationStore, geocodingService)
        );

      case 'get_wildfire_info':
        return await withAnalytics('get_wildfire_info', async () =>
          handleGetWildfireInfo(args, locationStore, geocodingService)
        );

      case 'save_location':
        return await withAnalytics('save_location', async () =>
          handleSaveLocation(args, locationStore, nominatimService)
        );

      case 'list_saved_locations':
        return await withAnalytics('list_saved_locations', async () =>
          handleListSavedLocations(locationStore)
        );

      case 'get_saved_location':
        return await withAnalytics('get_saved_location', async () =>
          handleGetSavedLocation(args, locationStore)
        );

      case 'remove_saved_location':
        return await withAnalytics('remove_saved_location', async () =>
          handleRemoveSavedLocation(args, locationStore)
        );

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    // Redact sensitive fields from args before logging
    const redactedArgs = args ? redactSensitiveFields(args) : undefined;

    // Log the error with redacted details
    logger.error('Tool execution error', error as Error, {
      tool: name,
      args: redactedArgs ? JSON.stringify(redactedArgs) : undefined,
    });
    // Format error for user display (sanitized)
    const userMessage = formatErrorForUser(error as Error);

    return {
      content: [
        {
          type: 'text',
          text: userMessage
        }
      ],
      isError: true
    };
  }
});

  return server;
}

/**
 * Start the server
 */
/**
 * Pre-warm live lightning monitoring for saved locations at startup.
 *
 * The Blitzortung feed only buffers strikes for an area once it is subscribed, so the
 * first query to a location otherwise reports zero monitoring coverage. Subscribing
 * saved locations at startup lets their coverage accumulate before the user asks.
 * Best-effort and fully non-blocking: it opens a persistent MQTT connection, so it is
 * skipped when the lightning tool is disabled or when WEATHER_LIGHTNING_PREWARM=false.
 */
function prewarmLightningMonitoring(): void {
  if (process.env.WEATHER_LIGHTNING_PREWARM === 'false') {
    return;
  }
  if (!toolConfig.isEnabled('get_lightning_activity')) {
    return;
  }

  const savedLocations = Object.values(locationStore.getAll());
  if (savedLocations.length === 0) {
    return;
  }

  logger.info('Pre-warming lightning monitoring for saved locations', {
    count: savedLocations.length
  });

  // Fire-and-forget: prewarmLocation swallows its own errors and must never block
  // startup or the stdio transport.
  for (const location of savedLocations) {
    void blitzortungService.prewarmLocation(location.latitude, location.longitude);
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function bearerMatches(expected: string, authorization: string | undefined): boolean {
  if (!authorization?.startsWith('Bearer ')) return false;
  const actual = authorization.slice('Bearer '.length);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

interface HttpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastUsedAt: number;
}

async function startStreamableHttp(): Promise<() => Promise<void>> {
  const host = process.env.MCP_HOST?.trim() || '127.0.0.1';
  const port = parsePositiveInteger(process.env.PORT || process.env.MCP_PORT, 3000, 'PORT');
  const mcpPath = process.env.MCP_PATH?.trim() || '/mcp';
  if (!mcpPath.startsWith('/') || mcpPath.includes('?') || mcpPath.includes('#')) {
    throw new Error('MCP_PATH must be an absolute URL path such as /mcp');
  }

  const authToken = process.env.MCP_AUTH_TOKEN?.trim();
  const googleClientId = process.env.MCP_GOOGLE_CLIENT_ID?.trim();
  const googleClientSecret = process.env.MCP_GOOGLE_CLIENT_SECRET?.trim();
  const googleAllowedEmails = process.env.MCP_GOOGLE_ALLOWED_EMAILS
    ?.split(/[\s,]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean) ?? [];
  const oauthValues = [googleClientId, googleClientSecret, googleAllowedEmails.length > 0];
  const googleOAuthEnabled = oauthValues.every(Boolean);
  if (!googleOAuthEnabled && oauthValues.some(Boolean)) {
    throw new Error(
      'Google OAuth requires MCP_GOOGLE_CLIENT_ID, MCP_GOOGLE_CLIENT_SECRET, and ' +
      'MCP_GOOGLE_ALLOWED_EMAILS together'
    );
  }
  const allowUnauthenticated = process.env.MCP_ALLOW_UNAUTHENTICATED === 'true';
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);
  if (!authToken && !googleOAuthEnabled && !allowUnauthenticated && !loopbackHosts.has(host)) {
    throw new Error(
      'Authentication is required when MCP_HOST is not loopback. Configure Google OAuth, ' +
      'set MCP_AUTH_TOKEN, or explicitly set MCP_ALLOW_UNAUTHENTICATED=true.'
    );
  }

  const allowedHosts = process.env.MCP_ALLOWED_HOSTS
    ?.split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const app = createMcpExpressApp({
    host,
    allowedHosts: allowedHosts && allowedHosts.length > 0 ? allowedHosts : undefined
  });
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  const sessions = new Map<string, HttpSession>();
  const maxSessions = parsePositiveInteger(process.env.MCP_MAX_SESSIONS, 100, 'MCP_MAX_SESSIONS');
  const sessionTtlMs = parsePositiveInteger(
    process.env.MCP_SESSION_TTL_MS,
    60 * 60 * 1000,
    'MCP_SESSION_TTL_MS'
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', transport: 'streamable-http', version: SERVER_VERSION });
  });

  let googleOAuthProvider: GoogleOAuthProvider | undefined;
  let resourceMetadataUrl: string | undefined;
  if (googleOAuthEnabled) {
    const publicBaseUrlValue = process.env.MCP_PUBLIC_URL?.trim();
    if (!publicBaseUrlValue) {
      throw new Error('MCP_PUBLIC_URL is required when Google OAuth is enabled');
    }
    const publicBaseUrl = new URL(publicBaseUrlValue);
    if (publicBaseUrl.protocol !== 'https:') {
      throw new Error('MCP_PUBLIC_URL must use HTTPS when Google OAuth is enabled');
    }
    const resourceUrl = new URL(mcpPath, publicBaseUrl);
    const callbackUrl = new URL('/oauth/callback', publicBaseUrl);
    googleOAuthProvider = new GoogleOAuthProvider({
      clientId: googleClientId!,
      clientSecret: googleClientSecret!,
      callbackUrl,
      resourceUrl,
      allowedEmails: googleAllowedEmails,
      storePath: process.env.MCP_OAUTH_STORE_PATH?.trim()
        || join(homedir(), '.weather-mcp', 'oauth.json')
    });
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
    app.use(mcpAuthRouter({
      provider: googleOAuthProvider,
      issuerUrl: publicBaseUrl,
      resourceServerUrl: resourceUrl,
      scopesSupported: [GOOGLE_OAUTH_SCOPE],
      resourceName: 'Weather MCP Philippines',
      clientRegistrationOptions: { clientIdGeneration: false }
    }));
    app.get(callbackUrl.pathname, async (req, res) => {
      try {
        const requestUrl = new URL(req.originalUrl, publicBaseUrl);
        const redirect = await googleOAuthProvider!.handleGoogleCallback(requestUrl.searchParams);
        res.redirect(redirect.href);
      } catch (error) {
        logger.warn('Google OAuth callback rejected', { error: String(error) });
        res.status(400).type('text/plain').send('Unable to complete Google authentication.');
      }
    });
  }

  if (googleOAuthProvider) {
    const oauthMiddleware = requireBearerAuth({
      verifier: googleOAuthProvider,
      requiredScopes: [GOOGLE_OAUTH_SCOPE],
      resourceMetadataUrl
    });
    app.use(mcpPath, (req, res, next) => {
      if (authToken && bearerMatches(authToken, req.header('authorization'))) {
        next();
        return;
      }
      oauthMiddleware(req, res, next);
    });
  } else if (authToken) {
    app.use(mcpPath, (req, res, next) => {
      if (!bearerMatches(authToken, req.header('authorization'))) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  }

  app.post(mcpPath, async (req, res) => {
    try {
      const sessionId = req.header('mcp-session-id');
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        existing.lastUsedAt = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(sessionId ? 404 : 400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Invalid or missing MCP session' },
          id: null
        });
        return;
      }
      if (sessions.size >= maxSessions) {
        res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'MCP session capacity reached' },
          id: null
        });
        return;
      }

      let weatherServer!: Server;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: initializedId => {
          sessions.set(initializedId, {
            transport,
            server: weatherServer,
            lastUsedAt: Date.now()
          });
        },
        onsessionclosed: closedId => {
          sessions.delete(closedId);
        }
      });
      transport.onclose = () => {
        const initializedId = transport.sessionId;
        if (initializedId) sessions.delete(initializedId);
      };
      weatherServer = createWeatherServer();
      try {
        await weatherServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        await weatherServer.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      logger.error('Streamable HTTP request failed', error as Error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  const handleSessionRequest = async (
    req: Request,
    res: Response
  ) => {
    const sessionId = req.header('mcp-session-id');
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(404).json({ error: 'Invalid or missing MCP session' });
      return;
    }
    session.lastUsedAt = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error('Streamable HTTP session request failed', error as Error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  };
  app.get(mcpPath, handleSessionRequest);
  app.delete(mcpPath, handleSessionRequest);

  const httpServer = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
    const listener = app.listen(port, host, () => resolve(listener));
    listener.once('error', reject);
  });
  const sweepInterval = setInterval(() => {
    const cutoff = Date.now() - sessionTtlMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastUsedAt < cutoff) {
        sessions.delete(sessionId);
        void session.server.close().catch(error =>
          logger.warn('Failed to close expired MCP session', { error: String(error) })
        );
      }
    }
  }, Math.min(sessionTtlMs, 60_000));
  sweepInterval.unref();

  logger.info('Weather MCP Streamable HTTP server started', {
    host,
    port,
    path: mcpPath,
    authentication: googleOAuthProvider
      ? (authToken ? 'google-oauth+static-bearer' : 'google-oauth')
      : (authToken ? 'static-bearer' : 'none'),
    tls: 'terminate HTTPS at a reverse proxy'
  });

  return async () => {
    clearInterval(sweepInterval);
    await Promise.allSettled(Array.from(sessions.values(), session => session.server.close()));
    await new Promise<void>((resolve, reject) => {
      httpServer.close(error => error ? reject(error) : resolve());
    });
  };
}

async function main() {
  const mode = (process.env.MCP_TRANSPORT?.trim().toLowerCase() || 'stdio');
  let closeTransport: () => Promise<void>;

  if (mode === 'stdio') {
    const server = createWeatherServer();
    await server.connect(new StdioServerTransport());
    closeTransport = () => server.close();
    logger.info('Weather MCP stdio server started');
  } else if (mode === 'http' || mode === 'streamable-http') {
    closeTransport = await startStreamableHttp();
  } else {
    throw new Error('MCP_TRANSPORT must be stdio, http, or streamable-http');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await closeTransport();
      await analytics.shutdown();
      openMeteoService.clearCache();
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown', error as Error);
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  logger.info('Weather MCP Server ready', {
    version: SERVER_VERSION,
    transport: mode,
    cacheEnabled: CacheConfig.enabled,
    logLevel: process.env.LOG_LEVEL || 'INFO',
    enabledTools: toolConfig.getEnabledTools().length,
    toolList: toolConfig.getEnabledTools().join(', '),
    repository: 'https://github.com/tomohiro-owada/weather-mcp-ph'
  });
  prewarmLightningMonitoring();
}

main().catch((error) => {
  logger.error('Fatal error in main()', error);

  // Log structured error for monitoring
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'FATAL',
    message: 'Application failed to start',
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }
  }));

  process.exit(1);
});
