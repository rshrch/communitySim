const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');
const fs = require('fs');
const net = require('net');
const StellarSdk = require('@stellar/stellar-sdk');

const {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Operation,
  Account,
  Horizon
} = StellarSdk;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const HORIZON_TEST = 'https://horizon-testnet.stellar.org';
const FRIEND_PREFIX = 'https://friendbot.stellar.org/?addr=';

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

const server = new Horizon.Server(HORIZON_TEST, { agent: socks });

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

async function createAndSubmitTxs(keypair, count = 10) {
  const results = [];

  for (let i = 0; i < count; i++) {
    const loadedAccount = await server.loadAccount(keypair.publicKey());
    const txAccount = new Account(loadedAccount.accountId(), loadedAccount.sequence);

    const destination = Keypair.random().publicKey();

    const tx = new TransactionBuilder(txAccount, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.createAccount({
        destination,
        startingBalance: '1',
      }))
      .setTimeout(30)
      .build();

    tx.sign(keypair);

    try {
      const res = await server.submitTransaction(tx);
      results.push({ status: 'fulfilled', value: res });
    } catch (err) {
      console.error(`❌ TX ${i + 1} failed:`, err.response?.data?.extras?.result_codes || err.message);
      results.push({ status: 'rejected', reason: err });
    }
  }

  return results;
}

(async () => {
  try {
    console.log('🟢 Proxy is ready.');
    await waitForProxyReady();

    console.log('🔧 Creating 10 worker accounts...');
    const workers = [];

    for (let i = 0; i < 10; i++) {
      const keypair = Keypair.random();
      const pubkey = keypair.publicKey();

      console.log(`🔄 Funding worker ${i + 1}: ${pubkey}`);
      await fundAccount(pubkey);
      await waitForBalance(pubkey, 100);
      workers.push(keypair);
    }

    console.log('📤 Submitting 100 transactions across 10 funders...');
    const start = Date.now();
    const allResults = [];

    for (let i = 0; i < workers.length; i++) {
      console.log(`📥 Submitting with worker ${i + 1}`);
      const res = await createAndSubmitTxs(workers[i], 10);
      allResults.push(...res);
    }

    const duration = (Date.now() - start) / 1000;
    const success = allResults.filter(r => r.status === 'fulfilled').length;
    const failed = allResults.filter(r => r.status === 'rejected').length;
    const tps = (success / duration).toFixed(2);

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
