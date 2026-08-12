# Contributing

Contributions that improve Philippine weather coverage, source transparency, and reliability are welcome.

## Development

```bash
npm ci
npm test
npm run build
```

Please add focused tests for behavior changes. Network-dependent checks should not be part of the default unit suite.

## Data-source rules

- Prefer official PAGASA feeds where one exists.
- Clearly distinguish observations, model output, community data, and satellite detections.
- Do not infer flood stages, wildfire confirmation, evacuation status, or other safety-critical facts that a source does not provide.
- Document authentication requirements and upstream limitations in `README.md`.
- Keep US-only providers out of this Philippines edition.

Open a pull request with the problem, data source, limitations, and verification performed.
