// Serves the built SPA the way Pages does (index.html fallback for deep links
// such as /event/<nevent>) and owns three things the real host does not:
//
// - /_app/env.js: the static build emits its PUBLIC_* values as a separate
//   module, so overriding that one URL points the same build at the fake
//   relays and AI stub without rebuilding.
// - /v1/*: an OpenAI-compatible stub on the app's own origin, so there is no
//   CORS preflight to satisfy.
//
// Port 0 lets parallel runs (worktrees, overnight loops) coexist.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import sirv from 'sirv';

export type AiHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

export interface ServeOptions {
	buildDir: string;
	/** PUBLIC_* values the app reads at boot. `{origin}` in a value is replaced
	 * with this server's origin. */
	env: Record<string, string>;
	/** Return true when the request was handled. */
	ai?: AiHandler;
}

export interface RunningServer {
	url: string;
	close(): Promise<void>;
}

const UNSAFE_PORTS = new Set([10080, 6697]);

async function listenSafe(server: Server): Promise<number> {
	for (let attempt = 0; attempt < 10; attempt++) {
		const listening = Promise.withResolvers<void>();
		const failed = Promise.withResolvers<never>();
		const onError = (error: Error): void => failed.reject(error);
		server.once('error', onError);
		server.listen(0, '127.0.0.1', () => listening.resolve());
		await Promise.race([listening.promise, failed.promise]);
		server.off('error', onError);
		const { port } = server.address() as AddressInfo;
		const unsafe = port < 1024 || (port >= 6665 && port <= 6669) || UNSAFE_PORTS.has(port);
		if (!unsafe) return port;
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
	throw new Error('harness: could not obtain a Chromium-safe port');
}

export async function serveApp(options: ServeOptions): Promise<RunningServer> {
	const files = sirv(options.buildDir, { single: true, dev: true });
	const server: Server = createServer(async (req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (path === '/_app/env.js') {
			const origin = `http://${req.headers.host}`;
			const env = Object.fromEntries(
				Object.entries(options.env).map(([k, v]) => [k, v.replaceAll('{origin}', origin)])
			);
			res.setHeader('content-type', 'text/javascript');
			res.setHeader('cache-control', 'no-store');
			res.end(`export const env=${JSON.stringify(env)}`);
			return;
		}
		if (path.startsWith('/v1/')) {
			if (options.ai !== undefined && (await options.ai(req, res))) return;
			res.statusCode = 404;
			res.end('harness: no AI stub handled this request');
			return;
		}
		files(req, res);
	});
	// Chromium refuses a set of "unsafe" ports (1–1023, 6665–6669, 10080, …).
	// Port 0 can hand one back on some hosts, so retry rather than fail the
	// scene with ERR_UNSAFE_PORT (a real CI flake: 6666/6668).
	const port = await listenSafe(server);
	return {
		url: `http://127.0.0.1:${port}`,
		async close() {
			const closed = Promise.withResolvers<void>();
			server.closeAllConnections();
			server.close(() => closed.resolve());
			await closed.promise;
		}
	};
}
