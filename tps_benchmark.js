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
  Account
} = StellarSdk;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ✅ Use secure Horizon endpoint directly
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

// ✅ Use proper HTTPS and SocksProxyAgent
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

async function createAndSubmitPayments(funder, funderKey, count = 100) {
  const account = await server.loadAccount(funder);
  const baseSeq = account.sequence;
  const txs = [];

  for (let i = 0; i < count; i++) {
    const keypair = Keypair.random();
    const acc = new Account(funder, (BigInt(baseSeq) + BigInt(i + 1)).toString());

    const tx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.createAccount({
        destination: keypair.publicKey(),
        startingBalance: '1',
      }))
      .setTimeout(30)
      .build();

    tx.sign(funderKey);
    txs.push(tx);
  }

  const submitted = await Promise.allSettled(
    txs.map((tx, i) =>
      server.submitTransaction(tx).catch(err => {
        console.error(`❌ TX ${i + 1} failed:`, err.response?.data?.extras?.result_codes || err.message);
        throw err;
      })
    )
  );

  return submitted;
}

(async () => {
  try {
    console.log('🟢 Checking SOCKS5 proxy...');
    await waitForProxyReady();
    console.log('🟢 Proxy is ready.');

    const funderKey = Keypair.random();
    const funder = funderKey.publicKey();

    console.log(`🔄 Funding account via Friendbot: ${funder}`);
    const txHash = await fundAccount(funder);
    console.log(`✅ Friendbot TX hash: ${txHash}`);

    const balance = await waitForBalance(funder, 10000);
    console.log(`🟢 Funder account confirmed with ${balance} XLM`);

    console.log(`📥 Loaded funder account`);

    const start = Date.now();
    const results = await createAndSubmitPayments(funder, funderKey, 100);
    const duration = (Date.now() - start) / 1000;

    const success = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    const tps = (success / duration).toFixed(2);

    const stats = {
      timestamp: new Date().toISOString(),
      durationSeconds: duration,
      totalSubmitted: results.length,
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
