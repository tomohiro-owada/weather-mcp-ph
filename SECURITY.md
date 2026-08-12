# Security Policy

Please report sensitive vulnerabilities through the repository's private GitHub Security Advisory page rather than a public issue:

https://github.com/tomohiro-owada/weather-mcp-ph/security/advisories/new

Do not commit `.env` files, `FIRMS_MAP_KEY`, saved locations, or other personal location data. Analytics are disabled by default. The default Blitzortung community broker uses unencrypted MQTT, so disable the lightning tool or configure a trusted TLS broker if that transport is unsuitable for your environment.
