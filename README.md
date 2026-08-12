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

## Streamable HTTP and HTTPS

stdio remains the default. To run the same server with the stateful MCP Streamable HTTP transport:

```bash
MCP_TRANSPORT=http \
MCP_HOST=127.0.0.1 \
PORT=3000 \
MCP_AUTH_TOKEN="$(openssl rand -hex 32)" \
node dist/index.js
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`; `GET /health` is an unauthenticated liveness check. MCP requests require `Authorization: Bearer <token>` whenever `MCP_AUTH_TOKEN` is set.

For internet-facing use, keep the Node process on loopback and terminate HTTPS at a reverse proxy. A minimal Caddy configuration is:

```bash
MCP_TRANSPORT=http \
MCP_HOST=127.0.0.1 \
PORT=3000 \
MCP_AUTH_TOKEN="replace-with-a-long-random-token" \
MCP_ALLOWED_HOSTS=weather.example.com \
node dist/index.js
```

```caddyfile
weather.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Clients then connect to `https://weather.example.com/mcp` with the bearer token. If the process must bind directly to `0.0.0.0`, `MCP_AUTH_TOKEN` is mandatory unless the operator explicitly sets `MCP_ALLOW_UNAUTHENTICATED=true`. `MCP_ALLOWED_HOSTS` is needed when a reverse proxy forwards a public Host header to a loopback-bound process.

### Google OAuth for MCP clients

Clients that cannot set a static Authorization header can use the MCP OAuth 2.1 flow. The server provides Protected Resource Metadata, Authorization Server Metadata, Dynamic Client Registration, Authorization Code with PKCE, rotating refresh tokens, and revocation. Google is used only to verify the person's identity; MCP access and refresh tokens are issued locally and stored as hashes.

Create or reuse a Google OAuth web client and register this exact redirect URI:

```text
https://weather.example.com/oauth/callback
```

Then run:

```bash
MCP_TRANSPORT=http \
MCP_HOST=127.0.0.1 \
PORT=3000 \
MCP_PUBLIC_URL=https://weather.example.com \
MCP_GOOGLE_CLIENT_ID=your-client.apps.googleusercontent.com \
MCP_GOOGLE_CLIENT_SECRET=your-client-secret \
MCP_GOOGLE_ALLOWED_EMAILS=owner@example.com \
MCP_ALLOWED_HOSTS=weather.example.com \
node dist/index.js
```

`MCP_GOOGLE_ALLOWED_EMAILS` is mandatory and accepts comma- or whitespace-separated addresses or a JSON string array. Only those verified Google accounts can finish authorization. OAuth clients are dynamically registered at `/register`; the other endpoints are advertised through `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`. The local OAuth state defaults to `~/.weather-mcp/oauth.json`; protect this file and its parent directory. `MCP_AUTH_TOKEN` may be set at the same time as an optional compatibility path for clients that support static headers.

Sessions are kept in memory and expire after one hour of inactivity by default. Run a single application process unless session affinity is provided; TLS and rate limiting belong at the reverse proxy.

Optional environment variables:

| Variable | Meaning |
|---|---|
| `ENABLED_TOOLS` | `basic` (default), `standard`, `full`, or a comma-separated tool list |
| `WEATHER_UNITS` | `metric` or `imperial` |
| `MCP_TRANSPORT` | `stdio` (default), `http`, or `streamable-http` |
| `MCP_HOST` / `PORT` | HTTP bind address and port; defaults to `127.0.0.1:3000` |
| `MCP_PATH` | Streamable HTTP endpoint; defaults to `/mcp` |
| `MCP_AUTH_TOKEN` | Bearer token for remote MCP access |
| `MCP_PUBLIC_URL` | Public HTTPS origin; required for Google OAuth |
| `MCP_GOOGLE_CLIENT_ID` / `MCP_GOOGLE_CLIENT_SECRET` | Google OAuth web-client credentials |
| `MCP_GOOGLE_ALLOWED_EMAILS` | Required allowlist of verified Google accounts |
| `MCP_OAUTH_STORE_PATH` | OAuth state file; defaults to `~/.weather-mcp/oauth.json` |
| `MCP_ALLOWED_HOSTS` | Optional comma-separated Host-header allowlist |
| `MCP_MAX_SESSIONS` | Maximum concurrent in-memory HTTP sessions; defaults to 100 |
| `MCP_SESSION_TTL_MS` | Idle session expiry; defaults to one hour |
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
