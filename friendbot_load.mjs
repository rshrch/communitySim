// ───────────────────────────  Tor wiring  ────────────────────────────
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Horizon, HorizonAxiosClient, Keypair } from '@stellar/stellar-sdk';

// 1) make EVERY global fetch() (i.e. Friendbot) use Tor
setGlobalDispatcher(new ProxyAgent('socks5h://127.0.0.1:9050'));

// 2) make the Stellar SDK’s Axios client use Tor as well
const socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');
HorizonAxiosClient.defaults.httpAgent  = socksAgent;
HorizonAxiosClient.defaults.httpsAgent = socksAgent;
HorizonAxiosClient.defaults.proxy      = false;     // don’t fall back to http proxy
// ──────────────────────────────────────────────────────────────────────

// Same code you gave me, untouched apart from the Tor block above
const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');

const totalRuns        = +process.env.TOTAL_RUNS        || 1000;
const batchSize        = +process.env.BATCH_SIZE        || 50;
const perReqDelayMs    = +process.env.PER_REQ_DELAY_MS  || 20;
const maxRetries       = +process.env.MAX_RETRIES       || 3;
const confirmTimeoutMs = +process.env.CONFIRM_TIMEOUT_MS|| 30000;
const confirmPollMs    = +process.env.CONFIRM_POLL_MS   || 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fundWithRetry(pub) {
  for (let a = 1; a <= maxRetries; ++a) {
    try {
      const res = await fetch(
        `https://friendbot.stellar.org/?addr=${encodeURIComponent(pub)}`
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const { hash } = await res.json();
      return hash;
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
      const acct = await horizon.loadAccount(pub);
      const bal  = acct.balances.find(b => b.asset_type === 'native');
      if (bal && parseFloat(bal.balance) > 0) return true;
    } catch (e) {
      if (e.response?.status !== 404) throw e;   // ignore 404 until funded
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
