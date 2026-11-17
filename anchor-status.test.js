// Anchoring tests, offline: a fake OpenTimestamps calendar on localhost.
//  - no WALLET_KEYPAIR: the hourly anchor must still happen (via OTS), not be skipped
//  - a pending OTS anchor must be reported as pending, and only become a Bitcoin claim once the file has an attestation
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-anchor-'));
const PORT = 38000 + Math.floor(Math.random() * 900);
const CAL_PORT = PORT + 1000;
const base = `http://127.0.0.1:${PORT}`;
let pass = 0, total = 0;
const ok = (name, cond) => { total++; if (cond) { pass++; console.log('PASS', name); } else console.log('FAIL', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex');
const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex');

const cal = http.createServer((req, res) => {
  req.resume(); req.on('end', () => { res.writeHead(200); res.end(Buffer.concat([Buffer.from([0xff]), PENDING_TAG, Buffer.from([0x03, 0x01, 0x02, 0x03])])); });
}).listen(CAL_PORT);
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), RECEIPTS_DATA: DATA, WALLET_KEYPAIR: '', RECEIPTS_FIRST_ANCHOR_MS: '1500',
    RECEIPTS_OTS_CALENDARS: `http://127.0.0.1:${CAL_PORT}`, RECEIPTS_PUBLIC_BASE: base },
  stdio: ['ignore', 'pipe', 'pipe'],
});

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/recent'); break; } catch { await sleep(200); } }
    const lr = await fetch(base + '/api/log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'anchor-test', claim: 'anchor me without a wallet' }) });
    const entry = (await lr.json()).receipt;
    let anchors = [];
    for (let i = 0; i < 40 && !anchors.length; i++) { await sleep(250); anchors = await (await fetch(base + '/api/anchors')).json(); }
    ok('with no WALLET_KEYPAIR the hourly anchor still runs, via OTS', anchors.length === 1 && anchors[0].kind === 'ots' && anchors[0].seq === entry.seq && anchors[0].head === entry.hash);
    ok('a fresh OTS anchor is reported as pending', anchors[0] && anchors[0].status === 'pending');

    const r1 = await (await fetch(`${base}/api/receipt/${entry.id}`)).json();
    ok('receipt: covering anchor is pending, not confirmed', r1.coveringAnchor && r1.coveringAnchor.status === 'pending');
    ok('receipt: pending anchor is not presented as a Bitcoin proof', /^PENDING/.test(r1.proves) && /not yet in a Bitcoin block/.test(r1.proves) && !/Bitcoin via OpenTimestamps/.test(r1.proves));
    ok('receipt: the instant stamp is pending too', r1.instantStatus === 'pending');

    // what `ots upgrade` does to the file: the pending attestation is replaced by a Bitcoin one
    const f = path.join(DATA, 'ots', `${entry.seq}.ots`);
    fs.writeFileSync(f, Buffer.concat([fs.readFileSync(f), BITCOIN_TAG, Buffer.from([0x01, 0x05])]));
    const r2 = await (await fetch(`${base}/api/receipt/${entry.id}`)).json();
    ok('after upgrade the same anchor reads as confirmed', r2.coveringAnchor.status === 'confirmed' && /Bitcoin block/.test(r2.proves) && !/^PENDING/.test(r2.proves));

    fs.unlinkSync(f);
    const r3 = await (await fetch(`${base}/api/receipt/${entry.id}`)).json();
    ok('a missing proof file is reported as missing, never confirmed', r3.coveringAnchor.status === 'missing');

    const w = await (await fetch(base + '/api/witness')).json();
    ok('/api/witness answers (empty here) with verify instructions', Array.isArray(w.events) && /verify\.js/.test(w.verify));
    const ch = await (await fetch(base + '/api/chain')).text();
    ok('/api/chain serves the raw chain', ch.trim().split('\n').length === 1 && JSON.parse(ch.trim()).hash === entry.hash);
  } catch (e) {
    console.log('FAIL test crashed:', e.message); total++;
  } finally {
    srv.kill(); cal.close();
    console.log(`${pass}/${total} pass`);
    process.exit(pass === total ? 0 : 1);
  }
})();
