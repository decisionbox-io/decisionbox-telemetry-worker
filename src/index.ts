/**
 * DecisionBox Telemetry Worker
 *
 * Receives anonymous usage telemetry from DecisionBox instances and stores
 * it in Cloudflare D1. No PII is collected — see the platform repo's
 * TELEMETRY.md for full details on what is collected.
 *
 * Endpoints:
 *   POST /v1/events  — Ingest a batch of telemetry events
 *   GET  /health     — Health check
 */

export interface Env {
	DB: D1Database;
	AUTH_TOKEN?: string;
}

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
	// Optional auth token validation
	if (env.AUTH_TOKEN) {
		const auth = request.headers.get("Authorization");
		if (auth !== `Bearer ${env.AUTH_TOKEN}`) {
			return new Response("Unauthorized", { status: 401 });
		}
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

	// Cap batch size to prevent abuse
	const events = batch.events.slice(0, 100);

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
