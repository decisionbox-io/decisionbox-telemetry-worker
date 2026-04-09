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
 * Endpoints:
 *   POST /v1/events  — Ingest a batch of telemetry events
 *   GET  /health     — Health check
 */

export interface Env {
	DB: D1Database;
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
};

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

/**
 * Check and update rate limit for an install_id.
 * Returns true if the request should be rejected.
 */
async function checkRateLimit(
	db: D1Database,
	installId: string,
	window: string,
	eventCount: number
): Promise<boolean> {
	try {
		// Upsert the counter and return the new total
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

		// Cleanup old windows (keep last 2 hours only)
		await db
			.prepare(`DELETE FROM rate_limits WHERE window < ?`)
			.bind(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().slice(0, 13))
			.run();

		return false;
	} catch (err) {
		// If rate limiting fails, allow the request (don't block telemetry)
		console.error("Rate limit check failed:", err);
		return false;
	}
}
