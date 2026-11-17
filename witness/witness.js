#!/usr/bin/env node
// Nostr witness: publish the receipts chain head as a signed Nostr note to public
// relays whenever it changes. Free, instant external witness for the window before
// the Bitcoin OTS stamp confirms. Usage: node witness.js [--force] [--keygen]
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const { generateSecretKey, getPublicKey, finalizeEvent, nip19 } = require('nostr-tools');
const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
useWebSocketImplementation(WebSocket);

const ROOT = path.join(__dirname, '..');
const CHAIN = path.join(ROOT, 'data', 'receipts-chain.jsonl');
const LOG = path.join(ROOT, 'data', 'witness-log.jsonl');
const KEYFILE = process.env.WITNESS_KEY || path.join(os.homedir(), '.config', 'receipts-nostr', 'secret.hex');
const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://relay.damus.io'];
const hex = u => Buffer.from(u).toString('hex');

function loadKey() {
  if (!fs.existsSync(KEYFILE)) {
    fs.mkdirSync(path.dirname(KEYFILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEYFILE, hex(generateSecretKey()) + '\n', { mode: 0o600 });
    console.log('generated new key at', KEYFILE);
  }
  fs.chmodSync(KEYFILE, 0o600);
  return Uint8Array.from(Buffer.from(fs.readFileSync(KEYFILE, 'utf8').trim(), 'hex'));
}

function head() {
  const lines = fs.readFileSync(CHAIN, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  return { hash: last.hash, seq: last.seq, entryTs: last.ts, length: lines.length };
}

function lastLogged() {
  try {
    const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = JSON.parse(lines[i]);
      if (r.acked && r.acked.length) return r;
    }
  } catch {}
  return null;
}

async function publishTo(url, ev) {
  const tmo = (ms, what) => new Promise((_, j) => setTimeout(() => j(new Error(what + ' timeout')), ms));
  const relay = await Promise.race([Relay.connect(url), tmo(10000, 'connect')]);
  try {
    await Promise.race([relay.publish(ev), tmo(10000, 'publish')]);
  } finally { try { relay.close(); } catch {} }
}

async function main() {
  const sk = loadKey();
  const pk = getPublicKey(sk);
  if (process.argv.includes('--keygen')) { console.log('npub', nip19.npubEncode(pk)); return; }
  const h = head();
  const prev = lastLogged();
  if (!process.argv.includes('--force') && prev && prev.head === h.hash) return; // unchanged
  const ts = new Date().toISOString();
  const content = `receipts chain head\nseq: ${h.seq}\nhead: ${h.hash}\nchain length: ${h.length}\nwitnessed: ${ts}\nhttps://drainfun.xyz/receipts`;
  const ev = finalizeEvent({
    kind: 1, created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'receipts-chain-head'], ['seq', String(h.seq)], ['head', h.hash]],
    content,
  }, sk);
  const acked = [], failed = {};
  await Promise.all(RELAYS.map(async u => {
    try { await publishTo(u, ev); acked.push(u); } catch (e) { failed[u] = String(e.message || e); }
  }));
  const rec = { ts, head: h.hash, seq: h.seq, eventId: ev.id, npub: nip19.npubEncode(pk), acked, failed };
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
  console.log(JSON.stringify(rec));
  if (!acked.length) process.exit(1);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
