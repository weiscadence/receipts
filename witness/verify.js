// node verify.js <eventId> : fetch event back from each relay by id, check sig, author, and head against the chain.
// The chain is downloaded from the public API (RECEIPTS_URL, default https://drainfun.xyz/receipts) and re-hashed
// locally, so anyone can run this. --local reads data/receipts-chain.jsonl instead (the host's own check).
// Find event ids at GET <RECEIPTS_URL>/api/witness. Pin the npub you trust with WITNESS_NPUB if you do not
// want to rely on the one below.
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
const { verifyEvent, nip19 } = require('nostr-tools');
useWebSocketImplementation(WebSocket);

const { PINNED_NPUB, verifyChainText } = require('./chain');

const OUR_NPUB = process.env.WITNESS_NPUB || PINNED_NPUB;
const OUR_PK = nip19.decode(OUR_NPUB).data;
const BASE = (process.env.RECEIPTS_URL || 'https://drainfun.xyz/receipts').replace(/\/+$/, '');

async function loadChainText() {
  if (process.argv.includes('--local')) return fs.readFileSync(path.join(__dirname, '..', 'data', 'receipts-chain.jsonl'), 'utf8');
  const r = await fetch(`${BASE}/api/chain`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`GET ${BASE}/api/chain -> ${r.status}`);
  return r.text();
}

const id = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!id) { console.error('usage: node verify.js [--local] <eventId>'); process.exit(2); }
let bySeq = new Map();
const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://relay.damus.io'];

function judge(ev) {
  const tag = k => (ev.tags.find(t => t[0] === k) || [])[1];
  const head = tag('head'), seq = tag('seq');
  const sig = verifyEvent(ev);
  const author = ev.pubkey === OUR_PK;
  const match = head && seq && bySeq.get(seq) === head;
  const ok = sig && author && match;
  return `${ok ? 'PASS' : 'FAIL'} sig=${sig} author=${author} chainMatch=${!!match} seq=${seq} head=${(head || '').slice(0, 16)}…`;
}

(async () => {
  const text = await loadChainText();
  const v = verifyChainText(text);
  console.log(v.valid ? `chain: ${v.entries} entries re-hashed OK, head ${v.head.slice(0, 16)}…` : `chain: INVALID (${v.reason} at ${v.brokenAt})`);
  if (!v.valid) process.exit(1);
  bySeq = new Map(text.split('\n').filter(Boolean).map(l => JSON.parse(l)).map(e => [String(e.seq), e.hash]));
  let pass = 0;
  await Promise.all(RELAYS.map(async u => {
    try {
      const r = await Promise.race([Relay.connect(u), new Promise((_, j) => setTimeout(() => j(new Error('connect timeout')), 8000))]);
      const ev = await new Promise(res => {
        const sub = r.subscribe([{ ids: [id] }], { onevent: e => { res(e); sub.close(); }, oneose: () => res(null) });
        setTimeout(() => res(null), 8000);
      });
      const line = ev ? judge(ev) : 'not found';
      if (line.startsWith('PASS')) pass++;
      console.log(u, line);
      r.close();
    } catch (e) { console.log(u, 'error', e.message); }
  }));
  console.log(`${pass}/${RELAYS.length} relays PASS`);
  process.exit(pass > 0 ? 0 : 1);
})();
