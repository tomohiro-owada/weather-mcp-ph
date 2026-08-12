# Weather MCP Philippines

A Philippines-focused [Model Context Protocol](https://modelcontextprotocol.io/) server for forecasts, PAGASA alerts, river conditions, marine weather, satellite imagery, air quality, lightning, and historical weather.

This project is derived from [weather-mcp/weather-mcp](https://github.com/weather-mcp/weather-mcp). The US-only NOAA, NWPS, NCEI, Census, and NIFC integrations were removed rather than carried as unused fallback code.

## Data sources

| Capability | Source | Coverage |
|---|---|---|
| Forecasts and current conditions | [Open-Meteo](https://open-meteo.com/) | Global |
| Official alerts | [PAGASA-DOST CAP](https://publicalert.pagasa.dost.gov.ph/feeds/) | Philippines |
| Historical weather | [Open-Meteo Historical API](https://open-meteo.com/en/docs/historical-weather-api) | Global, back to 1940 |
| River observations | PAGASA Panahon hydromet feed | Philippines, available stations |
| River discharge forecast | [Open-Meteo Flood API / GloFAS](https://open-meteo.com/en/docs/flood-api) | Global |
| Marine conditions | [Open-Meteo Marine API](https://open-meteo.com/en/docs/marine-weather-api) | Global oceans |
| Satellite imagery | [NASA GIBS](https://www.earthdata.nasa.gov/data/tools/gibs) Himawari-9 | Western Pacific |
| Precipitation imagery | [RainViewer](https://www.rainviewer.com/api.html) | Global where radar is available |
| Heat anomalies | [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/api/) | Global; optional API key |
| Lightning | [Blitzortung.org](https://www.blitzortung.org/) community network | Coverage varies |
| Air quality and UV | [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) | Global |
| Geocoding | OpenStreetMap Nominatim, then Open-Meteo | Global |

## Tools

The default `basic` preset exposes six tools. Set `ENABLED_TOOLS=standard` or `full` to expose more.

| Tool | Purpose |
|---|---|
| `get_weather_summary` | Current conditions, forecast, and PAGASA alerts in one call |
| `get_forecast` | Up to 16 days, daily or hourly |
| `get_current_conditions` | Current Open-Meteo model conditions |
| `get_alerts` | Location-filtered PAGASA CAP warnings |
| `get_historical_weather` | Hourly/daily history back to 1940 |
| `search_location` | Convert place names to coordinates |
| `get_air_quality` | AQI, pollutants, UV, and optional forecast |
| `get_marine_conditions` | Waves, swell, currents, and sea state |
| `get_weather_imagery` | RainViewer precipitation or Himawari-9 infrared imagery |
| `get_lightning_activity` | Recent community-network strike activity |
| `get_river_conditions` | PAGASA water levels plus GloFAS discharge forecast |
| `get_wildfire_info` | NASA FIRMS heat anomalies; requires `FIRMS_MAP_KEY` |
| `check_service_status` | Upstream health and cache status |
| `save_location`, `list_saved_locations`, `get_saved_location`, `remove_saved_location` | Local saved-place management |

## Run locally

Requires Node.js 18 or newer.

```bash
git clone https://github.com/tomohiro-owada/weather-mcp-ph.git
cd weather-mcp-ph
npm ci
npm run build
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "weather-ph": {
      "command": "node",
      "args": ["/absolute/path/to/weather-mcp-ph/dist/index.js"],
      "env": {
        "ENABLED_TOOLS": "standard",
        "WEATHER_UNITS": "metric"
      }
    }
  }
}
```

For all tools:

```bash
ENABLED_TOOLS=full node dist/index.js
```

Optional environment variables:

| Variable | Meaning |
|---|---|
| `ENABLED_TOOLS` | `basic` (default), `standard`, `full`, or a comma-separated tool list |
| `WEATHER_UNITS` | `metric` or `imperial` |
| `FIRMS_MAP_KEY` | Free NASA FIRMS map key for heat-anomaly queries |
| `WEATHER_LIGHTNING_PREWARM` | Set `false` to disable saved-location lightning prewarming |
| `LOG_LEVEL` | Logging level |
| `ANALYTICS_ENABLED` | Analytics are off unless explicitly set to `true` |

## Important limitations

- PAGASA alerts are authoritative, but this software is not. Always follow PAGASA and local government instructions for safety-critical decisions.
- The PAGASA Panahon water-level endpoint is public but undocumented and may change. Missing gauges or readings are reported rather than inferred.
- Open-Meteo values are model data, not PAGASA station observations.
- FIRMS detects satellite heat anomalies. A detection is not proof of a wildfire and contains no evacuation or containment information.
- RainViewer and Blitzortung coverage varies by place and time.
- Marine model data must not be used as the sole source for navigation.

## Development

```bash
npm test
npm run build
```

Contributions that improve Philippine coverage, PAGASA interoperability, tests, or source transparency are welcome.

## License

MIT. See [LICENSE](LICENSE). Original Weather MCP attribution is retained in the repository history and package metadata.
