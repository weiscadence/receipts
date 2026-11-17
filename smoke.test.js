// Smoke test: start the server on a scratch data dir, log one claim, read it back,
// and check the chain verifies. No keys; Solana anchoring is skipped without WALLET_KEYPAIR.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 39000 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: { ...process.env, PORT: String(PORT), RECEIPTS_DATA: DATA, WALLET_KEYPAIR: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const base = `http://127.0.0.1:${PORT}`;
let srv2 = null;
let pass = 0, total = 0;
const ok = (name, cond) => { total++; if (cond) { pass++; console.log('PASS', name); } else console.log('FAIL', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/api/recent'); break; } catch { await sleep(200); } }
    const r = await fetch(base + '/api/log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'smoke-test', claim: 'the smoke test logs one claim' }),
    });
    const j = await r.json().catch(() => ({}));
    ok('POST /api/log accepts a claim', r.ok);
    const recent = await (await fetch(base + '/api/recent')).json();
    ok('the claim shows up in /api/recent', JSON.stringify(recent).includes('the smoke test logs one claim'));
    const v = await fetch(base + '/api/verify');
    const vj = await v.json().catch(() => ({}));
    ok('/api/verify reports an intact chain', v.ok && (vj.ok === true || vj.valid === true || vj.intact === true));
    if (!(vj.ok === true || vj.valid === true || vj.intact === true)) console.log('verify said:', JSON.stringify(vj).slice(0, 300));
    const chain = path.join(DATA, 'receipts-chain.jsonl');

    // Signed receipt: the signature itself must be stored, so a reader can re-check it
    // from the chain alone instead of trusting the server's `verified: true`.
    const nacl = require('tweetnacl');
    const bs58 = require('bs58').default || require('bs58');
    const kp = nacl.sign.keyPair();
    const intent = { confidence: 0.5, why: 'smoke' };
    const signedClaim = 'the smoke test signs a claim';
    const signedMsg = `receipts:smoke-test:${signedClaim}:${JSON.stringify(intent)}`;
    const sig = Buffer.from(nacl.sign.detached(Buffer.from(signedMsg, 'utf8'), kp.secretKey)).toString('base64');
    const sr = await fetch(base + '/api/log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'smoke-test', claim: signedClaim, intent, pubkey: bs58.encode(kp.publicKey), sig }),
    });
    const sj = await sr.json().catch(() => ({}));
    ok('POST /api/log accepts a signed claim', sr.ok && sj.receipt && sj.receipt.verified === true && sj.receipt.sigCovers === 'claim+intent');
    const stored = fs.readFileSync(chain, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.claim === signedClaim) || {};
    const storedMsg = `receipts:${stored.agent}:${stored.claim}:${JSON.stringify(stored.intent)}`;
    ok('the stored entry carries a signature that verifies offline', typeof stored.sig === 'string' && stored.sig === sig
      && nacl.sign.detached.verify(Buffer.from(storedMsg, 'utf8'), Buffer.from(stored.sig, 'base64'), bs58.decode(stored.pubkey)));
    const badSig = await fetch(base + '/api/log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'smoke-test', claim: 'a different claim', pubkey: bs58.encode(kp.publicKey), sig }),
    });
    ok('a signature over another claim is rejected', badSig.status === 400);
    const sv = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify still intact with a signed entry', sv.valid === true && sv.entries === 2);

    // Fail closed: a half-written last line must make the chain invalid, not valid-but-shorter,
    // and the server must refuse to append on top of it instead of restarting from genesis.
    const intact = fs.readFileSync(chain, 'utf8');
    fs.writeFileSync(chain, intact + '{"seq":2,"id":"deadbeef","ts":17');
    const g = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify rejects a truncated last line', g.valid === false && g.brokenAt === 2 && typeof g.reason === 'string');
    fs.writeFileSync(chain, 'not json at all\n');
    const g2 = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify rejects a garbled chain', g2.valid === false && g2.brokenAt === 0);
    fs.writeFileSync(chain, intact);
    const g3 = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify accepts the restored chain', g3.valid === true && g3.entries === 2);

    // Canary: tamper with the stored claim and the same check must now fail.
    fs.writeFileSync(chain, fs.readFileSync(chain, 'utf8').replace('logs one claim', 'logs two claims'));
    const t = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify catches an edited claim', !(t.ok === true || t.valid === true || t.intact === true));
    if (!r.ok) console.log('log said:', JSON.stringify(j).slice(0, 300));

    // Rate limit: 60 writes/hour per socket address. Without TRUST_PROXY a client-supplied
    // X-Real-IP must not buy a fresh bucket. (Invalid JSON still spends a slot, and appends nothing.)
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const q = await fetch(base + '/api/log', { method: 'POST', headers: { 'x-real-ip': `10.9.${i}.1` }, body: 'x' });
      last = q.status; await q.text();
    }
    ok('rotating X-Real-IP does not dodge the rate limit', last === 429);

    // Second server: boots on a chain whose tail is garbled, behind a declared proxy.
    const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
    fs.writeFileSync(path.join(DATA2, 'receipts-chain.jsonl'), intact + '{"seq":2,"id":"dead');
    const PORT2 = PORT + 1000, base2 = `http://127.0.0.1:${PORT2}`;
    srv2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: String(PORT2), RECEIPTS_DATA: DATA2, WALLET_KEYPAIR: '', TRUST_PROXY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 50; i++) { try { await fetch(base2 + '/api/recent'); break; } catch { await sleep(200); } }
    const refused = await fetch(base2 + '/api/log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'smoke-test', claim: 'must not fork the chain' }),
    });
    ok('a garbled chain tail refuses new receipts (503) instead of restarting from genesis',
      refused.status === 503 && !fs.readFileSync(path.join(DATA2, 'receipts-chain.jsonl'), 'utf8').includes('must not fork'));
    for (let i = 0; i < 61; i++) {
      const q = await fetch(base2 + '/api/log', { method: 'POST', headers: { 'x-real-ip': `10.9.${i}.1` }, body: 'x' });
      last = q.status; await q.text();
    }
    ok('with TRUST_PROXY=1 the proxy-set X-Real-IP is the rate-limit key', last === 400);
  } finally {
    srv.kill(); if (srv2) srv2.kill();
    console.log(`${pass}/${total} pass`);
    process.exit(pass === total ? 0 : 1);
  }
})();
