/**
 * DecisionBox Telemetry Worker
 *
 * Receives anonymous usage telemetry from DecisionBox instances and stores
 * it in Cloudflare D1. No PII is collected — see the platform repo's
 * TELEMETRY.md for full details on what is collected.
 *
 * Security:
 *   - Public API key required (filters out non-DecisionBox traffic)
 *   - Per-install_id rate limiting (max 100 events/hour)
 *
 * Cron:
 *   - Daily at 08:00 UTC — sends aggregated report to Slack
 *
 * Endpoints:
 *   POST /v1/events  — Ingest a batch of telemetry events
 *   GET  /health     — Health check
 */

export interface Env {
	DB: D1Database;
	SLACK_WEBHOOK_URL?: string;
}

// Public API key — not a secret, hardcoded in the open-source Go client.
// Purpose: filter out casual abuse and non-DecisionBox traffic.
const PUBLIC_API_KEY = "dbox_tel_pub_v1_a8f3e2d1c4b5";

// Max events per install_id per hour window
const RATE_LIMIT_PER_HOUR = 100;

interface TelemetryEvent {
	name: string;
	properties?: Record<string, unknown>;
	timestamp: string;
}

interface TelemetryBatch {
	install_id: string;
	version: string;
	go_version: string;
	os: string;
	arch: string;
	service: string;
	events: TelemetryEvent[];
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/health" && request.method === "GET") {
			return new Response(JSON.stringify({ status: "ok" }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		if (url.pathname === "/v1/events" && request.method === "POST") {
			return handleEvents(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},

	async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
		await sendDailyReport(env);
	},
};

// ── Event Ingestion ──────────────────────────────────────────────────────

async function handleEvents(request: Request, env: Env): Promise<Response> {
	// Validate public API key
	const apiKey = request.headers.get("X-API-Key");
	if (apiKey !== PUBLIC_API_KEY) {
		return new Response("Forbidden", { status: 403 });
	}

	let batch: TelemetryBatch;
	try {
		batch = await request.json();
	} catch {
		return new Response("Invalid JSON", { status: 400 });
	}

	if (!batch.install_id || !batch.events || !Array.isArray(batch.events)) {
		return new Response("Missing required fields", { status: 400 });
	}

	// Cap batch size
	const events = batch.events.slice(0, 100);

	// Rate limit check: max RATE_LIMIT_PER_HOUR events per install_id per hour
	const window = new Date().toISOString().slice(0, 13); // "2026-04-09T14"
	const rateLimited = await checkRateLimit(env.DB, batch.install_id, window, events.length);
	if (rateLimited) {
		return new Response(JSON.stringify({ error: "rate limit exceeded" }), {
			status: 429,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Insert events
	const stmt = env.DB.prepare(
		`INSERT INTO events (install_id, version, go_version, os, arch, service, event_name, properties, event_timestamp, received_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
	);

	const stmts = events.map((event) =>
		stmt.bind(
			batch.install_id,
			batch.version || "",
			batch.go_version || "",
			batch.os || "",
			batch.arch || "",
			batch.service || "",
			event.name,
			event.properties ? JSON.stringify(event.properties) : null,
			event.timestamp || new Date().toISOString()
		)
	);

	try {
		await env.DB.batch(stmts);
	} catch (err) {
		console.error("D1 batch insert failed:", err);
		return new Response("Internal Server Error", { status: 500 });
	}

	return new Response(JSON.stringify({ accepted: events.length }), {
		status: 202,
		headers: { "Content-Type": "application/json" },
	});
}

// ── Rate Limiting ────────────────────────────────────────────────────────

async function checkRateLimit(
	db: D1Database,
	installId: string,
	window: string,
	eventCount: number
): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO rate_limits (install_id, window, count)
				 VALUES (?, ?, ?)
				 ON CONFLICT (install_id, window)
				 DO UPDATE SET count = count + ?`
			)
			.bind(installId, window, eventCount, eventCount)
			.run();

		const row = await db
			.prepare(`SELECT count FROM rate_limits WHERE install_id = ? AND window = ?`)
			.bind(installId, window)
			.first<{ count: number }>();

		if (row && row.count > RATE_LIMIT_PER_HOUR) {
			return true;
		}

		await db
			.prepare(`DELETE FROM rate_limits WHERE window < ?`)
			.bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 13))
			.run();

		return false;
	} catch (err) {
		console.error("Rate limit check failed:", err);
		return false;
	}
}

// ── Daily Report ─────────────────────────────────────────────────────────

async function sendDailyReport(env: Env): Promise<void> {
	if (!env.SLACK_WEBHOOK_URL) {
		console.log("SLACK_WEBHOOK_URL not set — skipping daily report");
		return;
	}

	const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

	// Unique installs active yesterday
	const activeInstalls = await env.DB
		.prepare(`SELECT COUNT(DISTINCT install_id) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day')`)
		.bind(yesterday, yesterday)
		.first<{ count: number }>();

	// Total events yesterday
	const totalEvents = await env.DB
		.prepare(`SELECT COUNT(*) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day')`)
		.bind(yesterday, yesterday)
		.first<{ count: number }>();

	// Events by type
	const eventsByType = await env.DB
		.prepare(`SELECT event_name, COUNT(*) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day') GROUP BY event_name ORDER BY count DESC`)
		.bind(yesterday, yesterday)
		.all<{ event_name: string; count: number }>();

	// Versions in use
	const versions = await env.DB
		.prepare(`SELECT version, COUNT(DISTINCT install_id) as installs FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day') AND version != '' GROUP BY version ORDER BY installs DESC LIMIT 5`)
		.bind(yesterday, yesterday)
		.all<{ version: string; installs: number }>();

	// Top warehouse providers
	const warehouses = await env.DB
		.prepare(`SELECT json_extract(properties, '$.warehouse_provider') as provider, COUNT(*) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day') AND json_extract(properties, '$.warehouse_provider') IS NOT NULL GROUP BY provider ORDER BY count DESC LIMIT 5`)
		.bind(yesterday, yesterday)
		.all<{ provider: string; count: number }>();

	// Top LLM providers
	const llms = await env.DB
		.prepare(`SELECT json_extract(properties, '$.llm_provider') as provider, COUNT(*) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day') AND json_extract(properties, '$.llm_provider') IS NOT NULL GROUP BY provider ORDER BY count DESC LIMIT 5`)
		.bind(yesterday, yesterday)
		.all<{ provider: string; count: number }>();

	// Top domains
	const domains = await env.DB
		.prepare(`SELECT json_extract(properties, '$.domain') as domain, COUNT(*) as count FROM events WHERE received_at >= ? AND received_at < datetime(?, '+1 day') AND json_extract(properties, '$.domain') IS NOT NULL GROUP BY domain ORDER BY count DESC LIMIT 5`)
		.bind(yesterday, yesterday)
		.all<{ domain: string; count: number }>();

	// All-time unique installs
	const allTimeInstalls = await env.DB
		.prepare(`SELECT COUNT(DISTINCT install_id) as count FROM events`)
		.first<{ count: number }>();

	// Build Slack message
	const eventsTable = (eventsByType.results || [])
		.map((r) => `  ${r.event_name}: *${r.count}*`)
		.join("\n") || "  (none)";

	const versionsTable = (versions.results || [])
		.map((r) => `  ${r.version}: ${r.installs} install${r.installs !== 1 ? "s" : ""}`)
		.join("\n") || "  (none)";

	const warehousesTable = (warehouses.results || [])
		.map((r) => `  ${r.provider}: ${r.count}`)
		.join("\n") || "  (none)";

	const llmsTable = (llms.results || [])
		.map((r) => `  ${r.provider}: ${r.count}`)
		.join("\n") || "  (none)";

	const domainsTable = (domains.results || [])
		.map((r) => `  ${r.domain}: ${r.count}`)
		.join("\n") || "  (none)";

	const message = {
		blocks: [
			{
				type: "header",
				text: {
					type: "plain_text",
					text: `DecisionBox Telemetry — ${yesterday}`,
				},
			},
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Active Installs*\n${activeInstalls?.count ?? 0}` },
					{ type: "mrkdwn", text: `*Total Events*\n${totalEvents?.count ?? 0}` },
					{ type: "mrkdwn", text: `*All-Time Installs*\n${allTimeInstalls?.count ?? 0}` },
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Events by Type*\n${eventsTable}`,
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Versions*\n${versionsTable}`,
				},
			},
			{
				type: "section",
				fields: [
					{ type: "mrkdwn", text: `*Warehouses*\n${warehousesTable}` },
					{ type: "mrkdwn", text: `*LLM Providers*\n${llmsTable}` },
				],
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `*Domains*\n${domainsTable}`,
				},
			},
			{
				type: "context",
				elements: [
					{ type: "mrkdwn", text: "Sent by DecisionBox Telemetry Worker" },
				],
			},
		],
	};

	const resp = await fetch(env.SLACK_WEBHOOK_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(message),
	});

	if (!resp.ok) {
		console.error(`Slack webhook failed: ${resp.status} ${await resp.text()}`);
	}
}
