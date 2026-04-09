# DecisionBox Telemetry Worker

Cloudflare Worker that receives anonymous usage telemetry from [DecisionBox](https://github.com/decisionbox-io/decisionbox-platform) instances and stores it in Cloudflare D1.

No PII is collected. See the platform repo's [TELEMETRY.md](https://github.com/decisionbox-io/decisionbox-platform/blob/main/TELEMETRY.md) for full details on what data is collected and how to opt out.

## Security

- **Public API key** -- All requests must include `X-API-Key: dbox_tel_pub_v1_a8f3e2d1c4b5`. This key is not a secret (it's hardcoded in the open-source Go client). Its purpose is to filter out non-DecisionBox traffic and casual abuse.
- **Rate limiting** -- Max 100 events per `install_id` per hour. Exceeding this returns HTTP 429.

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
  -H "X-API-Key: dbox_tel_pub_v1_a8f3e2d1c4b5" \
  -d '{"install_id":"test","version":"0.4.0","events":[{"name":"server_started","timestamp":"2026-04-09T00:00:00Z"}]}'
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/events` | Ingest a batch of telemetry events (requires `X-API-Key` header) |
| `GET` | `/health` | Health check |

## Schema Migration

If you already have the database and need to add the `rate_limits` table:

```bash
wrangler d1 execute decisionbox-telemetry --remote --command "CREATE TABLE IF NOT EXISTS rate_limits (install_id TEXT NOT NULL, window TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (install_id, window));"
```

## License

AGPL-3.0 -- see [LICENSE](LICENSE).
