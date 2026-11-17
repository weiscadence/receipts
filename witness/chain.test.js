// Witness safety tests: dependency-free (no nostr-tools needed), run by `npm test`.
'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyChainText, readKeyHex } = require('./chain');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS', name); };

function mkChain(len, genesis = 'GENESIS') {
  let prev = genesis; const lines = [];
  for (let seq = 0; seq < len; seq++) {
    const body = { seq, id: String(seq).padStart(16, '0'), ts: 1000 + seq, agent: 'a', claim: `c${seq}`, prev };
    const hash = crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
    lines.push(JSON.stringify({ ...body, hash })); prev = hash;
  }
  return lines;
}

t('an intact chain verifies and reports head/seq', () => {
  const lines = mkChain(4);
  const v = verifyChainText(lines.join('\n') + '\n');
  assert.strictEqual(v.valid, true);
  assert.strictEqual(v.seq, 3);
  assert.strictEqual(v.head, JSON.parse(lines[3]).hash);
});
t('a v1-continuation genesis is accepted', () => {
  assert.strictEqual(verifyChainText(mkChain(2, 'v1:' + 'ab'.repeat(32)).join('\n')).valid, true);
});
t('an edited claim is rejected (witness must not sign a rewritten chain)', () => {
  const lines = mkChain(4); lines[1] = lines[1].replace('"c1"', '"edited"');
  const v = verifyChainText(lines.join('\n'));
  assert.strictEqual(v.valid, false); assert.strictEqual(v.brokenAt, 1);
});
t('a rewritten entry with a recomputed hash still breaks the link after it', () => {
  const lines = mkChain(4); const e = JSON.parse(lines[1]); const { hash, ...body } = e;
  body.claim = 'forged';
  e.claim = 'forged'; e.hash = crypto.createHash('sha256').update(body.prev + JSON.stringify(body)).digest('hex');
  lines[1] = JSON.stringify(e);
  assert.strictEqual(verifyChainText(lines.join('\n')).brokenAt, 2);
});
t('a truncated last line, an empty chain, and an unknown genesis are rejected', () => {
  assert.strictEqual(verifyChainText(mkChain(2).join('\n') + '\n{"seq":2,"id":"de').valid, false);
  assert.strictEqual(verifyChainText('').valid, false);
  assert.strictEqual(verifyChainText(mkChain(1, 'somewhere-else').join('\n')).valid, false);
});
t('a missing key file is an error, and no key file is created', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')), 'sub', 'secret.hex');
  assert.throws(() => readKeyHex(f), /not found/);
  assert.strictEqual(fs.existsSync(f), false);
});
t('a malformed key file is an error; a good one is read', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-')); const f = path.join(d, 'k');
  fs.writeFileSync(f, 'nothex\n'); assert.throws(() => readKeyHex(f), /32-byte/);
  fs.writeFileSync(f, 'ab'.repeat(32) + '\n'); assert.strictEqual(readKeyHex(f), 'ab'.repeat(32));
});

// End to end through witness.js itself when its dependencies are installed (cd witness && npm install).
if (fs.existsSync(path.join(__dirname, 'node_modules', 'nostr-tools'))) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));
  const run = (env, args = []) => spawnSync(process.execPath, [path.join(__dirname, 'witness.js'), ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
  t('witness.js exits 1 and generates nothing when the key file is missing', () => {
    const key = path.join(d, 'missing.hex');
    const r = run({ WITNESS_KEY: key });
    assert.strictEqual(r.status, 1); assert.match(r.stderr, /not found/); assert.strictEqual(fs.existsSync(key), false);
  });
  t('witness.js --keygen is the only way to create a key', () => {
    const key = path.join(d, 'new.hex');
    const r = run({ WITNESS_KEY: key }, ['--keygen']);
    assert.strictEqual(r.status, 0); assert.ok(fs.existsSync(key));
  });
} else console.log('SKIP witness.js end-to-end (witness/node_modules not installed)');

console.log(`${n} pass`);
