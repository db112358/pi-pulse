import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
type Phase = "idle" | "prefill" | "streaming" | "waiting" | "tool" | "prompt";
interface Pulse {
	sessionId: string;
	pid: number;
	cwd: string;
	sessionFile?: string;
	andon?: AndonState;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	phase: Phase;
	phaseMs: number;
	tool?: string;
	tps: number;
	tpsLast: number;
	streamTokens?: number;
	streamMs?: number;
	startedAt: number;
	updatedAt: number;
	ctx: {
		tokens: number | null;
		window: number;
		percent: number | null;
	} | null;
}
interface PulseTps {
	sessionId: string;
	tps: number;
	phase: Phase;
	ctx: Pulse["ctx"];
	at: number;
}
interface AndonState {
	light?: string;
	word?: string;
	pulsing?: boolean;
	objective?: string;
}
const WRITE_INTERVAL_MS = 250;
const KEEPALIVE_MS = 2000;
const RATE_WINDOW_MS = 3000;
const INITIAL_TOKENS_PER_CHAR = 0.25;
const CALIBRATION_WEIGHT = 0.3;
function forkFirstTokenMs(message: unknown): number | undefined {
	const value = (
		message as {
			firstTokenMs?: unknown;
		}
	).firstTokenMs;
	return typeof value === "number" ? value : undefined;
}
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}
export default function (pi: ExtensionAPI) {
	const rpc = (
		pi as unknown as {
			rpc?: {
				expose?: (channel: string) => () => void;
			};
		}
	).rpc;
	rpc?.expose?.("pulse:tps");
	let ctx: ExtensionContext | undefined;
	let sessionId = "";
	let sessionFile: string | undefined;
	let startedAt = Date.now();
	let phase: Phase = "idle";
	let phaseSince = Date.now();
	let tool: string | undefined;
	let tpsLast = 0;
	let tokensPerChar = INITIAL_TOKENS_PER_CHAR;
	let modelKey = "";
	let streamChars = 0;
	let firstDeltaAt: number | null = null;
	let samples: {
		at: number;
		chars: number;
	}[] = [];
	let lastWrite = 0;
	let lastCtx: Pulse["ctx"] = null;
	let andon: AndonState | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const path = () => join(agentDir(), "live", `${sessionId}.json`);
	function setPhase(next: Phase, nextTool?: string) {
		if (phase === next && tool === nextTool) return;
		phase = next;
		phaseSince = Date.now();
		tool = nextTool;
	}
	function estimateTps(now: number): number {
		samples = samples.filter((s) => now - s.at <= RATE_WINDOW_MS);
		if (samples.length < 2) return 0;
		const chars = samples.reduce((n, s) => n + s.chars, 0);
		const span = (now - samples[0].at) / 1000;
		return span > 0 ? (chars * tokensPerChar) / span : 0;
	}
	function streamTokens(): number {
		return streamChars * tokensPerChar;
	}
	function noteModel(): void {
		const key = `${ctx?.model?.provider ?? ""}/${ctx?.model?.id ?? ""}`;
		if (key === modelKey) return;
		modelKey = key;
		tokensPerChar = INITIAL_TOKENS_PER_CHAR;
	}
	function write(force = false) {
		if (!ctx || !sessionId) return;
		const now = Date.now();
		if (!force && now - lastWrite < WRITE_INTERVAL_MS) return;
		lastWrite = now;
		noteModel();
		const usage = ctx.getContextUsage();
		if (usage) lastCtx = { tokens: usage.tokens, window: usage.contextWindow, percent: usage.percent };
		const streaming = phase === "streaming";
		const data: Pulse = {
			sessionId,
			pid: process.pid,
			cwd: ctx.cwd,
			sessionFile,
			provider: ctx.model?.provider,
			model: ctx.model?.id,
			thinkingLevel: ctx.thinkingLevel,
			phase,
			phaseMs: now - phaseSince,
			tool,
			tps: streaming ? estimateTps(now) : 0,
			tpsLast,
			streamTokens: streaming ? streamTokens() : 0,
			streamMs: streaming && firstDeltaAt !== null ? now - firstDeltaAt : 0,
			startedAt,
			updatedAt: now,
			ctx: lastCtx,
			andon,
		};
		try {
			const file = path();
			mkdirSync(dirname(file), { recursive: true });
			const tmp = `${file}.tmp`;
			writeFileSync(tmp, JSON.stringify(data));
			renameSync(tmp, file);
		} catch {}
		const tps: PulseTps = { sessionId, tps: data.tps, phase, ctx: lastCtx, at: now };
		pi.events.emit("pulse:tps", tps);
	}
	function reset(next: ExtensionContext) {
		ctx = next;
		sessionId = next.sessionManager.getSessionId();
		sessionFile = next.sessionManager.getSessionFile();
		startedAt = Date.now();
		phase = "idle";
		phaseSince = startedAt;
		tool = undefined;
		tpsLast = 0;
		streamChars = 0;
		firstDeltaAt = null;
		samples = [];
		lastWrite = 0;
		lastCtx = null;
	}
	pi.events.on("andon:state", (data) => {
		andon = data as AndonState;
		write(true);
	});
	pi.on("session_start", (_event, next) => {
		reset(next);
		write(true);
		if (timer) clearInterval(timer);
		timer = setInterval(() => write(), KEEPALIVE_MS);
	});
	pi.on("agent_start", (_event, next) => {
		ctx = next;
		setPhase("prefill");
		streamChars = 0;
		firstDeltaAt = null;
		samples = [];
		write(true);
	});
	pi.on("message_start", (event, next) => {
		ctx = next;
		if (event.message.role !== "assistant") return;
		setPhase("prefill");
		streamChars = 0;
		firstDeltaAt = null;
		samples = [];
		write(true);
	});
	pi.on("message_update", (event, next) => {
		ctx = next;
		const kind = event.assistantMessageEvent.type;
		if (kind !== "text_delta" && kind !== "thinking_delta" && kind !== "toolcall_delta") return;
		const now = Date.now();
		if (firstDeltaAt === null) firstDeltaAt = now;
		if (phase !== "streaming") {
			setPhase("streaming");
			samples = [];
		}
		streamChars += event.assistantMessageEvent.delta.length;
		samples.push({ at: now, chars: event.assistantMessageEvent.delta.length });
		write();
	});
	pi.on("message_end", (event, next) => {
		ctx = next;
		const message = event.message;
		if (message.role !== "assistant") return;
		const output = message.usage.output;
		if (output > 0) {
			if (streamChars > 0) {
				const observed = Math.min(1, Math.max(0.05, output / streamChars));
				tokensPerChar = tokensPerChar * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT;
			}
			const first = forkFirstTokenMs(message);
			const forkDecodeMs =
				first !== undefined && message.durationMs !== undefined && message.durationMs > first
					? message.durationMs - first
					: 0;
			const decodeMs = forkDecodeMs > 0 ? forkDecodeMs : firstDeltaAt !== null ? Date.now() - firstDeltaAt : 0;
			if (decodeMs > 0) tpsLast = output / (decodeMs / 1000);
		}
		setPhase("waiting");
		write(true);
	});
	pi.on("tool_execution_start", (event, next) => {
		ctx = next;
		setPhase("tool", event.toolName);
		write(true);
	});
	pi.on("tool_execution_end", (_event, next) => {
		ctx = next;
		setPhase("waiting");
		write(true);
	});
	pi.on("turn_end", (_event, next) => {
		ctx = next;
		write(true);
	});
	pi.on("ui_prompt_start", (_event, next) => {
		ctx = next;
		setPhase("prompt");
		write(true);
	});
	pi.on("ui_prompt_end", (_event, next) => {
		ctx = next;
		setPhase("waiting");
		write(true);
	});
	pi.on("agent_end", (_event, next) => {
		ctx = next;
		setPhase("idle");
		write(true);
	});
	pi.on("session_shutdown", () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		try {
			unlinkSync(path());
		} catch {}
	});
}
