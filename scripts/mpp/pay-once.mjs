#!/usr/bin/env node
// Pays ONE URL with mppx and prints the HTTP status plus the decoded receipt.
//
//   node scripts/mpp/pay-once.mjs <url> [--legacy] [--body '{"k":"v"}'] [--method POST]
//
// Default client is mppx 0.13.x; --legacy switches to the pinned mppx 0.8.19
// alias ("mppx-legacy" in package.json). The wallet key is read from the
// PRIVATE_KEY environment variable (or the local dotenv file); it is never
// accepted as an argument and never printed. The response body is not printed.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
try { require('dotenv').config(); } catch { /* dotenv is optional */ }

const argv = process.argv.slice(2);
const legacy = argv.indexOf('--legacy') !== -1;
const flagValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
const method = flagValue('--method', 'POST');
const body = flagValue('--body', '{}');

if (!url) {
  process.stderr.write('usage: pay-once.mjs <url> [--legacy] [--body JSON] [--method POST]\n');
  process.exit(2);
}

const wallet = process.env.PRIVATE_KEY || '';
if (!wallet) {
  process.stderr.write('PRIVATE_KEY is not set in the environment\n');
  process.exit(2);
}

const { privateKeyToAccount } = require('viem/accounts');
const { Mppx, tempo } = require(legacy ? 'mppx-legacy/client' : 'mppx/client');

const account = privateKeyToAccount(wallet);
const client = Mppx.create({ polyfill: false, methods: [tempo({ account })] });

const headers = { 'Content-Type': 'application/json' };
if (process.env.API_KEY) headers.Authorization = `Bearer ${process.env.API_KEY}`;

const res = await client.fetch(url, { method, headers, body: method === 'GET' ? undefined : body });

let receipt = null;
const raw = res.headers.get('payment-receipt');
if (raw) {
  try {
    receipt = JSON.parse(Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch { receipt = null; }
}

process.stdout.write(`client=${legacy ? 'mppx-0.8.19' : 'mppx-0.13.x'} status=${res.status}\n`);
if (receipt) {
  process.stdout.write(`receipt method=${receipt.method} status=${receipt.status} reference=${receipt.reference}\n`);
} else {
  process.stdout.write('receipt none\n');
}
process.exitCode = res.status === 200 && receipt ? 0 : 1;
