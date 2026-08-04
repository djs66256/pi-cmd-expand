/**
 * End-to-end regression test for the user-message expansion path.
 *
 * The unit tests in `extension.test.mjs` prove that the `message_end`
 * handler returns a replacement message with the right shape. They do
 * NOT prove that the replacement is actually visible to the LLM,
 * because that depends on a contract that lives in pi's source:
 *
 *   1. `runAgentLoop` (agent-loop.js) puts the user message into
 *      `currentContext.messages` BY REFERENCE.
 *   2. It emits `message_end` for that message.
 *   3. `processEvents` (agent.js) pushes the same reference into
 *      `agent._state.messages`.
 *   4. Listeners (incl. `agent-session._handleAgentEvent`) are awaited
 *      BEFORE `runLoop` is called.
 *   5. `agent-session._handleAgentEvent` calls
 *      `extensionRunner.emitMessageEnd`, gets a NEW replacement object,
 *      and applies `_replaceMessageInPlace(event.message, replacement)`
 *      to mutate the original in place.
 *   6. `runLoop` → `streamAssistantResponse` later reads
 *      `currentContext.messages` and hands it to the LLM.
 *
 * This same path is used for BOTH the directly-typed case (the raw
 * `!`cmd`` lands in the user message because there is no `input` hook
 * to rewrite it) and the prompt-template / skill-body case (the body
 * with `!`cmd`` baked in lands in the user message after template
 * expansion). If any of steps 1–6 ever stops holding — e.g. a
 * defensive `structuredClone`, a different message in the LLM
 * context, or the `await emit(...)` becoming a fire-and-forget — the
 * LLM would see the raw `!`cmd`` block even though the unit tests
 * still pass. This regression test replays steps 1–6 against the
 * real extension handler and asserts that the LLM-context messages
 * actually contain the expanded output.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, test } from "node:test";

const require = createRequire(import.meta.url);
const jitiMod = require("jiti");
const jiti = jitiMod.default || jitiMod;
const loader = jiti(import.meta.url, {
	moduleCache: false,
	interopDefault: true,
});
const extMod = await loader.import("../src/index.ts");
const factory = extMod.default;

const handlers = {};
factory({
	on(event, handler) {
		handlers[event] = handler;
	},
});

// Faithful replica of agent-session._replaceMessageInPlace (and
// `extensionRunner.emitMessageEnd` returning a NEW replacement, which
// the agent then mutates in place).
function replaceMessageInPlace(target, replacement) {
	if (target === replacement) return;
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, replacement);
}

async function emitMessageEndLikeRunner(event) {
	const ctx = { cwd: process.cwd() };
	let currentMessage = event.message;
	let modified = false;
	const handler = handlers.message_end;
	if (!handler) return undefined;
	const currentEvent = { ...event, message: currentMessage };
	const result = await handler(currentEvent, ctx);
	if (!result?.message) return undefined;
	if (result.message.role !== currentMessage.role) return undefined;
	currentMessage = result.message;
	modified = true;
	return modified ? currentMessage : undefined;
}

const _ctx = { cwd: process.cwd() };

/**
 * Replay of the user-message code path:
 *   agent-session.prompt() (input + template expand)
 *     → agent.prompt() → runAgentLoop()
 *         → processEvents("message_end", userMessage)
 *         → _handleAgentEvent listener (replacement + in-place)
 *     → runLoop → streamAssistantResponse → LLM(context.messages)
 *
 * The user message that reaches `message_end` always contains the raw
 * `!`cmd`` (no `input` hook rewrites it earlier in the pipeline), so
 * the same replay covers both the directly-typed case and the
 * prompt-template / skill-body case.
 */
async function replayPromptTemplatePath(userMessage, llmSink) {
	// runAgentLoop builds currentContext.messages from snapshot + prompts.
	// Both arrays share the user message by reference.
	const snapshotMessages = [];
	snapshotMessages.push(userMessage);
	const currentContextMessages = [...snapshotMessages, userMessage];

	// agent.js processEvents → push to agent._state.messages (also by ref).
	const agentStateMessages = [];
	agentStateMessages.push(userMessage);

	// emit("message_end", userMessage) → processEvents, then listener.
	const event = { type: "message_end", message: userMessage };

	// 1) processEvents side effect
	// 2) listener: agent-session._handleAgentEvent
	const replacement = await emitMessageEndLikeRunner({
		type: "message_end",
		message: event.message,
	});
	if (replacement) {
		const normalized =
			(replacement.role === "user" ||
				replacement.role === "assistant" ||
				replacement.role === "toolResult" ||
				replacement.role === "custom") &&
			replacement.content == null
				? { ...replacement, content: [] }
				: replacement;
		replaceMessageInPlace(event.message, normalized);
	}

	// runAgentLoop continues: streamAssistantResponse reads currentContext.messages.
	llmSink({
		systemPrompt: "(stub)",
		messages: currentContextMessages,
		agentStateMessages,
	});
}

const TEMPLATE_BODY = [
	"Run this multi-line command and tell me what it prints:",
	"",
	"!```sh",
	'echo "== current user =="; whoami',
	'echo "== uname =="; uname -srm',
	"echo \"== date ==\"; date '+%Y-%m-%d %H:%M:%S %Z'",
	"```",
	"",
	"If you see the three section headers followed by the corresponding values, the fenced form worked.",
].join("\n");

describe("user-message expansion path: LLM must see the expanded text, not the raw !`…` / !``` block", () => {
	test("fenced form: LLM receives the command output", async () => {
		const userMessage = {
			role: "user",
			content: [{ type: "text", text: TEMPLATE_BODY }],
			timestamp: 1700000000000,
		};
		let received = null;
		await replayPromptTemplatePath(userMessage, (llmCtx) => {
			received = llmCtx;
		});
		const seen = received.messages.find((m) => m.role === "user")?.content?.[0]
			?.text;
		assert.ok(seen, "LLM context should still contain a user message");
		assert.doesNotMatch(seen, /!```/, "LLM must NOT see the raw !```sh block");
		// Verify each fenced-block command actually ran by asserting the
		// header is followed by a non-empty value. We intentionally do
		// not match a specific user/architecture string — the test must
		// pass on any environment (macOS dev box, Linux CI runner, …).
		assert.match(seen, /== current user ==\n\S+/);
		assert.match(seen, /== uname ==\n\S+/);
	});

	test("inline form: LLM receives the command output", async () => {
		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "ping: !`echo PONG`" }],
			timestamp: 1700000000000,
		};
		let seen = null;
		await replayPromptTemplatePath(userMessage, (llmCtx) => {
			seen = llmCtx.messages.find((m) => m.role === "user")?.content?.[0]?.text;
		});
		assert.equal(seen, "ping: PONG");
	});

	test("agent state and LLM context both see the expanded text", async () => {
		// Both arrays hold the same object reference, so in-place mutation
		// must propagate to BOTH. If only one is updated, the next turn's
		// _state.messages is stale.
		const userMessage = {
			role: "user",
			content: [{ type: "text", text: "cwd: !`pwd -P`" }],
			timestamp: 1700000000000,
		};
		let ctxForLlm = null;
		await replayPromptTemplatePath(userMessage, (llmCtx) => {
			ctxForLlm = llmCtx;
		});
		assert.equal(
			ctxForLlm.messages[0].content[0].text,
			`cwd: ${require("node:fs").realpathSync(process.cwd())}`,
		);
		assert.equal(
			ctxForLlm.agentStateMessages[0].content[0].text,
			`cwd: ${require("node:fs").realpathSync(process.cwd())}`,
		);
	});
});
