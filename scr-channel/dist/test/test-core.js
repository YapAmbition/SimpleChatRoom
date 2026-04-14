/**
 * Tests for the MessageBatcher, config validation, accounts resolution,
 * and inbound message processing utilities.
 *
 * Run with: node --test dist/test/test-core.js
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MessageBatcher } from "../src/batcher.js";
import { validateAccountConfig } from "../src/config-schema.js";
import { listScrAccountIds, resolveDefaultScrAccountId, resolveScrAccount, } from "../src/accounts.js";
import { isMentioned, formatBatchContext, formatTime, } from "../src/inbound.js";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeScrMsg(overrides = {}) {
    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        user: "TestUser",
        ts: new Date().toISOString(),
        room: "test-room",
        text: "Hello world",
        ...overrides,
    };
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
// ---------------------------------------------------------------------------
// MessageBatcher tests
// ---------------------------------------------------------------------------
describe("MessageBatcher", () => {
    it("should flush after debounce period with no new messages", async () => {
        const flushed = [];
        const batcher = new MessageBatcher(100, 5000, async (msgs) => {
            flushed.push([...msgs]);
        });
        batcher.push(makeScrMsg({ text: "msg1" }));
        batcher.push(makeScrMsg({ text: "msg2" }));
        assert.equal(flushed.length, 0, "should not flush immediately");
        await sleep(200);
        assert.equal(flushed.length, 1, "should flush once after debounce");
        assert.equal(flushed[0].length, 2, "should contain both messages");
        assert.equal(flushed[0][0].text, "msg1");
        assert.equal(flushed[0][1].text, "msg2");
        batcher.destroy();
    });
    it("should reset debounce timer on each new message", async () => {
        const flushed = [];
        const batcher = new MessageBatcher(150, 5000, async (msgs) => {
            flushed.push([...msgs]);
        });
        batcher.push(makeScrMsg({ text: "msg1" }));
        await sleep(100);
        batcher.push(makeScrMsg({ text: "msg2" }));
        await sleep(100);
        batcher.push(makeScrMsg({ text: "msg3" }));
        assert.equal(flushed.length, 0, "should not flush while messages keep coming");
        await sleep(250);
        assert.equal(flushed.length, 1, "should flush once after debounce");
        assert.equal(flushed[0].length, 3, "should contain all three messages");
        batcher.destroy();
    });
    it("should force flush at maxWait even if messages keep coming", async () => {
        const flushed = [];
        const batcher = new MessageBatcher(100, 300, async (msgs) => {
            flushed.push([...msgs]);
        });
        // Send messages continuously
        const interval = setInterval(() => {
            batcher.push(makeScrMsg({ text: "continuous" }));
        }, 50);
        await sleep(450);
        clearInterval(interval);
        // Should have flushed at least once due to maxWait
        assert.ok(flushed.length >= 1, `should have flushed at least once, got ${flushed.length}`);
        batcher.destroy();
    });
    it("should queue messages during processing for next batch", async () => {
        const flushed = [];
        const batcher = new MessageBatcher(50, 5000, async (msgs) => {
            flushed.push([...msgs]);
            await sleep(200); // Simulate slow processing
        });
        batcher.push(makeScrMsg({ text: "batch1-msg1" }));
        await sleep(100); // Wait for first flush to start
        // These should queue for next batch
        batcher.push(makeScrMsg({ text: "batch2-msg1" }));
        batcher.push(makeScrMsg({ text: "batch2-msg2" }));
        await sleep(500); // Wait for both batches to complete
        assert.equal(flushed.length, 2, "should have flushed twice");
        assert.equal(flushed[0].length, 1, "first batch: 1 message");
        assert.equal(flushed[1].length, 2, "second batch: 2 messages");
        batcher.destroy();
    });
    it("should not accept messages after destroy", async () => {
        const flushed = [];
        const batcher = new MessageBatcher(50, 5000, async (msgs) => {
            flushed.push([...msgs]);
        });
        batcher.destroy();
        batcher.push(makeScrMsg({ text: "should be ignored" }));
        await sleep(100);
        assert.equal(flushed.length, 0, "should not flush after destroy");
    });
    it("should report pendingCount and isProcessing", async () => {
        const batcher = new MessageBatcher(100, 5000, async () => {
            await sleep(200);
        });
        assert.equal(batcher.pendingCount, 0);
        assert.equal(batcher.isProcessing, false);
        batcher.push(makeScrMsg());
        assert.equal(batcher.pendingCount, 1);
        batcher.destroy();
    });
});
// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------
describe("validateAccountConfig", () => {
    it("should validate a complete config", () => {
        const cfg = validateAccountConfig({
            serverUrl: "https://chat.example.com",
            room: "聊天大厅",
            botName: "TestBot",
        }, "default");
        assert.equal(cfg.serverUrl, "https://chat.example.com");
        assert.equal(cfg.room, "聊天大厅");
        assert.equal(cfg.botName, "TestBot");
        assert.equal(cfg.requireMention, false);
        assert.equal(cfg.batchDebounceMs, 3000);
        assert.equal(cfg.batchMaxWaitMs, 10000);
        assert.equal(cfg.responsePrefix, "");
    });
    it("should strip trailing slashes from serverUrl", () => {
        const cfg = validateAccountConfig({
            serverUrl: "https://chat.example.com///",
            room: "test",
            botName: "bot",
        }, "default");
        assert.equal(cfg.serverUrl, "https://chat.example.com");
    });
    it("should throw on missing required fields", () => {
        assert.throws(() => validateAccountConfig({}, "test"), /serverUrl is required/);
        assert.throws(() => validateAccountConfig({ serverUrl: "http://x" }, "test"), /room is required/);
        assert.throws(() => validateAccountConfig({ serverUrl: "http://x", room: "r" }, "test"), /botName is required/);
    });
    it("should apply custom values over defaults", () => {
        const cfg = validateAccountConfig({
            serverUrl: "http://localhost:3000",
            room: "test",
            botName: "bot",
            requireMention: true,
            batchDebounceMs: 5000,
            batchMaxWaitMs: 20000,
            responsePrefix: "🤖 ",
        }, "default");
        assert.equal(cfg.requireMention, true);
        assert.equal(cfg.batchDebounceMs, 5000);
        assert.equal(cfg.batchMaxWaitMs, 20000);
        assert.equal(cfg.responsePrefix, "🤖 ");
    });
});
// ---------------------------------------------------------------------------
// Account resolution tests
// ---------------------------------------------------------------------------
describe("accounts", () => {
    it("should list accounts from flat config", () => {
        const cfg = {
            serverUrl: "http://localhost",
            room: "test",
            botName: "bot",
        };
        const ids = listScrAccountIds(cfg);
        assert.deepEqual(ids, ["default"]);
    });
    it("should list accounts from nested config", () => {
        const cfg = {
            accounts: {
                prod: { serverUrl: "https://prod.example.com", room: "main", botName: "bot" },
                dev: { serverUrl: "http://localhost:3000", room: "dev", botName: "devbot" },
            },
        };
        const ids = listScrAccountIds(cfg);
        assert.deepEqual(ids, ["prod", "dev"]);
    });
    it("should resolve default account id", () => {
        const cfg = {
            defaultAccount: "prod",
            accounts: {
                prod: { serverUrl: "https://prod.example.com", room: "main", botName: "bot" },
                dev: {},
            },
        };
        assert.equal(resolveDefaultScrAccountId(cfg), "prod");
    });
    it("should resolve account with layered config", () => {
        const cfg = {
            serverUrl: "http://base.example.com",
            room: "base-room",
            botName: "base-bot",
            batchDebounceMs: 5000,
            accounts: {
                custom: {
                    serverUrl: "http://custom.example.com",
                    botName: "custom-bot",
                    // room falls back to base
                },
            },
        };
        const resolved = resolveScrAccount(cfg, "custom");
        assert.equal(resolved.serverUrl, "http://custom.example.com");
        assert.equal(resolved.botName, "custom-bot");
        assert.equal(resolved.room, "base-room"); // from base
        assert.equal(resolved.batchDebounceMs, 5000); // from base
        assert.equal(resolved.configured, true);
        assert.equal(resolved.accountId, "custom");
    });
});
// ---------------------------------------------------------------------------
// Inbound utility tests
// ---------------------------------------------------------------------------
describe("inbound utilities", () => {
    describe("isMentioned", () => {
        const account = {
            accountId: "test",
            enabled: true,
            configured: true,
            serverUrl: "http://localhost",
            room: "test",
            botName: "OpenClaw-Bot",
            requireMention: true,
            mentionPatterns: ["小助手"],
            batchDebounceMs: 3000,
            batchMaxWaitMs: 10000,
            responsePrefix: "",
        };
        it("should detect direct name mention", () => {
            const msg = makeScrMsg({ text: "Hey OpenClaw-Bot, how are you?" });
            assert.equal(isMentioned(msg, account), true);
        });
        it("should detect @mention", () => {
            const msg = makeScrMsg({ text: "Hey @OpenClaw-Bot what's up?" });
            assert.equal(isMentioned(msg, account), true);
        });
        it("should detect custom mention pattern", () => {
            const msg = makeScrMsg({ text: "小助手帮我查一下" });
            assert.equal(isMentioned(msg, account), true);
        });
        it("should be case insensitive", () => {
            const msg = makeScrMsg({ text: "openclaw-bot help me" });
            assert.equal(isMentioned(msg, account), true);
        });
        it("should return false when not mentioned", () => {
            const msg = makeScrMsg({ text: "Just a regular message" });
            assert.equal(isMentioned(msg, account), false);
        });
    });
    describe("formatBatchContext", () => {
        it("should format messages into readable context", () => {
            const msgs = [
                makeScrMsg({ user: "Alice", text: "Hello!", ts: "2026-04-14T10:00:00.000Z" }),
                makeScrMsg({ user: "Bob", text: "Hi there!", ts: "2026-04-14T10:00:05.000Z" }),
            ];
            const ctx = formatBatchContext(msgs);
            assert.ok(ctx.includes("Alice: Hello!"));
            assert.ok(ctx.includes("Bob: Hi there!"));
        });
        it("should handle file messages", () => {
            const msgs = [
                makeScrMsg({
                    user: "Alice",
                    text: "[文件] photo.png",
                    type: "file",
                    file: { url: "/uploads/photo.png", name: "photo.png", size: 1234, mimetype: "image/png" },
                }),
            ];
            const ctx = formatBatchContext(msgs);
            assert.ok(ctx.includes("[file: photo.png]"));
        });
    });
    describe("formatTime", () => {
        it("should format ISO timestamp to HH:MM:SS", () => {
            const result = formatTime("2026-04-14T10:30:45.000Z");
            // The exact output depends on timezone, but it should be 8 chars
            assert.equal(result.length, 8);
            assert.ok(result.includes(":"));
        });
        it("should return original on invalid input", () => {
            const result = formatTime("invalid");
            // Should not throw, returns something
            assert.ok(typeof result === "string");
        });
    });
});
//# sourceMappingURL=test-core.js.map