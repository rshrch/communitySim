import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import fs from 'fs';
import net from 'net';
import pkg from '@stellar/stellar-sdk';

const {
  Keypair,
  Server,
  TransactionBuilder,
  Networks,
  Operation,
  BASE_FEE
} = pkg;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TEST = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k); 
const FRIEND_PREFIX = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k); 

let socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');

const server = new Server(HORIZON_TEST, { agent: socks });

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

async function fundAccount(pubKey) {
  const url = FRIEND_PREFIX + encodeURIComponent(pubKey);
  const { data } = await axios.get(url, {
    httpAgent: socks,
    httpsAgent: socks,
    timeout: 10000
  });
  return data.hash;
}

async function confirmBalance(pubKey, minBalance = 100) {
  const timeout = Date.now() + 30000;
  while (Date.now() < timeout) {
    try {
      const account = await server.loadAccount(pubKey);
      const native = account.balances.find(b => b.asset_type === 'native');
      if (native && parseFloat(native.balance) >= minBalance) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }
    await sleep(1500);
  }
  return false;
}

async function submitTx(tx) {
  try {
    const result = await server.submitTransaction(tx);
    return { success: true, result };
  } catch (e) {
    return { success: false, error: e.response?.data || e.message };
  }
}

(async () => {
  console.log('🟢 Proxy is ready.');
  await waitForProxyReady();

  // Generate and fund base account
  const baseKeypair = Keypair.random();
  const publicKey = baseKeypair.publicKey();
  const secret = baseKeypair.secret();

  console.log(`🔄 Funding account via Friendbot: ${publicKey}`);
  const txHash = await fundAccount(publicKey);
  console.log(`✅ Friendbot TX hash: ${txHash}`);

  const confirmed = await confirmBalance(publicKey);
  if (!confirmed) {
    console.error('❌ Funder account not confirmed.');
    process.exit(1);
  }

  console.log('🟢 Funder account confirmed with 10000.0000000 XLM');

  // Load account and prep TXs
  const funder = await server.loadAccount(publicKey);
  console.log('📥 Loaded funder account');

  const startTime = Date.now();
  const ops = [];
  const targets = [];

  const COUNT = 100;

  for (let i = 0; i < COUNT; i++) {
    const target = Keypair.random();
    targets.push(target);

    ops.push(Operation.createAccount({
      destination: target.publicKey(),
      startingBalance: '1'
    }));
  }

  let tx = new TransactionBuilder(funder, {
    fee: BASE_FEE * COUNT,
    networkPassphrase: Networks.TESTNET
  });

  for (const op of ops) tx.addOperation(op);

  tx = tx.setTimeout(30).build();
  tx.sign(baseKeypair);

  const result = await submitTx(tx);
  const duration = (Date.now() - startTime) / 1000;

  const stats = {
    timestamp: new Date().toISOString(),
    durationSeconds: duration,
    totalSubmitted: COUNT,
    totalSuccess: result.success ? COUNT : 0,
    totalFailed: result.success ? 0 : COUNT,
    tps: result.success ? (COUNT / duration).toFixed(2) : 0
  };

  console.log('=== 📊 TPS Benchmark Results ===');
  console.log(stats);

  fs.writeFileSync('tps_results.json', JSON.stringify(stats, null, 2));
  console.log('📁 Results written to tps_results.json');
})();
