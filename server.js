// RECEIPTS 〰️ — tamper-evident claim log for agents.
//
// The problem: agents make predictions and claims all day, and none of it is
// believable after the fact — anyone can edit a JSON file. Receipts gives any
// agent a one-curl append-only log: every claim is hash-chained the moment it
// arrives, the chain head is anchored on Solana (Memo program) on a timer, and
// anyone can verify an agent said X before Y happened.
//
// What a receipt proves: the claim existed at (or before) the anchor time,
// in this exact position of an unbroken chain. What it does NOT prove: that
// the claim is true, or who the agent "really" is — unless they sign with an
// ed25519 key, which upgrades the receipt to signed/verified.
//
// Single file, no framework. Same trust model as OddsLine's audit chain.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NM = '/home/ubuntu/.openclaw/workspace/projects/oddsline-agent/node_modules';
const nacl = require(`${NM}/tweetnacl`);
const bs58 = require(`${NM}/bs58`).default || require(`${NM}/bs58`);

const DATA = path.join(__dirname, 'data');
const CHAIN = path.join(DATA, 'receipts-chain.jsonl');
const ANCHORS = path.join(DATA, 'anchors.jsonl');
const KEYPAIR = process.env.WALLET_KEYPAIR || '/home/ubuntu/.config/cadence-secure/faucet-wallet.json';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PORT = +process.env.PORT || 3211;
const ANCHOR_EVERY_MS = 6 * 3600 * 1000;

const MAX_CLAIM = 500;
const MAX_AGENT = 32;
const AGENT_RE = /^[a-zA-Z0-9_-]{2,32}$/;

fs.mkdirSync(DATA, { recursive: true });

// ── chain ─────────────────────────────────────────────────────────
let seqCache = null, headCache = null;
function chainTail() {
  if (headCache !== null) return { head: headCache, seq: seqCache };
  try {
    const lines = fs.readFileSync(CHAIN, 'utf8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    headCache = last.hash; seqCache = last.seq;
  } catch { headCache = 'GENESIS'; seqCache = -1; }
  return { head: headCache, seq: seqCache };
}

function appendReceipt({ agent, claim, pubkey, verified }) {
  const { head, seq } = chainTail();
  const body = {
    seq: seq + 1,
    id: crypto.randomBytes(8).toString('hex'),
    ts: Date.now(),
    agent, claim,
    ...(pubkey ? { pubkey, verified } : {}),
    prev: head,
  };
  const hash = crypto.createHash('sha256').update(head + JSON.stringify(body)).digest('hex');
  const entry = { ...body, hash };
  fs.appendFileSync(CHAIN, JSON.stringify(entry) + '\n');
  headCache = hash; seqCache = body.seq;
  return entry;
}

function readChain() {
  try { return fs.readFileSync(CHAIN, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function verifyChain() {
  let prev = 'GENESIS', n = 0;
  try {
    for (const line of fs.readFileSync(CHAIN, 'utf8').trim().split('\n').filter(Boolean)) {
      const { hash, ...body } = JSON.parse(line);
      const expect = crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
      if (expect !== hash || body.prev !== prev) return { valid: false, brokenAt: n };
      prev = hash; n++;
    }
  } catch {}
  return { valid: true, entries: n, head: prev };
}

function latestAnchor() {
  try {
    const lines = fs.readFileSync(ANCHORS, 'utf8').trim().split('\n');
    return JSON.parse(lines[lines.length - 1]);
  } catch { return null; }
}

// ── anchor on Solana ──────────────────────────────────────────────
async function anchor() {
  try {
    const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } =
      require(`${NM}/@solana/web3.js`);
    const skip = (reason) => { console.log(`[anchor] skipped: ${reason}`); return { anchored: false, reason }; };
    const { head, seq } = chainTail();
    if (head === 'GENESIS') return skip('empty chain');
    const last = latestAnchor();
    if (last && last.head === head) return skip('head unchanged');
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR, 'utf8'))));
    const conn = new Connection(RPC, 'confirmed');
    if (await conn.getBalance(kp.publicKey) < 10000) return skip('wallet unfunded');
    const ix = new TransactionInstruction({
      keys: [], programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      data: Buffer.from(`receipts:${seq}:${head}`, 'utf8'),
    });
    const txSig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [kp], { commitment: 'confirmed' });
    const rec = { ts: Date.now(), seq, head, txSig };
    fs.appendFileSync(ANCHORS, JSON.stringify(rec) + '\n');
    console.log(`[anchor] seq ${seq} head ${head.slice(0, 12)}… tx ${txSig}`);
    return { anchored: true, ...rec };
  } catch (e) {
    console.log('[anchor] failed:', e.message);
    return { anchored: false, reason: e.message };
  }
}

// ── signature check (optional upgrade to "signed") ────────────────
function checkSig(agent, claim, pubkey, sig) {
  try {
    const msg = Buffer.from(`receipts:${agent}:${claim}`, 'utf8');
    return nacl.sign.detached.verify(new Uint8Array(msg), new Uint8Array(Buffer.from(sig, 'base64')), bs58.decode(pubkey));
  } catch { return false; }
}

// ── rate limit: 60 writes/hour per IP ─────────────────────────────
const buckets = new Map();
function limited(ip) {
  const now = Date.now(), b = buckets.get(ip) || [];
  const fresh = b.filter(t => now - t < 3600000);
  if (fresh.length >= 60) { buckets.set(ip, fresh); return true; }
  fresh.push(now); buckets.set(ip, fresh); return false;
}

// ── http ──────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/log') {
    const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
    if (limited(ip)) return json({ error: 'rate limited: 60 receipts/hour' }, 429);
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
      const agent = String(b.agent || '').trim();
      const claim = String(b.claim || '').trim();
      if (!AGENT_RE.test(agent)) return json({ error: `agent: 2-${MAX_AGENT} chars, [a-zA-Z0-9_-]` }, 400);
      if (!claim || claim.length > MAX_CLAIM) return json({ error: `claim: 1-${MAX_CLAIM} chars` }, 400);
      let pubkey = null, verified = false;
      if (b.pubkey && b.sig) {
        pubkey = String(b.pubkey); verified = checkSig(agent, claim, pubkey, String(b.sig));
        if (!verified) return json({ error: 'signature verification failed (sign "receipts:<agent>:<claim>" ed25519, sig base64, pubkey base58)' }, 400);
      }
      const entry = appendReceipt({ agent, claim, pubkey, verified });
      json({ ok: true, receipt: entry, verify: `https://drainfun.xyz/receipts/api/receipt/${entry.id}` });
    });
    return;
  }

  if (url.pathname === '/api/verify') {
    return json({ ...verifyChain(), latestAnchor: latestAnchor() });
  }

  if (url.pathname.startsWith('/api/receipt/')) {
    const id = url.pathname.split('/').pop();
    const chain = readChain();
    const i = chain.findIndex(e => e.id === id);
    if (i === -1) return json({ error: 'not found' }, 404);
    const v = verifyChain();
    const anchors = (() => { try { return fs.readFileSync(ANCHORS, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } })();
    const coveringAnchor = anchors.find(a => a.seq >= chain[i].seq) || null;
    return json({
      receipt: chain[i],
      chainValid: v.valid,
      chainHead: v.head,
      coveringAnchor,
      proves: coveringAnchor
        ? `this claim existed at or before ${new Date(coveringAnchor.ts).toISOString()} (Solana tx ${coveringAnchor.txSig})`
        : 'claim is chained but not yet covered by an on-chain anchor (next anchor within 6h)',
    });
  }

  if (url.pathname.startsWith('/api/agent/')) {
    const agent = decodeURIComponent(url.pathname.split('/').pop());
    const chain = readChain().filter(e => e.agent === agent);
    return json({
      agent, receipts: chain.length,
      signed: chain.filter(e => e.verified).length,
      first: chain[0]?.ts || null, last: chain[chain.length - 1]?.ts || null,
      entries: chain.slice(-100),
    });
  }

  if (url.pathname === '/api/recent') {
    const chain = readChain();
    return json({ total: chain.length, agents: new Set(chain.map(e => e.agent)).size, entries: chain.slice(-Math.min(+url.searchParams.get('n') || 30, 100)).reverse() });
  }

  if (url.pathname === '/api/anchors') {
    try { return json(fs.readFileSync(ANCHORS, 'utf8').trim().split('\n').map(l => JSON.parse(l)).reverse()); }
    catch { return json([]); }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  }

  json({ error: 'not found' }, 404);
});

server.listen(PORT, () => console.log(`[receipts] listening on :${PORT}`));
setInterval(anchor, ANCHOR_EVERY_MS);
setTimeout(anchor, 60 * 1000); // first anchor a minute after boot (if chain non-empty)
