import { test, expect, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

// Isolate the machine-global registry from real agent sessions.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "collective-test-"));
const homeSpy = spyOn(os, "homedir").mockReturnValue(home);
// Dynamic loading is required: the registry path is captured at module evaluation.
const { default: collective } = await import("./index.ts");

test("membership is explicit, session-scoped, and leaving cancels queued delivery", async () => {
	type API = Parameters<typeof collective>[0];
	const events = new Map<string, Parameters<API["on"]>[1]>();
	const commands = new Map<string, Parameters<API["registerCommand"]>[1]>();
	const delivered: string[] = [];
	const status = new Map<string, string | undefined>();
	const ctx = {
		cwd: "/tmp/collective-test", isIdle: () => true,
		ui: { notify: () => {}, setStatus: (key: string, text: string | undefined) => status.set(key, text) },
		sessionManager: { getSessionId: () => "test", getHeader: () => ({ titleSource: "user" }) },
	};
	collective({
		on: (event, handler) => { events.set(event, handler); },
		registerCommand: (name, command) => { commands.set(name, command); },
		registerTool: () => {}, getSessionName: () => "test",
		sendUserMessage: text => { delivered.push(text); },
	});
	const command = (args: string) => commands.get("collective")!.handler(args, ctx);
	const event = (name: string) => events.get(name)?.({ messages: [{ role: "user", content: "hello" }] }, ctx);
	const socketPath = path.join(home, ".agent-collective", `${process.pid}.sock`);
	const recordPath = path.join(home, ".agent-collective", `${process.pid}.json`);
	const connect = () => new Promise<net.Socket>((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => resolve(socket));
		socket.once("error", reject);
	});
	const request = async (frame: object) => {
		const socket = await connect();
		const reply = new Promise<{ ok: boolean }>((resolve, reject) => {
			socket.once("data", data => { resolve(JSON.parse(String(data))); socket.destroy(); });
			socket.once("error", reject);
		});
		socket.write(JSON.stringify(frame) + "\n");
		return reply;
	};
	try {
		await event("session_start");
		await command("status");
		await command("invalid");
		await commands.get("callsign")!.handler("hidden", ctx);
		await event("context");
		expect(fs.existsSync(recordPath)).toBe(false);
		expect(fs.existsSync(socketPath)).toBe(false);
		await command("");
		expect(fs.existsSync(recordPath)).toBe(true);
		expect((await request({ t: "ping", from: "peer" })).ok).toBe(true);
		const startedAt = JSON.parse(fs.readFileSync(recordPath, "utf8")).startedAt;
		await command("");
		expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).startedAt).toBe(startedAt);
		expect((await request({ t: "msg", from: "peer", body: "deliver this" })).ok).toBe(true);
		expect(delivered.some(text => text.includes("deliver this"))).toBe(true);

		const pending = await connect();
		const queued = new Promise<void>(resolve => pending.once("data", () => resolve()));
		// The following ping acknowledges that the preceding message entered the batch.
		pending.write(JSON.stringify({ t: "msg", from: "peer", body: "must not arrive" }) + "\n"
			+ JSON.stringify({ t: "ping", from: "peer" }) + "\n");
		await queued;
		await command("leave");
		await event("context");
		expect(fs.existsSync(recordPath)).toBe(false);
		expect(fs.existsSync(socketPath)).toBe(false);
		expect(status.get("collective")).toBeUndefined();
		await command(""); // Immediate rejoin must not revive the old queued batch.
		// Integration boundary: exercise real socket shutdown against the platform's
		// batch timer, including callbacks surviving an immediate rejoin.
		await Bun.sleep(450);
		expect(delivered.some(text => text.includes("must not arrive"))).toBe(false);
		expect((await request({ t: "ping", from: "peer" })).ok).toBe(true);
		pending.destroy();
		for (const lifecycle of ["session_start", "session_switch", "session_branch", "session_tree", "session_shutdown"]) {
			await event(lifecycle);
			await event("context");
			await command("status");
			expect(fs.existsSync(recordPath)).toBe(false);
			expect(fs.existsSync(socketPath)).toBe(false);
			await command("");
		}
	} finally {
		await command("leave");
		homeSpy.mockRestore();
		fs.rmSync(home, { recursive: true, force: true });
	}
}, 10000);
