/**
 * End-to-end tests for the pi-cmd-expand extension.
 *
 * Run with: node --test test/
 *
 * Uses the built-in `node:test` runner (Node 20+) so there is no
 * extra test-framework dependency. The extension is a TypeScript
 * file, so we load it through jiti (already a devDep) and exercise
 * each event handler with a hand-built ExtensionAPI stub.
 */

import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
assert.equal(
	typeof factory,
	"function",
	"src/index.ts must default-export a factory function",
);

const handlers = {};
factory({
	on(event, handler) {
		handlers[event] = handler;
	},
});

// Hooks this extension DOES register (expansion paths).
for (const event of ["message_end", "before_agent_start", "session_start"]) {
	assert.equal(
		typeof handlers[event],
		"function",
		`${event} handler must be registered by the extension`,
	);
}

// Hooks this extension deliberately does NOT register. These cover all
// the boundaries that lock the scope: a stray registration on any of
// these would break pi's native behaviour or change the contract.
for (const event of ["input", "user_bash", "tool_call", "tool_result"]) {
	assert.equal(
		handlers[event],
		undefined,
		`${event} handler must NOT be registered -- see "What is NOT expanded" in the README`,
	);
}

// Point `getAgentDir()` at a clean temp dir so any real config file
// under `~/.pi/agent/pi-cmd-expand.json` on the test host can't leak
// into the suite. We restore the previous value (if any) in a final
// hook so subprocesses started by `npm test` don't see a stale env.
const globalAgentDir = mkdtempSync(join(tmpdir(), "pi-cmd-expand-agentdir-"));
process.env.PI_CODING_AGENT_DIR = globalAgentDir;
process.on("exit", () => {
	try {
		rmSync(globalAgentDir, { recursive: true, force: true });
	} catch {
		// Best-effort; the OS will reclaim tmp files on reboot.
	}
});

const ctx = { cwd: process.cwd() };

// ---------------------------------------------------------------------------
// message_end: `!cmd` after template / skill expansion
// ---------------------------------------------------------------------------
// The single expansion path for user input. Catches both directly-typed
// `!cmd` (where the agent-session prompt flow lands the raw `!cmd` in
// the user message because there is no longer an `input` hook to
// rewrite it) and `!cmd` baked into a prompt-template / skill body
// (where the body only materialises into the user message after
// template expansion, so no pre-expansion hook could see it).
// ---------------------------------------------------------------------------
// message_end: post-template / post-skill user message
// (Also covers the directly-typed case now that the `input` hook is
// removed -- the unexpanded `!cmd` lands in the user message and is
// expanded here, just like for a prompt template body.)
// ---------------------------------------------------------------------------

describe("message_end (`!cmd` after template / skill expansion, or directly typed)", () => {
	test("fenced form in a template-expanded user message is expanded", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "before\n!```sh\necho F\n```\nafter",
						},
					],
				},
			},
			ctx,
		);
		assert.ok(r?.message, "message_end should return a replacement message");
		const newText = r.message.content[0].text;
		assert.equal(
			newText,
			'before\n<cmd source="echo F" lang="sh">F</cmd>\nafter',
		);
		assert.doesNotMatch(newText, /!```/);
	});

	test("bash fenced form is expanded", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{ type: "text", text: "before\n!```bash\necho B\n```\nafter" },
					],
				},
			},
			ctx,
		);
		assert.equal(
			r.message.content[0].text,
			'before\n<cmd source="echo B" lang="bash">B</cmd>\nafter',
		);
	});
	test("directly-typed inline form is also expanded (no separate `input` hook)", async () => {
		// After the `input` hook was removed, a directly-typed `!`cmd``
		// lands in the user message verbatim and is expanded by
		// `message_end` in place. The LLM still sees the expanded text.
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "check: !`echo MID`" }],
				},
			},
			ctx,
		);
		assert.equal(
			r.message.content[0].text,
			'check: <cmd source="echo MID">MID</cmd>',
		);
	});

	test("text without `!` -- no-op", async () => {
		// Plain text with no `!` is not a cmd-expand pattern; we leave it
		// alone. (This is also what the post-`input`-expansion state used
		// to look like before the hook was removed.)
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "result: X" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("assistant message -- skipped (we only expand user messages)", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "!`echo SHOULD_NOT_RUN`" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("toolResult message -- skipped", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "toolResult",
					content: [{ type: "text", text: "!`echo SHOULD_NOT_RUN`" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("image-only content -- skipped safely", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("multiple inline `!cmd` occurrences all replaced", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`echo A` and !`echo B`" }],
				},
			},
			ctx,
		);
		assert.equal(
			r.message.content[0].text,
			'<cmd source="echo A">A</cmd> and <cmd source="echo B">B</cmd>',
		);
	});

	test("replacement message preserves non-text fields (timestamp, id)", async () => {
		const original = {
			role: "user",
			content: [{ type: "text", text: "!`echo keep-meta`" }],
			timestamp: 1700000000000,
			id: "msg-123",
		};
		const r = await handlers.message_end({ message: original }, ctx);
		assert.equal(r.message.role, "user");
		assert.equal(r.message.timestamp, 1700000000000);
		assert.equal(r.message.id, "msg-123");
		assert.equal(
			r.message.content[0].text,
			'<cmd source="echo keep-meta">keep-meta</cmd>',
		);
	});
});

// ---------------------------------------------------------------------------
// before_agent_start: AGENTS.md / CLAUDE.md content
// ---------------------------------------------------------------------------

describe("before_agent_start (context file expansion)", () => {
	test("AGENTS.md-style block substituted", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "files: !`echo alpha` !`echo beta`";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /alpha/);
			assert.match(r.systemPrompt, /beta/);
			assert.doesNotMatch(r.systemPrompt, /!`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("no context files -- no-op", async () => {
		const r = await handlers.before_agent_start(
			{ systemPrompt: "no files", systemPromptOptions: {} },
			ctx,
		);
		assert.equal(r, undefined);
	});

	test("context file without `!` -- no-op", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "static content with no commands";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.equal(
				r,
				undefined,
				"should not change systemPrompt when no `!` is present",
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Truncation: command output > 2 000 bytes
// ---------------------------------------------------------------------------

describe("truncation (output > 2000 bytes)", () => {
	test("message_end: oversized command tail-truncated, full saved to temp file", async () => {
		// Generate ~4 KB of output (well above the 2000-byte cap).
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{ type: "text", text: "data: !`printf 'A%.0s' {1..4000}`" },
					],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.match(out, /\[Output truncated/);
		assert.doesNotMatch(out, /!`/);
		assert.ok(
			out.length < 4000 + 200,
			"inline text must be smaller than the raw 4KB",
		);
		// The full output path is embedded in the truncation footer.
		// (os.tmpdir() differs by platform -- `/tmp` on Linux, a
		// per-user `/var/folders/.../T` on macOS, etc.)
		const m = out.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
		assert.ok(m, "footer must include the temp file path");
		const full = readFileSync(m[1], "utf-8");
		assert.equal(full.length, 4000);
		unlinkSync(m[1]);
	});

	test("message_end: small command not truncated", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "data: !`echo tiny`" }],
				},
			},
			ctx,
		);
		assert.equal(
			r.message.content[0].text,
			'data: <cmd source="echo tiny">tiny</cmd>',
		);
		assert.doesNotMatch(r.message.content[0].text, /\[Output truncated/);
	});

	test("before_agent_start: oversized command gets truncation footer in system prompt", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "blob: !`printf 'C%.0s' {1..4000}`";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /\[Output truncated/);
			assert.doesNotMatch(r.systemPrompt, /!`/);
			// Temp file path is platform-dependent (see note above).
			const m = r.systemPrompt.match(
				/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/,
			);
			if (m) unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Timeout: default 5 s
// ---------------------------------------------------------------------------

describe("timeout (default 5 s)", () => {
	test("slow message_end command times out and is reported inline, never throws", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "wait: !`sleep 8 && echo DONE`" }],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		// Source attribute echoes the command verbatim (so the LLM knows
		// what was run) -- DONE shows up there. The assertion is about
		// the BODY of the wrap, not the source attribute: the timeout
		// must have killed the process before `echo DONE` ran, so DONE
		// must not appear between `>...</cmd>`.
		const body = out.replace(/<cmd[^>]*>/, "").replace(/<\/cmd>$/, "");
		assert.doesNotMatch(
			body,
			/DONE/,
			"the 8s command must be killed before it can echo DONE",
		);
		assert.match(out, /command failed/);
		assert.match(out, /timed out after 5000ms/);
	});
});

// ---------------------------------------------------------------------------
// Wrap format: <cmd>/<file> tags + source truncation + status attrs
// ---------------------------------------------------------------------------
// Every expansion is wrapped in `<cmd ...>...</cmd>` or `<file ...>...</file>`
// so the LLM can tell which content was generated and where it came
// from. The `source` attribute on `<cmd>` is truncated to 20 chars;
// `path` on `<file>` is preserved verbatim. Status attributes
// (`status="failed" exit-code="N"`, `status="truncated" inline-size=N
// total-size=M`, `status="circular"`) are added when something went
// wrong; the body still carries the human-readable marker.
// ---------------------------------------------------------------------------

describe("wrap format (<cmd>/<file> tags)", () => {
	test("inline `!`cmd`` uses single-line inline wrap when output is one line", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`echo single`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		// Tag, content, tag — all on one line.
		assert.equal(out, '<cmd source="echo single">single</cmd>');
	});

	test("inline `!`cmd`` uses multi-line wrap when output spans multiple lines", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`echo l1; echo l2`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		// Open tag on its own line, content in the middle, close tag on its own line.
		assert.match(out, /^<cmd source="echo l1; echo l2">\n/);
		assert.match(out, /\n<\/cmd>$/);
		assert.match(out, /l1\nl2/);
	});

	test("fenced `!```sh` keeps the lang attribute and uses multi-line wrap for multi-line output", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!```sh\necho l1; echo l2\n```" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /^<cmd source="echo l1; echo l2" lang="sh">\n/);
		assert.match(out, /\n<\/cmd>$/);
	});

	test("fenced `!```sh` keeps the lang attribute and uses inline wrap for single-line output", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!```sh\necho fenced\n```" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.equal(out, '<cmd source="echo fenced" lang="sh">fenced</cmd>');
	});

	test("source attribute is truncated to ≤20 chars (with trailing `...` indicator)", async () => {
		const long = "!`echo aaaaaaaaaaaaaaa bbbbbbbbbbbbbbb ccccccccccccccc`";
		const r = await handlers.message_end(
			{ message: { role: "user", content: [{ type: "text", text: long }] } },
			ctx,
		);
		const out = r.message.content[0].text;
		const m = out.match(/source="([^"]+)"/);
		assert.ok(m, "must have a source attribute");
		assert.ok(
			m[1].length <= 20,
			`source must be ≤20 chars, got ${m[1].length}: "${m[1]}"`,
		);
		assert.ok(m[1].endsWith("..."), "truncated source must end with `...`");
	});

	test("source attribute at exactly 20 chars is NOT truncated", async () => {
		// "echo 123456789012345" is 20 chars — at the cap, not over it.
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`echo 123456789012345`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /source="echo 123456789012345"/);
		assert.doesNotMatch(out, /\.\.\."/);
	});

	test("fenced command: source uses only the first line of the body", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [
						{
							type: "text",
							text: "!```sh\necho FIRST\necho SECOND\n```",
						},
					],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /source="echo FIRST"/);
		// SECOND shows up in the body (the command ran both lines), but
		// NOT in the source attribute.
		const m = out.match(/source="([^"]+)"/);
		assert.ok(m);
		assert.doesNotMatch(m[1], /SECOND/);
	});

	test('failed command gets status="failed" exit-code="N" attributes', async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`sh -c 'echo p; exit 9'`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /status="failed"/);
		assert.match(out, /exit-code="9"/);
		assert.match(out, /\[command failed: exit code 9\]/);
	});

	test('truncated command gets status="truncated" inline-size total-size attributes', async () => {
		// 4 KB output, way above the 2 KB cap.
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "!`printf 'A%.0s' {1..4000}`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /status="truncated"/);
		assert.match(out, /inline-size="\d+"/);
		assert.match(out, /total-size="\d+"/);
		assert.match(out, /\[Output truncated/);
	});

	test("inline `` @`path` `` uses single-line wrap when file content is one line", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "one-line.md");
			writeFileSync(file, "ONLY-ONE");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.equal(
				r.message.content[0].text,
				`<file path="${file}">ONLY-ONE</file>`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `` @`path` `` uses multi-line wrap when file has multiple lines", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "multi-line.md");
			writeFileSync(file, "line 1\nline 2\nline 3");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, new RegExp(`^<file path="${file}">\n`));
			assert.match(out, /\n<\/file>$/);
			assert.match(out, /line 1\nline 2\nline 3/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('missing file gets status="failed" error="..." attributes', async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "@`./no-such-file.md`" }],
				},
			},
			ctx,
		);
		const out = r.message.content[0].text;
		assert.match(out, /status="failed"/);
		assert.match(out, /error="ENOENT/);
		assert.match(out, /\[file failed: ENOENT/);
	});

	test('truncated file gets status="truncated" attributes', async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "big.md");
			writeFileSync(file, "Q".repeat(15_000));
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, new RegExp(`path="${file}"`));
			assert.match(out, /status="truncated"/);
			assert.match(out, /\[Output truncated/);
			const m = out.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
			if (m) unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test('circular file reference gets status="circular" attribute', async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "circ-a.md");
			const b = join(tmp, "circ-b.md");
			writeFileSync(a, "a-start\n@`" + b + "`\na-end");
			writeFileSync(b, "b-start\n@`" + a + "`\nb-end");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${a}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /status="circular"/);
			assert.match(out, /\[file skipped: circular reference/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("fenced multi-file: each file gets its own <file> wrap, no === header", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "a.md");
			const b = join(tmp, "b.md");
			writeFileSync(a, "AAA");
			writeFileSync(b, "BBB");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`\`\`\n${a}\n${b}\n\`\`\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			// No `=== ... ===` header anymore -- the path is in the tag.
			assert.doesNotMatch(out, /^=== /m);
			// Two separate wraps.
			const wraps = out.match(/<file path="/g) ?? [];
			assert.equal(wraps.length, 2);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// @`path` / @```...``` : file reference expansion
// ---------------------------------------------------------------------------
// Inline form: @`path/to/file` (backtick-delimited, supports spaces).
// Fenced form: @```lang\npath1\npath2\n```  (one-or-more files, lang
// tag optional and ignored). Inline is bare content; fenced labels
// each file with `=== path ===`. Recursion: a file loaded via @`path`
// is itself run through `expandText`, so any further `!` / `@` patterns
// inside it are resolved. Depth-capped at 10; cycles are short-circuited
// via a per-chain visited set.
// ---------------------------------------------------------------------------

describe("message_end (`@`path` -- inline file reference)", () => {
	test("inline `@`path`` reads the file and inlines the content", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "hello.txt");
			writeFileSync(file, "Hello, world!");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `before @\`${file}\` after` }],
					},
				},
				ctx,
			);
			assert.ok(r?.message);
			assert.equal(
				r.message.content[0].text,
				`before <file path="${file}">Hello, world!</file> after`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@`path` with spaces in the path works", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "my notes.md");
			writeFileSync(file, "spaced content");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `see @\`${file}\` here` }],
					},
				},
				ctx,
			);
			assert.equal(
				r.message.content[0].text,
				`see <file path="${file}">spaced content</file> here`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@`path`` with absolute path uses it verbatim", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "abs.md");
			writeFileSync(file, "abs content");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.equal(
				r.message.content[0].text,
				`<file path="${file}">abs content</file>`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("file not found is reported inline as `[file failed: ENOENT: ...]`", async () => {
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "@`/no/such/file/missing.md`" }],
				},
			},
			ctx,
		);
		assert.ok(r?.message);
		const out = r.message.content[0].text;
		assert.match(out, /\[file failed: ENOENT/);
		// Must NOT throw -- the extension never aborts a turn on a bad
		// `@path` reference.
		assert.doesNotMatch(out, /throw/);
	});

	test("directory reference is reported inline as `[file failed: EISDIR: ...]`", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${tmp}\`` }],
					},
				},
				ctx,
			);
			assert.match(r.message.content[0].text, /\[file failed: EISDIR/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("email-like text `user@`example.com`` is NOT matched (lookbehind)", async () => {
		// The `(?<!\\w)` lookbehind refuses to match `@` preceded by a
		// word char, so `user@`example.com`` is left alone. (The intent
		// is to avoid false positives on email addresses; without the
		// lookbehind, the regex would eagerly grab `example.com` as a
		// file path.)
		const r = await handlers.message_end(
			{
				message: {
					role: "user",
					content: [{ type: "text", text: "ping user@`example.com` today" }],
				},
			},
			ctx,
		);
		assert.equal(r, undefined, "email-like text must not trigger expansion");
	});

	test("inline `@` after whitespace / start-of-string still matches", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "a.md");
			writeFileSync(file, "OK");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `text @\`${file}\` end` }],
					},
				},
				ctx,
			);
			assert.equal(
				r.message.content[0].text,
				`text <file path="${file}">OK</file> end`,
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("message_end (`@```...``` `-- fenced file reference, multi-file)", () => {
	test("fenced form reads each path and labels with `=== path ===`", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const fileA = join(tmp, "a.md");
			const fileB = join(tmp, "b.md");
			writeFileSync(fileA, "AAA");
			writeFileSync(fileB, "BBB");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n${fileA}\n${fileB}\n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /<file path=/);
			assert.match(out, /AAA/);
			assert.match(out, /BBB/);
			assert.doesNotMatch(out, /@```/);
			// Fenced form preserves order and labels each entry with its
			// own <file path="..."> wrapper.
			assert.ok(
				out.indexOf("AAA") < out.indexOf("BBB"),
				"paths must appear in the order listed in the fenced body",
			);
			// Two separate wraps, one per file.
			const wraps = out.match(/<file path=/g) ?? [];
			assert.equal(wraps.length, 2);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("blank lines and whitespace-only lines in the fenced body are skipped", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "only.md");
			writeFileSync(file, "ONLY");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n\n   \n${file}\n\n   \n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /ONLY/);
			// Only one <file> wrap -- blank lines didn't spawn phantom
			// blocks.
			const wraps = out.match(/<file path=/g) ?? [];
			assert.equal(wraps.length, 1);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("fenced form with language tag (ignored) works the same", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "tagged.md");
			writeFileSync(file, "tagged body");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`\`\`md\n${file}\n\`\`\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /tagged body/);
			assert.match(
				out,
				new RegExp(
					`<file path="${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">tagged body</file>`,
				),
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@` inside a fenced `!``` block is just text (not expanded)", async () => {
		// The fenced `!``` body is shell code. The inline `@` inside is
		// not a file reference; it's literal shell text that the command
		// will receive as input.
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "inside.txt");
			writeFileSync(file, "SHOULD_NOT_LOAD");
			// The fenced command is `echo @`...`` ` (with escaped backticks).
			// It echoes the literal `@`path`` text -- not the file content.
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `!\`\`\`sh\necho 'see @\\\`${file}\\\`' \n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.ok(!/SHOULD_NOT_LOAD/.test(out), "file must not be loaded");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("inline `@` inside a fenced `@``` block is just a literal path (not expanded)", async () => {
		// Symmetric to the previous test: the fenced `@``` body is the
		// list of paths. An inline `@` inside is one more literal path
		// (which won't exist and will fail with ENOENT).
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const realFile = join(tmp, "real.md");
			writeFileSync(realFile, "REAL");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `@\`\`\`\n${realFile}\n@\`/no/such/path\`\n\`\`\``,
							},
						],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /REAL/);
			// The inline `@` was NOT recursed into; it sits inside the
			// fenced body and was treated as a literal path line. Since
			// the path doesn't exist, it produces a `[file failed: ...]`.
			assert.match(out, /\[file failed: ENOENT/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("message_end (`@path` recursion: file content is itself expanded)", () => {
	test("file containing `@`path`` is recursively expanded", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "inner.md");
			const outer = join(tmp, "outer.md");
			writeFileSync(inner, "INNER-CONTENT");
			writeFileSync(outer, `outer text begin\n@\`${inner}\`\nouter text end`);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `load: @\`${outer}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /outer text begin/);
			assert.match(out, /INNER-CONTENT/);
			assert.match(out, /outer text end/);
			// No raw `@`` left in the output.
			assert.doesNotMatch(out, /@`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("file containing `` !`cmd` `` has its commands executed", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const f = join(tmp, "with-cmd.md");
			writeFileSync(f, "header\n!`echo FROM-CMD`\nfooter");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${f}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /header/);
			assert.match(out, /FROM-CMD/);
			assert.match(out, /footer/);
			assert.doesNotMatch(out, /!`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("circular reference (A → B → A) is short-circuited inline", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "a.md");
			const b = join(tmp, "b.md");
			// A references B; B references A. Without cycle detection
			// this would loop until MAX_RECURSION_DEPTH killed it.
			writeFileSync(a, `A-start\n@\`${b}\`\nA-end`);
			writeFileSync(b, `B-start\n@\`${a}\`\nB-end`);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${a}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			assert.match(out, /A-start/);
			assert.match(out, /B-start/);
			assert.match(out, /\[file skipped: circular reference/);
			// The cycle is detected and reported inline; expansion
			// terminates without ever recursing forever.
			assert.doesNotMatch(out, /throw/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("recursion stops at MAX_RECURSION_DEPTH with unresolved `@` syntax left inline", async () => {
		// Build a 12-deep chain of files: 0.md references 1.md, which
		// references 2.md, ... up to 11.md. With MAX_RECURSION_DEPTH=10,
		// the deepest level is returned with its `@` reference still
		// visible inline.
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const depth = 12;
			const files = [];
			for (let i = 0; i < depth; i++) {
				files.push(join(tmp, `lvl${i}.md`));
			}
			for (let i = 0; i < depth; i++) {
				if (i === depth - 1) {
					writeFileSync(files[i], `LEAF-${i}`);
				} else {
					writeFileSync(files[i], `LEVEL-${i}\n@\`${files[i + 1]}\`\nEND-${i}`);
				}
			}
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${files[0]}\`` }],
					},
				},
				ctx,
			);
			const out = r.message.content[0].text;
			// Some early levels resolved successfully.
			assert.match(out, /LEVEL-0/);
			// Some late level was capped -- the @`...` syntax survived.
			assert.match(out, /@`/);
			// No exceptions thrown.
			assert.doesNotMatch(out, /throw/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// @-file truncation: > DEFAULT_MAX_FILE_BYTES (10 KB) gets tail-truncated
// ---------------------------------------------------------------------------

describe("truncation (file content > 10000 bytes)", () => {
	test("message_end: large inline `@`file` is tail-truncated, full saved to temp file", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "huge.md");
			// ~15 KB, well above the 10 KB cap.
			const original = "Z".repeat(15_000);
			writeFileSync(file, original);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.ok(r?.message);
			const out = r.message.content[0].text;
			assert.match(out, /\[Output truncated/);
			// No raw `@`` syntax in the output.
			assert.doesNotMatch(out, /@`/);
			assert.ok(
				out.length < 15_000 + 200,
				`inline text must be smaller than raw 15KB (got ${out.length})`,
			);
			const m = out.match(/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/);
			assert.ok(m, "footer must include the temp file path");
			// The temp file contains the FULL (un-truncated) file content.
			const full = readFileSync(m[1], "utf-8");
			assert.equal(full.length, 15_000);
			unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("message_end: small inline `@`file` is not truncated", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "small.md");
			writeFileSync(file, "tiny");
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `@\`${file}\`` }],
					},
				},
				ctx,
			);
			assert.equal(
				r.message.content[0].text,
				`<file path="${file}">tiny</file>`,
			);
			assert.doesNotMatch(r.message.content[0].text, /\[Output truncated/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("before_agent_start: large `@`file` in AGENTS.md gets truncation footer", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "inner.md");
			writeFileSync(inner, "Q".repeat(12_000));
			const agents = join(tmp, "AGENTS.md");
			const original = `context: @\`${inner}\``;
			writeFileSync(agents, original);
			const sys = `<project_instructions path="${agents}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: agents, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /\[Output truncated/);
			assert.doesNotMatch(r.systemPrompt, /@`/);
			const m = r.systemPrompt.match(
				/Full output: (\S+pi-cmd-expand-[0-9a-f]+\.log)/,
			);
			if (m) unlinkSync(m[1]);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// before_agent_start: `@`path` inside AGENTS.md / CLAUDE.md
// ---------------------------------------------------------------------------

describe("before_agent_start (context file `@`path` expansion)", () => {
	test("AGENTS.md-style block with inline `@`path`` is substituted", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "alpha.md");
			writeFileSync(inner, "ALPHA");
			const file = join(tmp, "AGENTS.md");
			const original = `refs: @\`${inner}\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /ALPHA/);
			assert.doesNotMatch(r.systemPrompt, /@`/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("AGENTS.md with fenced `@``` -- multi-file substitutes labeled output", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const a = join(tmp, "x.md");
			const b = join(tmp, "y.md");
			writeFileSync(a, "X-CONTENT");
			writeFileSync(b, "Y-CONTENT");
			const file = join(tmp, "AGENTS.md");
			const original = `@\`\`\`\n${a}\n${b}\n\`\`\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /X-CONTENT/);
			assert.match(r.systemPrompt, /Y-CONTENT/);
			assert.match(r.systemPrompt, /<file path=/);
			assert.doesNotMatch(r.systemPrompt, /@```/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("context file with `@`path`` and `!`cmd`` -- both expand", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const inner = join(tmp, "f.md");
			writeFileSync(inner, "FROM-FILE");
			const file = join(tmp, "AGENTS.md");
			const original = `cmd: !\`echo FROM-CMD\` file: @\`${inner}\``;
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.match(r.systemPrompt, /FROM-CMD/);
			assert.match(r.systemPrompt, /FROM-FILE/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("context file with neither `!` nor `@` -- no-op", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-test-"));
		try {
			const file = join(tmp, "AGENTS.md");
			const original = "static prose with no commands or file refs";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				ctx,
			);
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Config: `pi-cmd-expand.json` toggles for `enableCmd` and `enableFile`
// ---------------------------------------------------------------------------
// Read on `session_start`. Missing / invalid config falls back to
// defaults (both features enabled). The two kinds are gated
// independently — disabling cmd leaves `@` files intact, and vice-
// versa. Disabling cmd also stops recursive `` !`cmd` `` execution
// inside loaded files (same gate applies at every expansion level).
// ---------------------------------------------------------------------------

describe("config (`enableCmd` / `enableFile` toggles)", () => {
	/** Initialise `currentConfig` for a `cwd` by invoking the
	 *  `session_start` handler with that cwd. Returns the parsed
	 *  config that the loader produced so tests can sanity-check
	 *  the round-trip. */
	async function startSessionIn(cwd) {
		return handlers.session_start({}, { cwd });
	}

	/** Write a config under `<tmp>/.pi/pi-cmd-expand.json`. The
	 *  parent directory may not exist yet (fresh mkdtemp output),
	 *  so we mkdir it explicitly before writeFileSync. */
	function writeProjectConfig(tmp, body) {
		const piDir = join(tmp, ".pi");
		mkdirSync(piDir, { recursive: true });
		writeFileSync(join(piDir, "pi-cmd-expand.json"), body);
	}

	test("default behaviour with no config file -- both kinds expand", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			const inner = join(tmp, "default-keep.md");
			writeFileSync(inner, "FILE-DEFAULT-CONTENT");
			await startSessionIn(tmp);
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: `!\`echo CMD\` and @\`${inner}\``,
							},
						],
					},
				},
				{ cwd: tmp },
			);
			// Both forms expanded (cmd ran, file loaded).
			assert.match(
				r.message.content[0].text,
				/<cmd source="echo CMD">CMD<\/cmd>/,
			);
			assert.match(
				r.message.content[0].text,
				new RegExp(
					`<file path="${inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`,
				),
			);
			assert.match(r.message.content[0].text, /FILE-DEFAULT-CONTENT/);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enableCmd=false: `` !`cmd` `` left as literal text in user message", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(tmp, JSON.stringify({ enableCmd: false }));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "raw: !`echo SHOULD_NOT_RUN`" }],
					},
				},
				{ cwd: tmp },
			);
			// The handler short-circuits when no enabled trigger char
			// is present, so it returns `undefined` and the LLM sees
			// the original text unchanged.
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enableCmd=false: file expansion still works alongside disabled cmd", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			const inner = join(tmp, "kept.md");
			writeFileSync(inner, "KEPT-FILE-CONTENT");
			writeProjectConfig(tmp, JSON.stringify({ enableCmd: false }));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{ type: "text", text: `cmd: !\`echo NOPE\` file: @\`${inner}\`` },
						],
					},
				},
				{ cwd: tmp },
			);
			// `` !`echo NOPE` `` stays literal (would fail as a real shell
			// command), but `` @`...` `` still loads the file.
			assert.match(r.message.content[0].text, /!`echo NOPE`/);
			assert.match(r.message.content[0].text, /<file path=/);
			assert.match(r.message.content[0].text, /KEPT-FILE-CONTENT/);
			assert.doesNotMatch(r.message.content[0].text, /<cmd /);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enableFile=false: `` @`path` `` left as literal text in user message", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			const inner = join(tmp, "ignored.md");
			writeFileSync(inner, "IGNORED");
			writeProjectConfig(tmp, JSON.stringify({ enableFile: false }));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `see: @\`${inner}\` here` }],
					},
				},
				{ cwd: tmp },
			);
			// `@` is a disabled trigger char, so the handler short-circuits
			// and returns `undefined` (no expansion at all).
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enableFile=false: cmd expansion still works alongside disabled file", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(tmp, JSON.stringify({ enableFile: false }));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "ping: !`echo STILL_RUNS`" }],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(
				r.message.content[0].text,
				'ping: <cmd source="echo STILL_RUNS">STILL_RUNS</cmd>',
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("both toggles off: any trigger syntax is left literal", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(
				tmp,
				JSON.stringify({ enableCmd: false, enableFile: false }),
			);
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{
								type: "text",
								text: "!`echo X` and @`./whatever.md`",
							},
						],
					},
				},
				{ cwd: tmp },
			);
			// Both trigger chars present, but neither kind is enabled —
			// short-circuit on the fast-path, no replacement returned.
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("enableCmd=false disables recursion: !cmd inside a loaded file is left literal", async () => {
		// Even when the file is loaded via `@`, the nested `` !`cmd` `` must
		// stay literal because the gate applies at every expansion level.
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			const inner = join(tmp, "inner.md");
			writeFileSync(inner, "header\n!`echo NESTED`\nfooter");
			writeProjectConfig(tmp, JSON.stringify({ enableCmd: false }));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: `load: @\`${inner}\`` }],
					},
				},
				{ cwd: tmp },
			);
			const out = r.message.content[0].text;
			// File expanded (enableFile=true), but the nested cmd syntax
			// is preserved verbatim — the LLM sees `` !`echo NESTED` ``.
			assert.match(out, /header/);
			assert.match(out, /footer/);
			assert.match(out, /!`echo NESTED`/);
			assert.doesNotMatch(out, /<cmd /);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("config precedence: project overrides global", async () => {
		// Write both files: global sets enableCmd=false, project
		// sets enableFile=false. Each level only sees its own setting.
		writeFileSync(
			join(globalAgentDir, "pi-cmd-expand.json"),
			JSON.stringify({ enableCmd: false }),
		);
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(tmp, JSON.stringify({ enableFile: false }));
			await startSessionIn(tmp);

			// With BOTH settings merged, neither kind expands.
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [
							{ type: "text", text: "!`echo BOTH_OFF` @`/etc/hostname`" },
						],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
			unlinkSync(join(globalAgentDir, "pi-cmd-expand.json"));
		}
	});

	test("invalid project config falls back to defaults (no throw)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			// Garbage JSON. The loader logs and returns DEFAULT_CONFIG.
			writeProjectConfig(tmp, "{ this is not valid json :: !!");
			await startSessionIn(tmp);

			// Both kinds should still expand.
			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "!`echo DEFAULTS`" }],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(
				r.message.content[0].text,
				'<cmd source="echo DEFAULTS">DEFAULTS</cmd>',
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("wrong-typed values in config are ignored (lenient schema)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			// `enableCmd` is a string (truthy non-bool) — ignored.
			// `enableFile` is `null` — ignored. Both should default to `true`.
			writeProjectConfig(
				tmp,
				JSON.stringify({ enableCmd: "false", enableFile: null }),
			);
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "!`echo KEPT`" }],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(
				r.message.content[0].text,
				'<cmd source="echo KEPT">KEPT</cmd>',
			);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("unknown keys in config are ignored", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(
				tmp,
				JSON.stringify({
					enableCmd: false,
					// Unknown future-proofing keys should not break loading.
					enableBash: true,
					maxOutputBytes: 5000,
					theme: "dark",
				}),
			);
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "!`echo X`" }],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("config also gates before_agent_start context-file expansion", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(tmp, JSON.stringify({ enableCmd: false }));
			await startSessionIn(tmp);

			const file = join(tmp, "AGENTS.md");
			const original = "task: !`echo SHOULD_NOT_RUN`";
			writeFileSync(file, original);
			const sys = `<project_instructions path="${file}">\n${original}\n</project_instructions>`;
			const r = await handlers.before_agent_start(
				{
					systemPrompt: sys,
					systemPromptOptions: {
						contextFiles: [{ path: file, content: original }],
					},
				},
				{ cwd: tmp },
			);
			// enableCmd is off, so the system prompt must be unchanged.
			assert.equal(r, undefined);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("non-JSON top-level (e.g. an array) is ignored -- defaults apply", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "pi-cmd-expand-cfg-"));
		try {
			writeProjectConfig(tmp, JSON.stringify([1, 2, 3]));
			await startSessionIn(tmp);

			const r = await handlers.message_end(
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "!`echo OK`" }],
					},
				},
				{ cwd: tmp },
			);
			assert.equal(r.message.content[0].text, '<cmd source="echo OK">OK</cmd>');
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
// scope, by design:
//
//   1. `user_bash` (start-of-line `!cmd`)           → pi's native `!bash`.
//   2. `tool_call` / `tool_result` for the `bash`   → the agent's own tool
//      tool                                            runs untouched.
//   3. Files the agent reads with `read`            → only AGENTS.md /
//                                                    CLAUDE.md (via
//                                                    `before_agent_start`)
//                                                    are expanded.
// ---------------------------------------------------------------------------

describe("scope (the `!cmd` expansion is intentionally narrow)", () => {
	test("user_bash is not registered -- start-of-line `!cmd` belongs to pi", () => {
		// Documenting the design contract: when the user types `!cmd` at
		// the start of a line, pi's interactive mode fires the
		// `user_bash` event. We deliberately do NOT subscribe so that
		// pi's native `!bash` handling (including `!!` to exclude from
		// context, live streaming, cancellation) keeps working as
		// designed. Backticks in `!`cmd`` are expanded by bash itself
		// via command substitution.
		assert.equal(handlers.user_bash, undefined);
	});

	test("tool_call and tool_result are not registered -- the agent's own bash tool is untouched", () => {
		// When the LLM calls pi's built-in `bash` tool, the command
		// goes straight to bashOps.exec on the agent's side. This
		// extension does not hook tool_call/tool_result, so any
		// `!`cmd`` text the LLM happens to run lands in the shell
		// literally (e.g. `` !`ls` `` would fail as a real command).
		assert.equal(handlers.tool_call, undefined);
		assert.equal(handlers.tool_result, undefined);
	});

	test("input is not registered -- expansion is centralised in `message_end`", () => {
		// We used to register an `input` handler that rewrote the typed
		// text in place so the TUI would show the expanded output, but
		// the contract was fragile (had to be paired with `message_end`
		// for the prompt-template case anyway) and the TUI still could
		// not show the expanded text for template-sourced input. With
		// the hook removed, both directly-typed and template-sourced
		// `!cmd` are expanded by the single `message_end` hook. The
		// TUI trade-off is that the on-screen user message shows the
		// raw `!`cmd`` form; the LLM still receives the expanded text.
		assert.equal(handlers.input, undefined);
	});
});
