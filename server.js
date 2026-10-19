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
const DEDUPE_WINDOW_HOURS = 24;
const DEDUPE_WINDOW_MS = DEDUPE_WINDOW_HOURS * 60 * 60 * 1000;
const bs58 = require(`${NM}/bs58`).default || require(`${NM}/bs58`);

const DATA = path.join(__dirname, 'data');
const CHAIN = path.join(DATA, 'receipts-chain.jsonl');
const ANCHORS = path.join(DATA, 'anchors.jsonl');
// ── epochs ──
// v1 (Jul–Aug 2026, 914 receipts, Solana-anchored) is frozen read-only in data/archive/.
// v2's first entry chains onto v1's final head, so the fresh start is provably a
// continuation, not a quiet deletion: nothing in v1 can be edited without breaking v2.
const ARCH = path.join(DATA, 'archive');
const V1_CHAIN = path.join(ARCH, 'v1-chain.jsonl');
const V1_ANCHORS = path.join(ARCH, 'v1-anchors.jsonl');
const V1_HEAD = (() => { try { const l = fs.readFileSync(V1_CHAIN, 'utf8').trim().split('\n'); return JSON.parse(l[l.length - 1]).hash; } catch { return null; } })();
const GEN = V1_HEAD ? `v1:${V1_HEAD}` : 'GENESIS';
const KEYPAIR = process.env.WALLET_KEYPAIR || '/home/ubuntu/.config/cadence-secure/faucet-wallet.json';
const RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const PORT = +process.env.PORT || 3211;
const ANCHOR_EVERY_MS = 3600 * 1000; // hourly chain-head anchor (OTS is free, so no reason to wait 6h)

const MAX_CLAIM = 500;
const MAX_AGENT = 32;
const MAX_INTENT = 2000; // serialized JSON chars
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
  } catch { headCache = GEN; seqCache = -1; }
  return { head: headCache, seq: seqCache };
}

// ── bitcoin clock: lower bound on time ────────────────────────────
// Each receipt commits to the latest Bitcoin block hash it saw. Nobody can know
// a block hash before the block is mined, so the receipt provably was written
// AFTER that block. The OTS stamp below bounds it from the other side (BEFORE).
let btcTip = null;
async function refreshBtcTip() {
  try {
    const r = await fetch('https://mempool.space/api/blocks/tip/hash', { signal: AbortSignal.timeout(8000) });
    const h = await fetch('https://mempool.space/api/blocks/tip/height', { signal: AbortSignal.timeout(8000) });
    if (r.ok && h.ok) btcTip = { btcHash: (await r.text()).trim(), btcHeight: +(await h.text()) };
  } catch {}
}
refreshBtcTip(); setInterval(refreshBtcTip, 60 * 1000);

function appendReceipt({ agent, claim, intent, pubkey, verified, sigCovers }) {
  const { head, seq } = chainTail();
  const body = {
    seq: seq + 1,
    id: crypto.randomBytes(8).toString('hex'),
    ts: Date.now(),
    agent, claim,
    ...(intent ? { intent } : {}),
    ...(pubkey ? { pubkey, verified, sigCovers } : {}),
    ...(btcTip ? { after: btcTip } : {}),
    prev: head,
  };
  const hash = crypto.createHash('sha256').update(head + JSON.stringify(body)).digest('hex');
  const entry = { ...body, hash };
  fs.appendFileSync(CHAIN, JSON.stringify(entry) + '\n');
  headCache = hash; seqCache = body.seq;
  return entry;
}

function readChain(file = CHAIN) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch { return []; }
}

function verifyChain(file = CHAIN, genesis = GEN) {
  let prev = genesis, n = 0;
  try {
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) {
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
    if (head === GEN) return skip('empty chain');
    const last = latestAnchor();
    if (last && last.head === head) return skip('head unchanged');
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR, 'utf8'))));
    const conn = new Connection(RPC, 'confirmed');
    if (await conn.getBalance(kp.publicKey) < 10000) return otsAnchor(seq, head);
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

// ── free fallback: OpenTimestamps (Bitcoin) when the Solana wallet is dry ──
// Submits the 32-byte chain head to public OTS calendars. The returned proof
// is "pending" until a calendar commits it to a Bitcoin block (~hours); run
// `ots upgrade data/ots/<seq>.ots` later to get the full Bitcoin attestation.
const OTS_DIR = path.join(DATA, 'ots');
const OTS_CALENDARS = ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'];
async function otsStamp(hexDigest, name, timeoutMs = 20000) {
  const digest = Buffer.from(hexDigest, 'hex');
  for (const cal of OTS_CALENDARS) {
    try {
      const r = await fetch(`${cal}/digest`, {
        method: 'POST', body: digest,
        headers: { Accept: 'application/vnd.opentimestamps.v1' }, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) continue;
      const pending = Buffer.from(await r.arrayBuffer());
      const magic = Buffer.from('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294', 'hex');
      fs.mkdirSync(OTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(OTS_DIR, name), Buffer.concat([magic, Buffer.from([0x01, 0x08]), digest, pending]));
      return { calendar: cal, proof: `https://drainfun.xyz/receipts/api/ots/${name}` };
    } catch (e) { console.log(`[ots] ${cal} failed:`, e.message); }
  }
  return null;
}

async function otsAnchor(seq, head) {
  const stamp = await otsStamp(head, `${seq}.ots`);
  if (!stamp) { console.log('[anchor] skipped: wallet unfunded and no OTS calendar reachable'); return { anchored: false, reason: 'wallet unfunded; OTS unreachable' }; }
  const rec = { ts: Date.now(), seq, head, kind: 'ots', ...stamp };
  fs.appendFileSync(ANCHORS, JSON.stringify(rec) + '\n');
  console.log(`[anchor] seq ${seq} head ${head.slice(0, 12)}… OTS via ${stamp.calendar}`);
  return { anchored: true, ...rec };
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
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
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
      // optional structured intent: the "why" behind the claim (reasoning,
      // confidence, constraints, alternatives rejected — any JSON object).
      // Chained like everything else, so it's tamper-evident even unsigned.
      let intent = null;
      if (b.intent !== undefined) {
        if (typeof b.intent !== 'object' || b.intent === null || Array.isArray(b.intent))
          return json({ error: 'intent: must be a JSON object' }, 400);
        if (JSON.stringify(b.intent).length > MAX_INTENT)
          return json({ error: `intent: serialized JSON must be ≤${MAX_INTENT} chars` }, 400);
        intent = b.intent;
      }
      // ── duplicate guard ──────────────────────────────────────────
      // An identical claim from the same agent inside DEDUPE_WINDOW is a
      // re-emitting caller, not a new claim. Return the ORIGINAL receipt rather
      // than appending: the chain should be a record of distinct claims, and a
      // claim repeated 25x is noise that dilutes every honest receipt near it.
      // (Not an error — callers keep working and get a usable proof URL back.)
      {
        const cutoff = Date.now() - DEDUPE_WINDOW_MS;
        const prior = readChain();
        for (let i = prior.length - 1; i >= 0; i--) {
          const e = prior[i];
          if (e.ts < cutoff) break;
          if (e.agent === agent && e.claim === claim) {
            return json({
              ok: true, duplicate: true, receipt: e,
              verify: `https://drainfun.xyz/receipts/api/receipt/${e.id}`,
              note: `identical claim already logged by this agent within ${DEDUPE_WINDOW_HOURS}h; returning the original receipt`,
            });
          }
        }
      }

      let pubkey = null, verified = false, sigCovers = null;
      if (b.pubkey && b.sig) {
        pubkey = String(b.pubkey);
        const sig = String(b.sig);
        // sig over claim+intent proves the rationale, not just the claim;
        // plain claim sig still accepted so existing clients don't break
        if (intent && checkSig(agent, `${claim}:${JSON.stringify(intent)}`, pubkey, sig)) {
          verified = true; sigCovers = 'claim+intent';
        } else if (checkSig(agent, claim, pubkey, sig)) {
          verified = true; sigCovers = 'claim';
        }
        if (!verified) return json({ error: 'signature verification failed (sign "receipts:<agent>:<claim>" — or "receipts:<agent>:<claim>:<intent JSON>" to cover intent — ed25519, sig base64, pubkey base58)' }, 400);
      }
      const entry = appendReceipt({ agent, claim, intent, pubkey, verified, sigCovers });
      // instant stamp: this receipt's own hash goes to the OTS calendars right now
      // (calendar-attested in ~1s, Bitcoin-confirmed within hours). The chain is
      // also anchored hourly; this just closes the gap for each claim.
      otsStamp(entry.hash, `r-${entry.id}.ots`, 5000).then(stamp => json({
        ok: true, receipt: entry, stamp: stamp || 'calendar unreachable; covered by next hourly anchor',
        verify: `https://drainfun.xyz/receipts/api/receipt/${entry.id}`,
      }));
    });
    return;
  }

  const otsM = url.pathname.match(/^\/api\/ots\/((?:r-[0-9a-f]{16}|\d+)\.ots)$/);
  if (otsM) {
    try {
      const buf = fs.readFileSync(path.join(OTS_DIR, otsM[1]));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    } catch { return json({ error: 'no such proof' }, 404); }
  }

  if (url.pathname === '/api/verify') {
    return json({ ...verifyChain(), genesis: GEN, latestAnchor: latestAnchor() });
  }

  if (url.pathname.startsWith('/api/receipt/')) {
    const id = url.pathname.split('/').pop();
    // old proof URLs stay valid: fall back to the frozen v1 archive
    let chain = readChain(), epoch = 'v2', i = chain.findIndex(e => e.id === id);
    if (i === -1) { chain = readChain(V1_CHAIN); epoch = 'v1'; i = chain.findIndex(e => e.id === id); }
    if (i === -1) return json({ error: 'not found' }, 404);
    const v = epoch === 'v1' ? verifyChain(V1_CHAIN, 'GENESIS') : verifyChain();
    const anchors = (() => { try { return fs.readFileSync(epoch === 'v1' ? V1_ANCHORS : ANCHORS, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } })();
    const coveringAnchor = anchors.find(a => a.seq >= chain[i].seq) || null;
    return json({
      receipt: chain[i], epoch,
      chainValid: v.valid,
      chainHead: v.head,
      coveringAnchor,
      instantStamp: fs.existsSync(path.join(OTS_DIR, `r-${chain[i].id}.ots`))
        ? `https://drainfun.xyz/receipts/api/ots/r-${chain[i].id}.ots` : null,
      after: chain[i].after
        ? `written after Bitcoin block ${chain[i].after.btcHeight} (${chain[i].after.btcHash})` : null,
      proves: coveringAnchor
        ? `this claim existed at or before ${new Date(coveringAnchor.ts).toISOString()} (${coveringAnchor.kind === 'ots' ? `Bitcoin via OpenTimestamps, proof ${coveringAnchor.proof}` : `Solana tx ${coveringAnchor.txSig}`})`
        : 'claim is chained but not yet covered by a chain anchor (next anchor within 1h); see instantStamp',
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
      archivedV1: readChain(V1_CHAIN).filter(e => e.agent === agent).length,
    });
  }

  if (url.pathname === '/api/archive') {
    const v1 = readChain(V1_CHAIN);
    return json({
      epoch: 'v1', note: 'frozen 2026-10-19; v2 genesis commits to this final head',
      verify: verifyChain(V1_CHAIN, 'GENESIS'),
      anchors: readChain(V1_ANCHORS).reverse(),
      entries: v1.slice(-Math.min(+url.searchParams.get('n') || 50, 1000)).reverse(),
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

  // self-hosted fonts: visitors' IPs stay off Google's logs (pages-privacy rule)
  const fontM = url.pathname.match(/^\/fonts\/([a-zA-Z0-9._-]+\.(?:css|woff2))$/);
  if (fontM) {
    try {
      const buf = fs.readFileSync(path.join(__dirname, 'public', 'fonts', fontM[1]));
      res.writeHead(200, { 'Content-Type': fontM[1].endsWith('.css') ? 'text/css' : 'font/woff2', 'Cache-Control': (fontM[1].endsWith('.css') ? 'no-cache' : 'public, max-age=604800'), 'Access-Control-Allow-Origin': '*' });
      return res.end(buf);
    } catch { return json({ error: 'not found' }, 404); }
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
