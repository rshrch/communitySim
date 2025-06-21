import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import fs from 'fs';

const socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');

const http = axios.create({
  httpAgent: socks,
  httpsAgent: socks,
  proxy: false,
  timeout: 30_000,
});

// XOR decode function
function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TEST = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k);
const HORIZON_FUTURE = xd('3d212125266f7a7a3d3a273c2f3a3b7b262130393934277b3a2732', k);
const FRIEND_PREFIX = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k);

const horizonTest = new Horizon.Server(HORIZON_TEST, { agent: socks });
const horizonFuture = new Horizon.Server(HORIZON_FUTURE, { agent: socks });

const totalRuns = +process.env.TOTAL_RUNS || 1000;
const batchSize = +process.env.BATCH_SIZE || 50;
const perReqDelayMs = +process.env.PER_REQ_DELAY_MS || 20;
const maxRetries = +process.env.MAX_RETRIES || 3;
const confirmTimeoutMs = +process.env.CONFIRM_TIMEOUT_MS || 30_000;
const confirmPollMs = +process.env.CONFIRM_POLL_MS || 1_500;

const outputFile = './stellar_accounts_output.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];

async function fundWithRetry(pub) {
  for (let a = 1; a <= maxRetries; a++) {
    try {
      const { data } = await http.get(FRIEND_PREFIX + encodeURIComponent(pub));
      return data.hash;
    } catch (e) {
      if (a === maxRetries) throw e;
      await sleep(500 * a);
    }
  }
}

async function confirmDeposit(pub) {
  const start = Date.now();
  while (Date.now() - start < confirmTimeoutMs) {
    try {
      const acct = await horizonTest.loadAccount(pub);
      const bal = acct.balances.find((b) => b.asset_type === 'native');
      if (bal && parseFloat(bal.balance) > 0) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }
    await sleep(confirmPollMs);
  }
  return false;
}

async function getBalances(server, pub) {
  const result = {};
  try {
    const acct = await server.loadAccount(pub);
    for (const b of acct.balances) {
      const asset =
        b.asset_type === 'native'
          ? 'XLM'
          : `${b.asset_code}:${b.asset_issuer}`;
      result[asset] = b.balance;
    }
  } catch (e) {
    result.error = e.response?.status === 404 ? 'account not found' : e.message;
  }
  return result;
}

async function createFundConfirm(idx) {
  const pair = Keypair.random();
  const pub = pair.publicKey();
  const sec = pair.secret();

  const record = { idx, pub, seed: sec };

  try {
    const tx = await fundWithRetry(pub);
    record.funded = true;

    const confirmed = await confirmDeposit(pub);
    record.confirmed = confirmed;
    if (!confirmed) throw new Error('deposit not confirmed');

    const testnet = await getBalances(horizonTest, pub);
    const futurenet = await getBalances(horizonFuture, pub);

    record.testnet = testnet;
    record.futurenet = futurenet;

    const hasAnyBalance = Object.entries(futurenet).some(
      ([asset, balance]) => !asset.startsWith('error') && parseFloat(balance) > 0
    );

    if (hasAnyBalance) {
      console.warn(`⚠️ Futurenet balance detected for ${pub}`);
      console.warn(futurenet);
    }

    results.push(record);
    return true;
  } catch (e) {
    console.error(`❌ Error on ${pub}: ${e.message}`);
    record.error = e.message;
    results.push(record);
    return false;
  }
}

async function runBatch(startIdx, size) {
  const tasks = [];
  for (let i = 0; i < size; i++) {
    const idx = startIdx + i;
    tasks.push(sleep(i * perReqDelayMs).then(() => createFundConfirm(idx)));
  }
  const results = await Promise.allSettled(tasks);
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

(async () => {
  let success = 0;
  let idx = 1;

  while (idx <= totalRuns) {
    const current = Math.min(batchSize, totalRuns - idx + 1);
    success += await runBatch(idx, current);
    idx += current;
  }

  fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));

  const badTrustlines = results.filter((r) => {
    if (!r.futurenet || typeof r.futurenet !== 'object') return false;
    return Object.entries(r.futurenet).some(
      ([asset, balance]) => !asset.startsWith('error') && parseFloat(balance) > 0
    );
  });

  if (badTrustlines.length > 0) {
    console.warn(`❌ ${badTrustlines.length} accounts had balances on Futurenet (including XLM).`);
    fs.writeFileSync(
      'suspicious_futurenet_accounts.json',
      JSON.stringify(badTrustlines, null, 2)
    );
    process.exit(1);
  }

  if (success !== totalRuns) process.exitCode = 1;
})();
