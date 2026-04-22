import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createBashTool, isBashToolResult } from "@mariozechner/pi-coding-agent";

const ANSI_ESCAPE_RE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export default function noAnsiExtension(pi: ExtensionAPI) {
	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command,
			cwd,
			env: {
				...env,
				NO_COLOR: "1",
				CLICOLOR: "0",
				FORCE_COLOR: "0",
				TERM: "dumb",
			},
		}),
	});

	pi.registerTool(bashTool);

	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event)) return;

		return {
			content: event.content.map((item) => {
				if (item.type !== "text") return item;
				return {
					...item,
					text: sanitizeTerminalText(item.text),
				};
			}),
		};
	});
}

function sanitizeTerminalText(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
