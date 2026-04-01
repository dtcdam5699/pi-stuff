import type { AgentMessage, AssistantMessage } from "@mariozechner/pi-ai";
import {
	buildSessionContext,
	estimateTokens,
	type ContextEvent,
	type ExtensionContext,
	type SessionEntry,
} from "@mariozechner/pi-coding-agent";

const EXTENSION_SNAPSHOT_VERSION = 1;

export type Snapshot = {
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

export type UsageSummary = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
};

export type ChartPayload = {
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

export function buildRecordedSnapshots(ctx: ExtensionContext): Snapshot[] {
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

export function buildLiveSnapshot(event: ContextEvent, ctx: ExtensionContext): Snapshot {
	const branch = ctx.sessionManager.getBranch();
	const nextTurn = countAssistantMessages(branch) + 1;
	return buildSnapshot(event.messages, ctx.getSystemPrompt() ?? "", nextTurn, "live");
}

export function buildPayload(ctx: ExtensionContext, recordedSnapshots: Snapshot[], liveSnapshot: Snapshot | null): ChartPayload {
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
