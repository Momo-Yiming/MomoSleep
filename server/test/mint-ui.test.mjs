import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import server from "../src/index.mjs";

async function mintUI(state) {
  const html = await (await server.fetch(new Request("https://example.com/?lang=en"), {})).text();
  const functions = html.split("\n").filter(line => /^function (tokenMintStatus|currentTokenMint|updateTokenMint)\(/.test(line)).join("\n");
  const elements = Object.fromEntries(["token-recipient", "token-submit", "token-estimate", "token-limit"].map(id => [id, { value: "0x1111111111111111111111111111111111111111" }]));
  const context = { currentState: state, tokenMintBusy: false, tokenPollTimer: null, tokenPollAttempts: 12, el: id => elements[id], t: (_zh, en) => en, clearTimeout() {} };
  runInNewContext(functions + "\nupdateTokenMint();", context);
  return { context, elements };
}

const state = record => ({ tokenPolicy: { mintingEnabled: true }, claims: [{ id: "claim-1", status: "accepted", awardedPoints: 390 }], tokenMints: record ? [{ claimId: "claim-1", points: 390, recipient: "0x1111111111111111111111111111111111111111", ...record }] : [] });

test("a transaction hash awaiting a receipt is not displayed as a successful mint", async () => {
  const { elements } = await mintUI(state({ status: "submitted", transactionHash: "0xabc", blockNumber: null, retryable: false }));
  assert.match(elements["token-limit"].textContent, /success is not confirmed/);
  assert.doesNotMatch(elements["token-limit"].textContent, /Mint successful/);
  assert.equal(elements["token-submit"].textContent, "Check on-chain confirmation");
  assert.equal(elements["token-submit"].disabled, false);
});

test("recoverable failure enables retry, but a confirmed mint stays disabled", async () => {
  const failed = await mintUI(state({ status: "failed", retryable: true }));
  assert.equal(failed.elements["token-submit"].textContent, "Retry mint");
  assert.equal(failed.elements["token-submit"].disabled, false);
  const confirmed = await mintUI(state({ status: "confirmed", transactionHash: "0xabc", blockNumber: 123, retryable: false }));
  assert.match(confirmed.elements["token-limit"].textContent, /Mint successful: 390 SLEEP recorded in block #123/);
  assert.equal(confirmed.elements["token-submit"].disabled, true);
});

test("an unrelated historical claim does not disable minting, and zero recipient is rejected", async () => {
  const unrelated = await mintUI(state({ claimId: "old-claim", status: "confirmed", retryable: false }));
  assert.equal(unrelated.elements["token-submit"].disabled, false);
  unrelated.elements["token-recipient"].value = "0x0000000000000000000000000000000000000000";
  runInNewContext("updateTokenMint()", unrelated.context);
  assert.equal(unrelated.elements["token-submit"].disabled, true);
});
