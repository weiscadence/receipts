// Dependency-free helpers shared by witness.js and verify.js (and testable without nostr-tools).
'use strict';
const crypto = require('crypto');
const fs = require('fs');

// Public key of the production witness. Published on purpose: this is what a third party pins.
const PINNED_NPUB = 'npub1ttk8qp7mnevv9ply7qqez5gycfqw93enpkrgqlgyzpg2jh0s8f2q0l7hhc';

// Re-derive every hash in a chain. Same rule as server.js verifyChain, except the
// genesis is taken from the first entry (it is 'GENESIS' or 'v1:<hash of the frozen v1 head>').
// Returns { valid, entries, head, seq, genesis } or { valid:false, brokenAt, reason }.
function verifyChainText(text) {
  const lines = String(text).trim().split('\n').filter(Boolean);
  if (!lines.length) return { valid: false, brokenAt: 0, reason: 'empty chain' };
  let prev = null, n = 0, seq = null, genesis = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { return { valid: false, brokenAt: n, reason: 'unparseable entry' }; }
    if (entry === null || typeof entry !== 'object') return { valid: false, brokenAt: n, reason: 'unparseable entry' };
    const { hash, ...body } = entry;
    if (prev === null) {
      genesis = body.prev;
      if (genesis !== 'GENESIS' && !/^v1:[0-9a-f]{64}$/.test(String(genesis))) return { valid: false, brokenAt: 0, reason: 'unrecognised genesis' };
      prev = genesis;
    }
    const expect = crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex');
    if (expect !== hash || body.prev !== prev) return { valid: false, brokenAt: n, reason: 'hash mismatch' };
    prev = hash; seq = body.seq; n++;
  }
  return { valid: true, entries: n, head: prev, seq, genesis };
}

// Read the witness secret key. A missing file is an ERROR: silently minting a new key would
// make every later note fail the author check against the pinned npub.
function readKeyHex(keyfile) {
  if (!fs.existsSync(keyfile)) {
    throw new Error(`witness key file not found: ${keyfile} (refusing to generate one; run with --keygen to create a new identity on purpose)`);
  }
  const hex = fs.readFileSync(keyfile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`witness key file ${keyfile} does not hold a 32-byte hex key`);
  return hex;
}

module.exports = { PINNED_NPUB, verifyChainText, readKeyHex };
