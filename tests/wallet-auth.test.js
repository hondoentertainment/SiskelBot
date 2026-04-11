/**
 * Phase 48.1: Wallet authentication tests.
 *
 * Covers challenge generation, EIP-4361 parsing, Ethereum stub signature
 * verification, native Solana ed25519 verification, replay protection,
 * expiration, and wallet<->user linking.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

const TMP_DATA_DIR = mkdtempSync(join(tmpdir(), "siskel-wallet-auth-"));
process.env.STORAGE_PATH = TMP_DATA_DIR;
process.env.WALLET_AUTH_DOMAIN = "siskelbot.test";
process.env.WALLET_AUTH_URI = "https://siskelbot.test";
process.env.WALLET_AUTH_CHALLENGE_TTL_MS = "600000";

const {
  SUPPORTED_CHAINS,
  createChallenge,
  verifyChallenge,
  buildEip4361Message,
  parseEip4361Message,
  verifySolanaSignature,
  verifyEthereumSignature,
  signEthereumStub,
  linkWalletToUser,
  unlinkWallet,
  getWalletsForUser,
  getUserByWallet,
  base58Encode,
  base58Decode,
  _internals,
} = await import("../lib/wallet-auth.js");

test.after(() => {
  try {
    rmSync(TMP_DATA_DIR, { recursive: true, force: true });
  } catch (_) {}
});

// -----------------------------------------------------------------------
// Fixtures: generate a real ed25519 keypair and derive a Solana address.
// -----------------------------------------------------------------------
function makeSolanaWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = spki.subarray(spki.length - 32);
  const address = base58Encode(rawPub);
  return { address, privateKey, publicKey };
}

function signSolanaMessage(privateKey, message) {
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}

const ETH_ADDR = "0x" + "ab".repeat(20);

// -----------------------------------------------------------------------
// Challenge creation / message structure
// -----------------------------------------------------------------------

test("createChallenge returns structured EIP-4361 message for ethereum", async () => {
  const result = await createChallenge(ETH_ADDR, "ethereum");
  assert.ok(result.nonce);
  assert.equal(typeof result.nonce, "string");
  assert.ok(result.message.includes("siskelbot.test wants you to sign in with your Ethereum account:"));
  assert.ok(result.message.includes(ETH_ADDR));
  assert.ok(result.message.includes(`Nonce: ${result.nonce}`));
  assert.ok(result.expiresAt > Date.now());
  assert.equal(result.chain, "ethereum");
  assert.equal(result.address, ETH_ADDR);
});

test("createChallenge returns structured message for solana", async () => {
  const { address } = makeSolanaWallet();
  const result = await createChallenge(address, "solana");
  assert.ok(result.message.includes("Chain ID: solana:mainnet"));
  assert.equal(result.address, address);
  assert.ok(result.nonce.length >= 16);
});

test("createChallenge rejects unsupported chain", async () => {
  await assert.rejects(
    () => createChallenge("0x" + "cd".repeat(20), "bitcoin"),
    /unsupported chain/,
  );
});

test("createChallenge rejects malformed ethereum address", async () => {
  await assert.rejects(() => createChallenge("not-an-address", "ethereum"), /invalid ethereum address/);
});

test("createChallenge rejects malformed solana address", async () => {
  await assert.rejects(() => createChallenge("0lO1", "solana"), /invalid solana address/);
});

test("SUPPORTED_CHAINS includes ethereum and solana", () => {
  assert.ok(SUPPORTED_CHAINS.ethereum);
  assert.ok(SUPPORTED_CHAINS.solana);
});

// -----------------------------------------------------------------------
// EIP-4361 parse roundtrip
// -----------------------------------------------------------------------

test("parseEip4361Message roundtrips buildEip4361Message", () => {
  const message = buildEip4361Message({
    domain: "example.com",
    address: "0x" + "ef".repeat(20),
    statement: "Please sign",
    uri: "https://example.com/login",
    version: "1",
    chainId: 1,
    nonce: "abc123",
    issuedAt: "2026-04-11T00:00:00Z",
    expirationTime: "2026-04-11T00:10:00Z",
  });
  const parsed = parseEip4361Message(message);
  assert.ok(parsed);
  assert.equal(parsed.domain, "example.com");
  assert.equal(parsed.address, "0x" + "ef".repeat(20));
  assert.equal(parsed.statement, "Please sign");
  assert.equal(parsed.uri, "https://example.com/login");
  assert.equal(parsed.chainId, "1");
  assert.equal(parsed.nonce, "abc123");
  assert.equal(parsed.issuedAt, "2026-04-11T00:00:00Z");
  assert.equal(parsed.expirationTime, "2026-04-11T00:10:00Z");
});

test("parseEip4361Message handles missing statement", () => {
  const message = buildEip4361Message({
    domain: "example.com",
    address: "0x" + "ef".repeat(20),
    uri: "https://example.com/login",
    chainId: 1,
    nonce: "abc",
    issuedAt: "2026-04-11T00:00:00Z",
  });
  const parsed = parseEip4361Message(message);
  assert.ok(parsed);
  assert.equal(parsed.statement, null);
});

test("parseEip4361Message returns null for garbage input", () => {
  assert.equal(parseEip4361Message("hello world"), null);
  assert.equal(parseEip4361Message(""), null);
  assert.equal(parseEip4361Message(null), null);
});

// -----------------------------------------------------------------------
// Solana signature verification
// -----------------------------------------------------------------------

test("verifySolanaSignature accepts a real ed25519 signature", () => {
  const { address, privateKey } = makeSolanaWallet();
  const message = "hello solana";
  const sig = signSolanaMessage(privateKey, message);
  assert.equal(verifySolanaSignature(address, message, sig), true);
});

test("verifySolanaSignature rejects tampered message", () => {
  const { address, privateKey } = makeSolanaWallet();
  const message = "transfer 1 SOL";
  const sig = signSolanaMessage(privateKey, message);
  assert.equal(verifySolanaSignature(address, "transfer 100 SOL", sig), false);
});

test("verifySolanaSignature rejects wrong address", () => {
  const { privateKey } = makeSolanaWallet();
  const other = makeSolanaWallet();
  const message = "hello";
  const sig = signSolanaMessage(privateKey, message);
  assert.equal(verifySolanaSignature(other.address, message, sig), false);
});

// -----------------------------------------------------------------------
// Ethereum stub signature verification
// -----------------------------------------------------------------------

test("verifyEthereumSignature accepts signEthereumStub output", () => {
  const message = "hello ethereum";
  const sig = signEthereumStub(ETH_ADDR, message);
  assert.equal(verifyEthereumSignature(ETH_ADDR, message, sig), true);
});

test("verifyEthereumSignature rejects mismatched signature", () => {
  const message = "hello ethereum";
  const sig = signEthereumStub(ETH_ADDR, "different message");
  assert.equal(verifyEthereumSignature(ETH_ADDR, message, sig), false);
});

test("verifyEthereumSignature rejects signature from different address", () => {
  const message = "hello";
  const otherAddr = "0x" + "cd".repeat(20);
  const sig = signEthereumStub(otherAddr, message);
  assert.equal(verifyEthereumSignature(ETH_ADDR, message, sig), false);
});

// -----------------------------------------------------------------------
// verifyChallenge lifecycle
// -----------------------------------------------------------------------

test("verifyChallenge succeeds for a valid Solana sign-in", async () => {
  const { address, privateKey } = makeSolanaWallet();
  const ch = await createChallenge(address, "solana");
  const sig = signSolanaMessage(privateKey, ch.message);
  const result = await verifyChallenge(address, "solana", sig, ch.message);
  assert.equal(result.verified, true);
  assert.equal(result.userId, null);
});

test("verifyChallenge succeeds for a valid Ethereum stub sign-in", async () => {
  const addr = "0x" + "12".repeat(20);
  const ch = await createChallenge(addr, "ethereum");
  const sig = signEthereumStub(addr, ch.message);
  const result = await verifyChallenge(addr, "ethereum", sig, ch.message);
  assert.equal(result.verified, true);
});

test("verifyChallenge rejects replayed nonce", async () => {
  const addr = "0x" + "34".repeat(20);
  const ch = await createChallenge(addr, "ethereum");
  const sig = signEthereumStub(addr, ch.message);
  const r1 = await verifyChallenge(addr, "ethereum", sig, ch.message);
  assert.equal(r1.verified, true);
  const r2 = await verifyChallenge(addr, "ethereum", sig, ch.message);
  assert.equal(r2.verified, false);
  assert.match(r2.error, /already used/);
});

test("verifyChallenge rejects expired challenge", async () => {
  const addr = "0x" + "56".repeat(20);
  const ch = await createChallenge(addr, "ethereum");
  // Manually expire the challenge in the store.
  const store = await _internals.loadStore();
  store.challenges[ch.nonce].expiresAt = Date.now() - 1000;
  await _internals.saveStore(store);
  const sig = signEthereumStub(addr, ch.message);
  const result = await verifyChallenge(addr, "ethereum", sig, ch.message);
  assert.equal(result.verified, false);
  assert.match(result.error, /expired/);
});

test("verifyChallenge rejects unknown nonce", async () => {
  const addr = "0x" + "78".repeat(20);
  const bogusMessage = buildEip4361Message({
    domain: "siskelbot.test",
    address: addr,
    uri: "https://siskelbot.test",
    chainId: 1,
    nonce: "not-a-real-nonce",
    issuedAt: new Date().toISOString(),
  });
  const sig = signEthereumStub(addr, bogusMessage);
  const result = await verifyChallenge(addr, "ethereum", sig, bogusMessage);
  assert.equal(result.verified, false);
  assert.match(result.error, /unknown nonce/);
});

test("verifyChallenge rejects tampered message body", async () => {
  const addr = "0x" + "9a".repeat(20);
  const ch = await createChallenge(addr, "ethereum");
  const tampered = ch.message + "\nX-Injected: yes";
  const sig = signEthereumStub(addr, tampered);
  const result = await verifyChallenge(addr, "ethereum", sig, tampered);
  assert.equal(result.verified, false);
});

test("verifyChallenge returns linked userId when wallet already linked", async () => {
  const addr = "0x" + "bc".repeat(20);
  await linkWalletToUser("user-xyz", addr, "ethereum");
  const ch = await createChallenge(addr, "ethereum");
  const sig = signEthereumStub(addr, ch.message);
  const result = await verifyChallenge(addr, "ethereum", sig, ch.message);
  assert.equal(result.verified, true);
  assert.equal(result.userId, "user-xyz");
});

// -----------------------------------------------------------------------
// Wallet <-> user linking
// -----------------------------------------------------------------------

test("linkWalletToUser and getUserByWallet roundtrip", async () => {
  const addr = "0x" + "de".repeat(20);
  await linkWalletToUser("user-abc", addr, "ethereum");
  const uid = await getUserByWallet(addr, "ethereum");
  assert.equal(uid, "user-abc");
});

test("linkWalletToUser supports multiple wallets per user", async () => {
  const u = "user-multi";
  await linkWalletToUser(u, "0x" + "01".repeat(20), "ethereum");
  const sol = makeSolanaWallet();
  await linkWalletToUser(u, sol.address, "solana");
  const wallets = await getWalletsForUser(u);
  assert.equal(wallets.length, 2);
  const chains = wallets.map((w) => w.chain).sort();
  assert.deepEqual(chains, ["ethereum", "solana"]);
});

test("linkWalletToUser rejects cross-user collision", async () => {
  const addr = "0x" + "02".repeat(20);
  await linkWalletToUser("owner-1", addr, "ethereum");
  await assert.rejects(
    () => linkWalletToUser("owner-2", addr, "ethereum"),
    /already linked/,
  );
});

test("unlinkWallet removes a wallet", async () => {
  const addr = "0x" + "03".repeat(20);
  await linkWalletToUser("user-to-unlink", addr, "ethereum");
  const ok = await unlinkWallet("user-to-unlink", addr);
  assert.equal(ok, true);
  const uid = await getUserByWallet(addr, "ethereum");
  assert.equal(uid, null);
});

test("unlinkWallet returns false for non-matching wallet", async () => {
  const ok = await unlinkWallet("ghost-user", "0x" + "04".repeat(20));
  assert.equal(ok, false);
});

test("getUserByWallet returns null for unknown wallet", async () => {
  const uid = await getUserByWallet("0x" + "05".repeat(20), "ethereum");
  assert.equal(uid, null);
});

test("getUserByWallet returns null for unsupported chain", async () => {
  const uid = await getUserByWallet("whatever", "bitcoin");
  assert.equal(uid, null);
});

// -----------------------------------------------------------------------
// Nonce uniqueness
// -----------------------------------------------------------------------

test("createChallenge generates unique nonces across calls", async () => {
  const addr = "0x" + "06".repeat(20);
  const set = new Set();
  for (let i = 0; i < 20; i += 1) {
    const ch = await createChallenge(addr, "ethereum");
    set.add(ch.nonce);
  }
  assert.equal(set.size, 20);
});

test("base58 encode/decode roundtrip preserves 32-byte key", () => {
  const raw = crypto.randomBytes(32);
  const encoded = base58Encode(raw);
  const decoded = base58Decode(encoded);
  assert.ok(decoded);
  assert.equal(decoded.length, 32);
  assert.equal(Buffer.from(decoded).toString("hex"), raw.toString("hex"));
});
