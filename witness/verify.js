// node verify.js <eventId> : fetch event back from each relay by id, check sig, author, and head against the local chain
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Relay, useWebSocketImplementation } = require('nostr-tools/relay');
const { verifyEvent, nip19 } = require('nostr-tools');
useWebSocketImplementation(WebSocket);

const OUR_NPUB = 'npub1ttk8qp7mnevv9ply7qqez5gycfqw93enpkrgqlgyzpg2jh0s8f2q0l7hhc';
const OUR_PK = nip19.decode(OUR_NPUB).data;
const chain = fs.readFileSync(path.join(__dirname, '..', 'data', 'receipts-chain.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const bySeq = new Map(chain.map(e => [String(e.seq), e.hash]));

const id = process.argv[2];
if (!id) { console.error('usage: node verify.js <eventId>'); process.exit(2); }
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
