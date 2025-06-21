import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import fs from 'fs';
import net from 'net';
import { Horizon, Keypair, TransactionBuilder, Networks, Operation, BASE_FEE } from '@stellar/stellar-sdk';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// === XOR decoder ===
function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

// === Encoded URLs ===
const HORIZON_TEST = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k); 
const FRIEND_BOT   = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a2732', k);

// === Proxy Setup ===
const socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');
const http = axios.create({
  httpAgent: socks,
  httpsAgent: socks,
  proxy: false,
  timeout: 30000,
});

const horizon = new Horizon.Server(HORIZON_TEST, { agent: socks });

// === Benchmark Config ===
const STARTING_BALANCE = '2.5';
const DURATION_SEC = 10;
const PARALLEL_TXS = 100;

// === Port check (wait for Tor on 3000) ===
function waitForPort(port = 3000, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start >= timeout) return reject(new Error('SOCKS5 proxy not ready'));
        setTimeout(check, 500);
      });
      sock.connect(port, '127.0.0.1');
    };
    check();
  });
}

// === Fund account via friendbot ===
async function fundViaFriendbot(pubkey) {
  const url = `${FRIEND_BOT}/?addr=${encodeURIComponent(pubkey)}`;
  try {
    console.log(`🔄 Funding account via Friendbot: ${pubkey}`);
    const res = await http.get(url);
    console.log(`✅ Friendbot TX hash: ${res.data.hash}`);
  } catch (err) {
    console.error('❌ Friendbot funding failed:', err?.response?.data || err.message);
    throw err;
  }
}

// === Create TX ===
function createTx(sourceAccount, funder, dest, sequence) {
  const tx = new TransactionBuilder(
    { accountId: funder.publicKey(), sequence: sequence.toString() },
    {
      fee: BASE_FEE.toString(),
      networkPassphrase: Networks.TESTNET,
    }
  )
    .addOperation(
      Operation.createAccount({
        destination: dest,
        startingBalance: STARTING_BALANCE,
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(funder);
  return tx;
}

// === Benchmark Function ===
async function benchmarkTPS(funder) {
  let totalSubmitted = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  const startTime = Date.now();
  const endTime = startTime + DURATION_SEC * 1000;

  while (Date.now() < endTime) {
    const account = await horizon.loadAccount(funder.publicKey());
    const sequence = BigInt(account.sequence);

    const batch = Array.from({ length: PARALLEL_TXS }, async (_, i) => {
      const dest = Keypair.random().publicKey();
      const tx = createTx(account, funder, dest, sequence + BigInt(i + 1));

      try {
        await horizon.submitTransaction(tx);
        totalSuccess++;
      } catch (e) {
        totalFailed++;
        console.warn(`⚠️ TX failed:`, e?.response?.data || e.message);
      }
      totalSubmitted++;
    });

    await Promise.allSettled(batch);
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

// === Entrypoint ===
(async () => {
  const funder = Keypair.random();
  console.log(`🔐 Funder Public Key: ${funder.publicKey()}`);
  console.log(`🔑 Funder Secret Key: ${funder.secret()}`);

  try {
    console.log(`⏳ Waiting for Tor SOCKS proxy on port 3000...`);
    await waitForPort(3000);
    console.log(`🟢 Proxy is ready.`);

    await fundViaFriendbot(funder.publicKey());
    await sleep(5000);
    await benchmarkTPS(funder);
  } catch (err) {
    console.error('❌ Benchmark aborted:', err.message || err);
    process.exit(1);
  }
})();
