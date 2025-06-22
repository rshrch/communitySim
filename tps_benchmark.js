#!/usr/bin/env node

const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');
const fs = require('fs');
const net = require('net');
const StellarSdk = require('@stellar/stellar-sdk');
const minimist = require('minimist');

const {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Operation,
  Account
} = StellarSdk;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TEST  = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k);
const FRIEND_PREFIX = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k);

const args = minimist(process.argv.slice(2));
const TOTAL_TXS = parseInt(args.txs || 100);
const FUNDERS = parseInt(args.funders || 1);

async function waitForProxyReady(port = 3000, host = '127.0.0.1', timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start >= timeout) return reject(new Error('Proxy timeout'));
        setTimeout(check, 500);
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (Date.now() - start >= timeout) return reject(new Error('Proxy timeout'));
        setTimeout(check, 500);
      });
      sock.connect(port, host);
    };
    check();
  });
}

let socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');
function createHttp() {
  return axios.create({
    httpAgent: socks,
    httpsAgent: socks,
    proxy: false,
    timeout: 30000,
  });
}
let http = createHttp();

const server = new StellarSdk.Horizon.Server(HORIZON_TEST, { agent: socks });

async function fundAccount(pubkey) {
  const res = await http.get(FRIEND_PREFIX + encodeURIComponent(pubkey));
  return res.data.hash;
}

async function waitForBalance(pubkey, min = 1) {
  const start = Date.now();
  const timeout = 20000;
  while (Date.now() - start < timeout) {
    try {
      const acct = await server.loadAccount(pubkey);
      const bal = acct.balances.find(b => b.asset_type === 'native');
      if (bal && parseFloat(bal.balance) >= min) return bal.balance;
    } catch (e) {}
    await sleep(1000);
  }
  throw new Error('Balance check timed out');
}

async function createAndSubmitPayments(funder, funderKey, count) {
  const account = await server.loadAccount(funder);
  const baseSeq = account.sequence;
  const txs = [];
  const createdAccounts = [];

  for (let i = 0; i < count; i++) {
    const newKey = Keypair.random();
    createdAccounts.push(newKey);

    const acc = new Account(funder, (BigInt(baseSeq) + BigInt(i + 1)).toString());

    const tx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.createAccount({
        destination: newKey.publicKey(),
        startingBalance: '1',
      }))
      .setTimeout(30)
      .build();

    tx.sign(funderKey);
    txs.push(tx);
  }

  const submitted = await Promise.allSettled(txs.map(tx => server.submitTransaction(tx)));
  return { submitted, createdAccounts };
}

async function mergeBackAccounts(accounts, targetKey) {
  const fundTxs = [];

  for (let key of accounts) {
    try {
      const acct = await server.loadAccount(key.publicKey());
      const tx = new TransactionBuilder(acct, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET
      })
        .addOperation(Operation.accountMerge({ destination: targetKey.publicKey() }))
        .setTimeout(30)
        .build();

      tx.sign(key);
      fundTxs.push(tx);
    } catch (e) {
      continue;
    }
  }

  return await Promise.allSettled(fundTxs.map(tx => server.submitTransaction(tx)));
}

(async () => {
  try {
    console.log('🟢 Waiting for proxy...');
    await waitForProxyReady();
    console.log('🟢 Proxy is ready.');

    const perFunder = Math.ceil(TOTAL_TXS / FUNDERS);
    const funders = [];

    for (let i = 0; i < FUNDERS; i++) {
      const key = Keypair.random();
      console.log(`🔄 Funding account via Friendbot: ${key.publicKey()}`);
      await fundAccount(key.publicKey());
      await waitForBalance(key.publicKey(), 10000);
      funders.push(key);
    }

    const allResults = [];
    const allAccounts = [];
    const start = Date.now();

    for (let i = 0; i < funders.length; i++) {
      console.log(`📥 Submitting with funder ${i + 1}`);
      const { submitted, createdAccounts } = await createAndSubmitPayments(
        funders[i].publicKey(),
        funders[i],
        perFunder
      );
      allResults.push(...submitted);
      allAccounts.push(...createdAccounts);
    }

    const duration = (Date.now() - start) / 1000;
    const success = allResults.filter(r => r.status === 'fulfilled').length;
    const failed = allResults.length - success;
    const tps = (success / duration).toFixed(2);

    console.log(`♻️ Merging ${allAccounts.length} test accounts...`);
    await mergeBackAccounts(allAccounts, funders[0]);

    const stats = {
      timestamp: new Date().toISOString(),
      durationSeconds: duration,
      totalSubmitted: allResults.length,
      totalSuccess: success,
      totalFailed: failed,
      tps: parseFloat(tps),
    };

    console.log('=== 📊 TPS Benchmark Results ===');
    console.log(stats);
    fs.writeFileSync('tps_results.json', JSON.stringify(stats, null, 2));
    console.log('📁 Results written to tps_results.json');
  } catch (e) {
    console.error('❌ Error:', e.message || e);
    process.exit(1);
  }
})();
