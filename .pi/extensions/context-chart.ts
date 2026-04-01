import { pathToFileURL } from "node:url";
import type { AgentMessage, AssistantMessage, Usage } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	estimateTokens,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const GLIMPSE_PATH = "/Users/ydai/.npm-global/lib/node_modules/glimpseui/src/glimpse.mjs";
const WINDOW_TITLE = "Session Context Usage";
const EXTENSION_SNAPSHOT_VERSION = 1;

type Snapshot = {
	version: number;
	turn: number;
	systemInstructions: number;
	userInput: number;
	agentOutput: number;
	tools: number;
	memory: number;
	total: number;
	source: "recorded" | "live";
	timestamp?: number;
};

type ChartPayload = {
	points: Snapshot[];
	meta: {
		model: string | null;
		sessionName: string | null;
		sessionFile: string | null;
		contextWindow: number | null;
		currentTotal: number;
		currentPercent: number | null;
		usage: UsageSummary;
		updatedAt: number;
	};
};

type UsageSummary = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

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
			await openOrRefreshWindow(ctx);
			ctx.ui.notify("Context chart opened", "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		recordedSnapshots = buildRecordedSnapshots(ctx);
		liveSnapshot = null;
		await publish(ctx);
	});

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
			const { open } = await import(pathToFileURL(GLIMPSE_PATH).href);
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

function buildRecordedSnapshots(ctx: ExtensionContext): Snapshot[] {
	const branch = ctx.sessionManager.getBranch();
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const systemPrompt = ctx.getSystemPrompt() ?? "";
	const snapshots: Snapshot[] = [];
	let turn = 0;

	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		turn += 1;
		const context = buildSessionContext(entries, entry.parentId ?? null, byId);
		snapshots.push({
			...buildSnapshot(context.messages, systemPrompt, turn, "recorded"),
			timestamp: safeTimestamp(entry.timestamp),
		});
	}

	return snapshots;
}

function buildLiveSnapshot(event: ContextEvent, ctx: ExtensionContext): Snapshot {
	const branch = ctx.sessionManager.getBranch();
	const nextTurn = countAssistantMessages(branch) + 1;
	return buildSnapshot(event.messages, ctx.getSystemPrompt() ?? "", nextTurn, "live");
}

function buildSnapshot(messages: AgentMessage[], systemPrompt: string, turn: number, source: Snapshot["source"]): Snapshot {
	const snapshot: Snapshot = {
		version: EXTENSION_SNAPSHOT_VERSION,
		turn,
		systemInstructions: estimateTextTokens(systemPrompt),
		userInput: 0,
		agentOutput: 0,
		tools: 0,
		memory: 0,
		total: 0,
		source,
	};

	for (const message of messages) {
		const tokens = safeEstimateMessage(message);
		switch (message.role) {
			case "user":
				snapshot.userInput += tokens;
				break;
			case "assistant":
				snapshot.agentOutput += tokens;
				break;
			case "toolResult":
			case "bashExecution":
				snapshot.tools += tokens;
				break;
			case "compactionSummary":
			case "branchSummary":
			case "custom":
				snapshot.memory += tokens;
				break;
			default:
				snapshot.memory += tokens;
		}
	}

	snapshot.total =
		snapshot.systemInstructions +
		snapshot.userInput +
		snapshot.agentOutput +
		snapshot.tools +
		snapshot.memory;

	return snapshot;
}

function buildPayload(ctx: ExtensionContext, recordedSnapshots: Snapshot[], liveSnapshot: Snapshot | null): ChartPayload {
	const points = mergeSnapshots(recordedSnapshots, liveSnapshot);
	const usage = collectUsage(ctx);
	const current = liveSnapshot ?? buildCurrentContextSnapshot(ctx);
	const contextWindow = ctx.model?.contextWindow ?? null;
	const currentPercent = contextWindow && current.total > 0 ? (current.total / contextWindow) * 100 : null;

	return {
		points,
		meta: {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			sessionName: ctx.sessionManager.getSessionName() ?? null,
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			contextWindow,
			currentTotal: current.total,
			currentPercent,
			usage,
			updatedAt: Date.now(),
		},
	};
}

function buildCurrentContextSnapshot(ctx: ExtensionContext): Snapshot {
	const entries = ctx.sessionManager.getEntries() as SessionEntry[];
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const currentContext = buildSessionContext(entries, ctx.sessionManager.getLeafId(), byId);
	const currentTurn = countAssistantMessages(ctx.sessionManager.getBranch());
	return buildSnapshot(currentContext.messages, ctx.getSystemPrompt() ?? "", currentTurn, "recorded");
}

function mergeSnapshots(recorded: Snapshot[], live: Snapshot | null): Snapshot[] {
	const merged = [...recorded];
	if (live) {
		const index = merged.findIndex((point) => point.turn === live.turn);
		if (index >= 0) merged[index] = live;
		else merged.push(live);
	}
	return merged.sort((a, b) => a.turn - b.turn);
}

function collectUsage(ctx: ExtensionContext): UsageSummary {
	const usage: UsageSummary = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message as AssistantMessage;
		usage.input += message.usage?.input ?? 0;
		usage.output += message.usage?.output ?? 0;
		usage.cacheRead += message.usage?.cacheRead ?? 0;
		usage.cacheWrite += message.usage?.cacheWrite ?? 0;
		usage.cost += message.usage?.cost?.total ?? 0;
	}

	return usage;
}

function countAssistantMessages(entries: SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") count += 1;
	}
	return count;
}

function estimateTextTokens(text: string): number {
	if (!text.trim()) return 0;
	return safeEstimateMessage({ role: "user", content: text, timestamp: Date.now() } as AgentMessage);
}

function safeEstimateMessage(message: AgentMessage): number {
	try {
		return Math.max(0, estimateTokens(message));
	} catch {
		return Math.max(0, Math.ceil(extractText(message).length / 4));
	}
}

function extractText(message: AgentMessage): string {
	const parts: string[] = [message.role];
	const anyMessage = message as any;

	if (typeof anyMessage.content === "string") {
		parts.push(anyMessage.content);
	} else if (Array.isArray(anyMessage.content)) {
		for (const block of anyMessage.content) {
			if (block.type === "text") parts.push(block.text ?? "");
			else if (block.type === "thinking") parts.push(block.thinking ?? "");
			else if (block.type === "toolCall") parts.push(block.name ?? "", JSON.stringify(block.arguments ?? {}));
			else parts.push(JSON.stringify(block));
		}
	}

	for (const key of ["toolName", "summary", "command", "customType"]) {
		if (typeof anyMessage[key] === "string") parts.push(anyMessage[key]);
	}

	return parts.join("\n");
}

function safeTimestamp(timestamp: string): number | undefined {
	const value = Date.parse(timestamp);
	return Number.isFinite(value) ? value : undefined;
}

function renderHtml(initialPayload: ChartPayload): string {
	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>${WINDOW_TITLE}</title>
	<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"></script>
	<style>
		:root {
			color-scheme: light dark;
			--bg: #f8fafc;
			--panel: rgba(255,255,255,0.88);
			--border: rgba(15,23,42,0.08);
			--text: #0f172a;
			--muted: #64748b;
			--shadow: 0 18px 50px rgba(15,23,42,0.08);
		}
		@media (prefers-color-scheme: dark) {
			:root {
				--bg: #0b1220;
				--panel: rgba(15,23,42,0.85);
				--border: rgba(148,163,184,0.18);
				--text: #e5eefb;
				--muted: #94a3b8;
				--shadow: 0 18px 50px rgba(2,6,23,0.45);
			}
		}
		* { box-sizing: border-box; }
		body {
			margin: 0;
			padding: 24px;
			font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
			background:
				radial-gradient(circle at top left, rgba(96,165,250,0.12), transparent 30%),
				radial-gradient(circle at top right, rgba(168,85,247,0.14), transparent 32%),
				var(--bg);
			color: var(--text);
		}
		.shell {
			display: flex;
			flex-direction: column;
			gap: 16px;
			height: calc(100vh - 48px);
		}
		.header {
			display: flex;
			justify-content: space-between;
			align-items: flex-start;
			gap: 16px;
		}
		.badge {
			display: inline-flex;
			align-items: center;
			gap: 8px;
			padding: 8px 12px;
			border-radius: 999px;
			background: var(--panel);
			border: 1px solid var(--border);
			box-shadow: var(--shadow);
			color: var(--muted);
			font-size: 13px;
			font-weight: 600;
		}
		.live-dot {
			width: 8px;
			height: 8px;
			border-radius: 999px;
			background: #22c55e;
			box-shadow: 0 0 0 6px rgba(34,197,94,0.14);
		}
		.title h1 {
			margin: 12px 0 6px;
			font-size: 28px;
			line-height: 1.1;
		}
		.title p {
			margin: 0;
			color: var(--muted);
			font-size: 14px;
		}
		.stats {
			display: grid;
			grid-template-columns: repeat(4, minmax(130px, 1fr));
			gap: 12px;
			width: min(760px, 100%);
		}
		.card {
			padding: 14px 16px;
			border-radius: 18px;
			background: var(--panel);
			border: 1px solid var(--border);
			box-shadow: var(--shadow);
			backdrop-filter: blur(18px);
		}
		.card .label {
			display: block;
			font-size: 12px;
			font-weight: 700;
			text-transform: uppercase;
			letter-spacing: 0.08em;
			color: var(--muted);
			margin-bottom: 8px;
		}
		.card .value {
			font-size: 24px;
			font-weight: 700;
		}
		.card .subvalue {
			margin-top: 6px;
			font-size: 12px;
			color: var(--muted);
		}
		.chart-shell {
			flex: 1;
			min-height: 320px;
			padding: 18px 18px 10px;
			border-radius: 24px;
			background: var(--panel);
			border: 1px solid var(--border);
			box-shadow: var(--shadow);
			backdrop-filter: blur(18px);
		}
		.canvas-wrap {
			position: relative;
			height: 100%;
			min-height: 320px;
		}
		.empty {
			display: none;
			position: absolute;
			inset: 0;
			align-items: center;
			justify-content: center;
			text-align: center;
			padding: 24px;
			color: var(--muted);
			font-size: 15px;
		}
		.footer {
			display: flex;
			justify-content: space-between;
			gap: 16px;
			color: var(--muted);
			font-size: 12px;
		}
		.footer span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		@media (max-width: 900px) {
			.header { flex-direction: column; }
			.stats { grid-template-columns: repeat(2, minmax(130px, 1fr)); width: 100%; }
		}
	</style>
</head>
<body>
	<div class="shell">
		<div class="header">
			<div class="title">
				<div class="badge"><span class="live-dot"></span>Live session context</div>
				<h1>Context usage by turn</h1>
				<p id="subtitle">Estimating prompt composition for each model request in the current branch.</p>
			</div>
			<div class="stats">
				<div class="card">
					<span class="label">Current context</span>
					<div class="value" id="currentTotal">—</div>
					<div class="subvalue" id="currentPercent">—</div>
				</div>
				<div class="card">
					<span class="label">Window</span>
					<div class="value" id="contextWindow">—</div>
					<div class="subvalue" id="modelName">—</div>
				</div>
				<div class="card">
					<span class="label">Session usage</span>
					<div class="value" id="sessionUsage">—</div>
					<div class="subvalue" id="sessionCost">—</div>
				</div>
				<div class="card">
					<span class="label">Turns</span>
					<div class="value" id="turnCount">0</div>
					<div class="subvalue" id="sessionName">—</div>
				</div>
			</div>
		</div>
		<div class="chart-shell">
			<div class="canvas-wrap">
				<canvas id="chart"></canvas>
				<div class="empty" id="emptyState">Open this window before or during a conversation to watch context accumulate turn by turn.</div>
			</div>
		</div>
		<div class="footer">
			<span id="sessionFile">No session file</span>
			<span id="updatedAt">Waiting for updates…</span>
		</div>
	</div>
	<script>
		const COLORS = {
			systemInstructions: { stroke: '#8B0000', fill: 'rgba(139,0,0,0.14)' },
			userInput: { stroke: '#4C8DF6', fill: 'rgba(76,141,246,0.18)' },
			agentOutput: { stroke: '#46C86B', fill: 'rgba(70,200,107,0.18)' },
			tools: { stroke: '#B07CF9', fill: 'rgba(176,124,249,0.23)' },
			memory: { stroke: '#F59E0B', fill: 'rgba(245,158,11,0.18)' },
		};

		const fmt = new Intl.NumberFormat();
		const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
		let chart;

		function formatTokens(value) {
			if (value == null || Number.isNaN(value)) return '—';
			if (Math.abs(value) >= 1000) return compactFmt.format(value).toLowerCase();
			return fmt.format(value);
		}

		function formatPercent(value) {
			if (value == null || Number.isNaN(value)) return '—';
			return value.toFixed(1) + '%';
		}

		function buildDatasets(points) {
			return [
				{ key: 'systemInstructions', label: 'System Instructions' },
				{ key: 'userInput', label: 'User Input' },
				{ key: 'agentOutput', label: 'Agent Output' },
				{ key: 'tools', label: 'Tools' },
				{ key: 'memory', label: 'Memory' },
			].map((item) => ({
				label: item.label,
				data: points.map((point) => point[item.key] || 0),
				parsing: false,
				fill: true,
				stack: 'tokens',
				borderColor: COLORS[item.key].stroke,
				backgroundColor: COLORS[item.key].fill,
				borderWidth: 2,
				pointRadius: 3,
				pointHoverRadius: 5,
				tension: 0.28,
			}));
		}

		function ensureChart() {
			if (typeof Chart === 'undefined') return null;
			if (chart) return chart;
			const ctx = document.getElementById('chart');
			chart = new Chart(ctx, {
				type: 'line',
				data: { labels: [], datasets: [] },
				options: {
					animation: false,
					maintainAspectRatio: false,
					interaction: { mode: 'index', intersect: false },
					plugins: {
						legend: {
							position: 'top',
							align: 'end',
							labels: { boxWidth: 12, usePointStyle: true, color: getComputedStyle(document.documentElement).getPropertyValue('--muted') },
						},
						tooltip: {
							callbacks: {
								title(items) {
									return 'Turn ' + items[0].label;
								},
								label(item) {
									return item.dataset.label + ': ' + fmt.format(item.raw || 0) + ' tokens';
								},
								footer(items) {
									const total = items.reduce((sum, item) => sum + (item.raw || 0), 0);
									return 'Total: ' + fmt.format(total) + ' tokens';
								},
							},
						},
					},
					scales: {
						x: {
							stacked: true,
							title: { display: true, text: 'Turn', color: getComputedStyle(document.documentElement).getPropertyValue('--muted') },
							grid: { color: 'rgba(148,163,184,0.12)' },
							ticks: { color: getComputedStyle(document.documentElement).getPropertyValue('--muted') },
						},
						y: {
							stacked: true,
							beginAtZero: true,
							title: { display: true, text: 'Tokens', color: getComputedStyle(document.documentElement).getPropertyValue('--muted') },
							grid: { color: 'rgba(148,163,184,0.12)' },
							ticks: {
								color: getComputedStyle(document.documentElement).getPropertyValue('--muted'),
								callback(value) { return formatTokens(Number(value)); },
							},
						},
					},
				},
			});
			return chart;
		}

		function updateMeta(payload) {
			document.getElementById('currentTotal').textContent = formatTokens(payload.meta.currentTotal);
			document.getElementById('currentPercent').textContent = payload.meta.contextWindow
				? formatPercent(payload.meta.currentPercent) + ' of ' + formatTokens(payload.meta.contextWindow)
				: 'No context window';
			document.getElementById('contextWindow').textContent = payload.meta.contextWindow ? formatTokens(payload.meta.contextWindow) : '—';
			document.getElementById('modelName').textContent = payload.meta.model || 'No model selected';
			document.getElementById('sessionUsage').textContent =
				'↑' + formatTokens(payload.meta.usage.input) + ' ↓' + formatTokens(payload.meta.usage.output);
			document.getElementById('sessionCost').textContent =
				'Cache R' + formatTokens(payload.meta.usage.cacheRead) + ' • W' + formatTokens(payload.meta.usage.cacheWrite) +
				(payload.meta.usage.cost > 0 ? ' • $' + payload.meta.usage.cost.toFixed(4) : '');
			document.getElementById('turnCount').textContent = String(payload.points.length);
			document.getElementById('sessionName').textContent = payload.meta.sessionName || 'Unnamed session';
			document.getElementById('sessionFile').textContent = payload.meta.sessionFile || 'In-memory session';
			document.getElementById('updatedAt').textContent = 'Updated ' + new Date(payload.meta.updatedAt).toLocaleTimeString();
			document.getElementById('subtitle').textContent =
				'Estimating prompt composition for each model request in the current branch.' +
				(payload.points.some((point) => point.source === 'live') ? ' Live point shown for the in-flight request.' : '');
		}

		window.updateChart = function updateChart(payload) {
			updateMeta(payload);
			const empty = document.getElementById('emptyState');
			const instance = ensureChart();
			if (!instance) {
				empty.style.display = 'flex';
				empty.textContent = 'Chart.js failed to load. Check network access, then reopen /context-chart.';
				return;
			}
			empty.style.display = payload.points.length === 0 ? 'flex' : 'none';
			instance.data.labels = payload.points.map((point) => String(point.turn));
			instance.data.datasets = buildDatasets(payload.points);
			instance.update();
		};

		window.updateChart(${JSON.stringify(initialPayload)});
	</script>
</body>
</html>`;
}
