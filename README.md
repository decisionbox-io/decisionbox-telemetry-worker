# DecisionBox Telemetry Worker

Cloudflare Worker that receives anonymous usage telemetry from [DecisionBox](https://github.com/decisionbox-io/decisionbox-platform) instances and stores it in Cloudflare D1.

No PII is collected. See the platform repo's [TELEMETRY.md](https://github.com/decisionbox-io/decisionbox-platform/blob/main/TELEMETRY.md) for full details on what data is collected and how to opt out.

## Setup

```bash
# Install dependencies
npm install

# Create the D1 database
npm run db:create
# Copy the database_id from the output into wrangler.toml

# Apply the schema
npm run db:migrate

# Deploy
npm run deploy
```

## Custom Domain

After deploying, route `telemetry.decisionbox.io` to the worker:

```bash
wrangler domains add telemetry.decisionbox.io
```

## Local Development

```bash
# Apply schema locally
npm run db:migrate:local

# Start dev server
npm run dev

# Test
curl -X POST http://localhost:8787/v1/events \
  -H "Content-Type: application/json" \
  -d '{"install_id":"test","version":"0.4.0","events":[{"name":"server_started","timestamp":"2026-04-09T00:00:00Z"}]}'
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/events` | Ingest a batch of telemetry events |
| `GET` | `/health` | Health check |

## Security

Optionally restrict access with a bearer token:

```bash
wrangler secret put AUTH_TOKEN
```

The platform sends this token via the `Authorization: Bearer <token>` header when `TELEMETRY_AUTH_TOKEN` is set.

## License

AGPL-3.0 -- see [LICENSE](LICENSE).
