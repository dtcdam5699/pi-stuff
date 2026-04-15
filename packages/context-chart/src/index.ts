import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildRecordedSnapshots, buildLiveSnapshot, buildPayload, type Snapshot, type ChartPayload } from "./data.ts";
import { renderHtml } from "./ui.ts";

const WINDOW_TITLE = "Session Context Usage";
const require = createRequire(import.meta.url);
let cachedGlimpsePath: string | null = null;

function run(command: string, args: string[]): string | null {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function resolveGlimpsePath(): string {
	if (cachedGlimpsePath) return cachedGlimpsePath;

	const envPath = process.env.GLIMPSE_PATH;
	if (envPath && existsSync(envPath)) {
		cachedGlimpsePath = envPath;
		return cachedGlimpsePath;
	}

	for (const specifier of ["glimpseui", "glimpseui/src/glimpse.mjs"]) {
		try {
			const resolved = require.resolve(specifier);
			if (existsSync(resolved)) {
				cachedGlimpsePath = resolved;
				return cachedGlimpsePath;
			}
		} catch {
			// Try the next strategy.
		}
	}

	const globalNodeModulesDirs = new Set<string>();
	const npmPrefix = process.env.npm_config_prefix ?? process.env.PREFIX;
	if (npmPrefix) {
		globalNodeModulesDirs.add(path.join(npmPrefix, "node_modules"));
		globalNodeModulesDirs.add(path.join(npmPrefix, "lib", "node_modules"));
	}

	const nodePath = process.env.NODE_PATH;
	if (nodePath) {
		for (const dir of nodePath.split(path.delimiter)) {
			if (dir) globalNodeModulesDirs.add(dir);
		}
	}

	const npmRoot = run("npm", ["root", "-g"]);
	if (npmRoot) globalNodeModulesDirs.add(npmRoot);

	const pnpmRoot = run("pnpm", ["root", "-g"]);
	if (pnpmRoot) globalNodeModulesDirs.add(pnpmRoot);

	const yarnGlobalDir = run("yarn", ["global", "dir"]);
	if (yarnGlobalDir) globalNodeModulesDirs.add(path.join(yarnGlobalDir, "node_modules"));

	for (const dir of globalNodeModulesDirs) {
		const candidate = path.join(dir, "glimpseui", "src", "glimpse.mjs");
		if (existsSync(candidate)) {
			cachedGlimpsePath = candidate;
			return cachedGlimpsePath;
		}
	}

	throw new Error(
		"Could not find Glimpse. Install `glimpseui` where Node can resolve it, or set GLIMPSE_PATH to .../glimpseui/src/glimpse.mjs.",
	);
}

type GlimpseWindow = {
	on(event: "ready", handler: () => void): void;
	on(event: "closed", handler: () => void): void;
	send(js: string): void;
	close(): void;
};

export default function (pi: ExtensionAPI) {
	let recordedSnapshots: Snapshot[] = [];
	let liveSnapshot: Snapshot | null = null;
	let windowRef: GlimpseWindow | null = null;
	let windowReady = false;
	let lastPayload: ChartPayload | null = null;

	pi.registerCommand("context-chart", {
		description: "Open a live context usage chart in Glimpse",
		handler: async (args, ctx) => {
			const command = args.trim().toLowerCase();

			if (command === "close") {
				closeWindow();
				ctx.ui.notify("Context chart closed", "info");
				return;
			}

			recordedSnapshots = buildRecordedSnapshots(ctx);
			liveSnapshot = null;

			try {
				await openOrRefreshWindow(ctx);
				ctx.ui.notify("Context chart opened", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to open context chart: ${message}`, "info");
			}
		},
	});

	async function handleSessionUpdate(_event: unknown, ctx: ExtensionContext) {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	}

	pi.on("session_start", handleSessionUpdate);
	pi.on("session_switch", handleSessionUpdate);
	pi.on("session_fork", handleSessionUpdate);
	pi.on("session_compact", handleSessionUpdate);
	pi.on("session_tree", handleSessionUpdate);
	pi.on("turn_end", handleSessionUpdate);

	pi.on("model_select", async (_event, ctx) => {
		await publish(ctx);
	});

	pi.on("context", async (event, ctx) => {
		liveSnapshot = buildLiveSnapshot(event, ctx);
		await publish(ctx);
	});

	pi.on("session_shutdown", async () => {
		closeWindow();
	});

	function closeWindow() {
		if (windowRef) {
			windowRef.close();
		}
		windowRef = null;
		windowReady = false;
	}

	async function openOrRefreshWindow(ctx: ExtensionContext) {
		if (!windowRef) {
			const glimpsePath = resolveGlimpsePath();
			const { open } = await import(pathToFileURL(glimpsePath).href);
			lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
			const win = open(renderHtml(lastPayload), {
				width: 1280,
				height: 760,
				title: WINDOW_TITLE,
			});

			windowRef = win as GlimpseWindow;
			windowReady = false;

			windowRef.on("ready", () => {
				windowReady = true;
				if (lastPayload && windowRef) {
					windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
				}
			});

			windowRef.on("closed", () => {
				windowRef = null;
				windowReady = false;
			});
			return;
		}

		await publish(ctx);
	}

	async function publish(ctx: ExtensionContext) {
		lastPayload = buildPayload(ctx, recordedSnapshots, liveSnapshot);
		if (!windowRef || !windowReady) return;
		windowRef.send(`window.updateChart(${JSON.stringify(lastPayload)})`);
	}
}
