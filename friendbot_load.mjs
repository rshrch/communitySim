// ---------- Tor-aware HTTP layer ------------------------------------------------
import { SocksProxyAgent } from 'socks-proxy-agent';
import axios               from 'axios';
import { Horizon, Keypair } from '@stellar/stellar-sdk';

const torUri     = 'socks5h://127.0.0.1:3000';      // Tor listens here
const socksAgent = new SocksProxyAgent(torUri);

/* Friendbot & any ad-hoc REST: one Axios instance that always uses Tor */
const http = axios.create({
  httpAgent:  socksAgent,
  httpsAgent: socksAgent,
  proxy:      false,
  timeout:    30_000
});

/* Horizon SDK: give it the same agent so _its_ calls go through Tor too */
const horizon = new Horizon.Server(
  'https://horizon-testnet.stellar.org',
  { agent: socksAgent }          // <-- key line: all SDK traffic → Tor
);
// -----------------------------------------------------------------------------

// ----- original batching / retry config --------------------------------------
const totalRuns        = +process.env.TOTAL_RUNS        || 1000;
const batchSize        = +process.env.BATCH_SIZE        || 50;
const perReqDelayMs    = +process.env.PER_REQ_DELAY_MS  || 20;
const maxRetries       = +process.env.MAX_RETRIES       || 3;
const confirmTimeoutMs = +process.env.CONFIRM_TIMEOUT_MS|| 30_000;
const confirmPollMs    = +process.env.CONFIRM_POLL_MS   || 1_500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Friendbot funding (via Tor) ---------------------------------------
async function fundWithRetry(pub) {
  for (let attempt = 1; attempt <= maxRetries; ++attempt) {
    try {
      const { data } = await http.get(
        `https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`
      );
      return data.hash;                           // funded 🎉
    } catch (e) {
      if (attempt === maxRetries) throw e;
      await sleep(500 * attempt);
    }
  }
}

// ---------- Confirm deposit (SDK → Tor) ---------------------------------------
async function confirmDeposit(pub) {
  const start = Date.now();
  while (Date.now() - start < confirmTimeoutMs) {
    try {
      const acct = await horizon.loadAccount(pub);      // goes via Tor
      const bal  = acct.balances.find(b => b.asset_type === 'native');
      if (bal && parseFloat(bal.balance) > 0) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;          // ignore 404 until funded
    }
    await sleep(confirmPollMs);
  }
  return false;                                         // timed out
}

// ---------- One complete wallet cycle -----------------------------------------
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

// ---------- Batch driver & main loop (unchanged) ------------------------------
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
