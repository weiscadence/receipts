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
    // Canary: tamper with the stored claim and the same check must now fail.
    const chain = path.join(DATA, 'receipts-chain.jsonl');
    fs.writeFileSync(chain, fs.readFileSync(chain, 'utf8').replace('logs one claim', 'logs two claims'));
    const t = await (await fetch(base + '/api/verify')).json().catch(() => ({}));
    ok('/api/verify catches an edited claim', !(t.ok === true || t.valid === true || t.intact === true));
    if (!r.ok) console.log('log said:', JSON.stringify(j).slice(0, 300));
  } finally {
    srv.kill();
    console.log(`${pass}/${total} pass`);
    process.exit(pass === total ? 0 : 1);
  }
})();
