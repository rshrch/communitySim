// ───────────  Tor-aware HTTP setup  ───────────
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios               from 'axios';
import { Horizon, Keypair } from '@stellar/stellar-sdk';

const torUri     = 'socks5h://127.0.0.1:3000';
const socksAgent = new SocksProxyAgent(torUri);

const http = axios.create({
  httpAgent:  socksAgent,
  httpsAgent: socksAgent,
  proxy:      false,
  timeout:    30_000
});

// ───────────  XOR-decode helper  ───────────
function xorDecode(hex, key) {
  const buf = Buffer.from(hex, 'hex');
  for (let i = 0; i < buf.length; i++) buf[i] ^= key;
  return buf.toString();
}

const key = 0x55;

//   https://horizon-testnet.stellar.org               → XOR → hex
const HORIZON_URL  = xorDecode(
  '3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732',
  key
);

//   https://friendbot.stellar.org/?addr=              → XOR → hex
const FRIEND_PREFIX = xorDecode(
  '3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768',
  key
);

// Horizon SDK routed through Tor
const horizon = new Horizon.Server(HORIZON_URL, { agent: socksAgent });

// ───────────  original logic  ───────────
const totalRuns        = +process.env.TOTAL_RUNS        || 1000;
const batchSize        = +process.env.BATCH_SIZE        || 50;
const perReqDelayMs    = +process.env.PER_REQ_DELAY_MS  || 20;
const maxRetries       = +process.env.MAX_RETRIES       || 3;
const confirmTimeoutMs = +process.env.CONFIRM_TIMEOUT_MS|| 30_000;
const confirmPollMs    = +process.env.CONFIRM_POLL_MS   || 1_500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fundWithRetry(pub) {
  for (let attempt = 1; attempt <= maxRetries; ++attempt) {
    try {
      const { data } = await http.get(FRIEND_PREFIX + encodeURIComponent(pub));
      return data.hash;                          // funded 🎉
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await sleep(500 * attempt);
    }
  }
}

async function confirmDeposit(pub) {
  const start = Date.now();
  while (Date.now() - start < confirmTimeoutMs) {
    try {
      const acct = await horizon.loadAccount(pub);
      const bal  = acct.balances.find(b => b.asset_type === 'native');
      if (bal && parseFloat(bal.balance) > 0) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;
    }
    await sleep(confirmPollMs);
  }
  return false;
}

async function createFundConfirm(idx) {
  const pair = Keypair.random();
  const pub  = pair.publicKey();
  console.log(`run ${idx} pub ${pub}`);

  try {
    const tx = await fundWithRetry(pub);
    console.log(`run ${idx} funded ${tx}`);

    if (!(await confirmDeposit(pub))) throw new Error('deposit not confirmed');
    console.log(`run ${idx} confirmed`);
    return true;
  } catch (e) {
    console.error(`run ${idx} failed ${e.message}`);
    return false;
  }
}

async function runBatch(startIdx, size) {
  const tasks = [];
  for (let i = 0; i < size; ++i) {
    const idx = startIdx + i;
    tasks.push(
      sleep(i * perReqDelayMs).then(() => createFundConfirm(idx))
    );
  }
  const results = await Promise.allSettled(tasks);
  return results.filter(r => r.status === 'fulfilled' && r.value).length;
}

(async () => {
  let success = 0;
  let idx     = 1;

  while (idx <= totalRuns) {
    const current = Math.min(batchSize, totalRuns - idx + 1);
    console.log(`batch ${idx}-${idx + current - 1}`);
    success += await runBatch(idx, current);
    idx     += current;
  }

  console.log(`summary ${success} of ${totalRuns} succeeded`);
  if (success !== totalRuns) process.exitCode = 1;
})();
