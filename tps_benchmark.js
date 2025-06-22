const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');
const fs = require('fs');
const net = require('net');
const sdk = require('@stellar/stellar-sdk');

const { Keypair, TransactionBuilder, Networks, Operation, BASE_FEE, Horizon } = sdk;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// === XOR-encoded URL Decoder ===
function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TESTNET = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k);
const FRIEND_BOT      = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k);

const socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:3000');
const axiosClient = axios.create({
  httpAgent: socksAgent,
  httpsAgent: socksAgent,
  proxy: false,
  timeout: 15000,
});

const horizon = new Horizon.Server(HORIZON_TESTNET, { agent: socksAgent });

async function waitForProxy(port = 3000, host = '127.0.0.1', timeout = 10000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.on('connect', () => { sock.destroy(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeout) return reject(new Error('Proxy timeout'));
        setTimeout(check, 500);
      });
      sock.on('timeout', () => {
        sock.destroy();
        if (Date.now() - start > timeout) return reject(new Error('Proxy timeout'));
        setTimeout(check, 500);
      });
      sock.connect(port, host);
    };
    check();
  });
}

async function fundViaFriendbot(pubkey) {
  console.log(`🔄 Funding account via Friendbot: ${pubkey}`);
  const { data } = await axiosClient.get(`${FRIEND_BOT}${encodeURIComponent(pubkey)}`);
  console.log(`✅ Friendbot TX hash: ${data.hash}`);
}

async function waitForFunderConfirmation(pubkey, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const account = await horizon.loadAccount(pubkey);
      const native = account.balances.find(b => b.asset_type === 'native');
      if (native && parseFloat(native.balance) >= 10000) {
        console.log(`🟢 Funder account confirmed with ${native.balance} XLM`);
        return account;
      }
    } catch (e) {
      if (e?.response?.status !== 404) throw e;
    }
    await sleep(1000);
  }
  throw new Error('❌ Timeout: Funder account never confirmed by Horizon');
}

async function benchmarkTPS(funder) {
  const startTime = Date.now();
  const durationMs = 10000; // 10 seconds
  let submitted = 0;
  let success = 0;
  let failed = 0;

  while (Date.now() - startTime < durationMs) {
    try {
      const recipient = Keypair.random();
      const funderAcc = await horizon.loadAccount(funder.publicKey());
      const tx = new TransactionBuilder(funderAcc, {
        fee: BASE_FEE,
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(Operation.createAccount({
          destination: recipient.publicKey(),
          startingBalance: '1.5',
        }))
        .setTimeout(30)
        .build();

      tx.sign(funder);
      await horizon.submitTransaction(tx);
      success++;
    } catch (e) {
      failed++;
    }
    submitted++;
  }

  const elapsedSec = (Date.now() - startTime) / 1000;
  const tps = (success / elapsedSec).toFixed(2);

  const result = {
    timestamp: new Date().toISOString(),
    durationSeconds: elapsedSec,
    totalSubmitted: submitted,
    totalSuccess: success,
    totalFailed: failed,
    tps: parseFloat(tps),
  };

  console.log('=== 📊 TPS Benchmark Results ===');
  console.log(result);

  fs.writeFileSync('tps_results.json', JSON.stringify(result, null, 2));
  console.log('📁 Results written to tps_results.json');
}

(async () => {
  try {
    console.log('🔌 Waiting for proxy...');
    await waitForProxy();
    console.log('🟢 Proxy is ready.');

    const funder = Keypair.random();
    await fundViaFriendbot(funder.publicKey());
    await waitForFunderConfirmation(funder.publicKey());

    await benchmarkTPS(funder);
  } catch (e) {
    console.error('❌ Benchmark failed:', e.message);
    process.exit(1);
  }
})();
