import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import fs from 'fs';
import net from 'net';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  BASE_FEE,
  Server,
} from '@stellar/stellar-sdk';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// XOR decode for obfuscation
function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TEST = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k); // testnet
const FRIEND_PREFIX = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k); // friendbot

const TOR_PROXY = 'socks5h://127.0.0.1:3000';
const socks = new SocksProxyAgent(TOR_PROXY);

const horizon = new Server(HORIZON_TEST, { agent: socks });
const http = axios.create({
  httpAgent: socks,
  httpsAgent: socks,
  proxy: false,
  timeout: 30000,
});

// === Benchmark Params ===
const STARTING_BALANCE = '1.5000000';
const DURATION_SEC = 10;
const PARALLEL_TXS = 10;

// === Proxy Check ===
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

// === Fund and Confirm Funder ===
async function fundAccount(pub) {
  const url = FRIEND_PREFIX + encodeURIComponent(pub);
  const { data } = await http.get(url);
  return data.hash;
}

async function confirmBalance(pub, minBalance = 10000) {
  const start = Date.now();
  while (Date.now() - start < 30000) {
    try {
      const acct = await horizon.loadAccount(pub);
      const native = acct.balances.find(b => b.asset_type === 'native');
      if (native && parseFloat(native.balance) >= minBalance) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }
    await sleep(1500);
  }
  return false;
}

// === Benchmark Logic ===
async function benchmarkTPS(funder) {
  let totalSubmitted = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  const startTime = Date.now();
  const endTime = startTime + DURATION_SEC * 1000;

  let lastSeq = null;

  while (Date.now() < endTime) {
    let account;
    try {
      account = await horizon.loadAccount(funder.publicKey());
      lastSeq = BigInt(account.sequence);
      console.log(`📥 Loaded funder account with seq: ${lastSeq}`);
    } catch (err) {
      console.error('❌ Failed to load funder account:', err.message);
      break;
    }

    const txs = [];
    for (let i = 0; i < PARALLEL_TXS; i++) {
      const dest = Keypair.random().publicKey();
      const tx = new TransactionBuilder(
        { accountId: funder.publicKey(), sequence: (lastSeq + BigInt(i + 1)).toString() },
        {
          fee: BASE_FEE.toString(),
          networkPassphrase: Networks.TESTNET,
        }
      )
        .addOperation(Operation.createAccount({
          destination: dest,
          startingBalance: STARTING_BALANCE,
        }))
        .setTimeout(30)
        .build();

      tx.sign(funder);
      txs.push(tx);
    }

    const submits = txs.map(tx =>
      horizon.submitTransaction(tx)
        .then(() => { totalSuccess++; })
        .catch(err => {
          totalFailed++;
          console.warn('⚠️ TX failed:', err?.response?.data?.extras?.result_codes || err.message);
        })
    );

    await Promise.allSettled(submits);
    totalSubmitted += PARALLEL_TXS;
    lastSeq += BigInt(PARALLEL_TXS);
  }

  const duration = (Date.now() - startTime) / 1000;
  const tps = totalSuccess / duration;

  const result = {
    timestamp: new Date().toISOString(),
    durationSeconds: duration,
    totalSubmitted,
    totalSuccess,
    totalFailed,
    tps: Number(tps.toFixed(2)),
  };

  console.log(`\n=== 📊 TPS Benchmark Results ===`);
  console.log(result);

  fs.writeFileSync('tps_results.json', JSON.stringify(result, null, 2));
  console.log(`📁 Results written to tps_results.json`);
}

// === Entry Point ===
(async () => {
  try {
    console.log('🔌 Checking proxy...');
    await waitForProxyReady();
    console.log('🟢 Proxy is ready.');
  } catch (e) {
    console.error('🔴 Proxy error:', e.message);
    process.exit(1);
  }

  const funder = Keypair.random();
  console.log(`🔄 Funding account via Friendbot: ${funder.publicKey()}`);

  try {
    const tx = await fundAccount(funder.publicKey());
    console.log(`✅ Friendbot TX hash: ${tx}`);
  } catch (e) {
    console.error('❌ Friendbot error:', e.message);
    process.exit(1);
  }

  const confirmed = await confirmBalance(funder.publicKey());
  if (!confirmed) {
    console.error('❌ Funder balance not confirmed.');
    process.exit(1);
  }

  console.log('🟢 Funder account confirmed with 10000.0000000 XLM');
  await benchmarkTPS(funder);
})();
