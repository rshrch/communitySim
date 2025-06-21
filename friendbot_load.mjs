import { SocksProxyAgent } from 'socks-proxy-agent';
import axios from 'axios';
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import fs from 'fs';
import net from 'net';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function xd(hex, k) {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
}
const k = 0x55;

const HORIZON_TEST   = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732', k);
const HORIZON_FUTURE = xd('3d212125266f7a7a3d3a273c2f3a3b7b262130393934277b3a2732', k);
const FRIEND_PREFIX  = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768', k);

function waitForProxyReady(port = 3000, host = '127.0.0.1', timeout = 10000) {
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
    httpAgent:  socks,
    httpsAgent: socks,
    proxy:      false,
    timeout:    30000,
  });
}
let http = createHttp();

const horizonTest   = new Horizon.Server(HORIZON_TEST,   { agent: socks });
const horizonFuture = new Horizon.Server(HORIZON_FUTURE, { agent: socks });

const totalRuns        = +process.env.TOTAL_RUNS        || 3000;
const batchSize        = +process.env.BATCH_SIZE        || 250;
const perReqDelayMs    = +process.env.PER_REQ_DELAY_MS  || 0;
const maxRetries       = +process.env.MAX_RETRIES       || 3;
const confirmTimeoutMs = +process.env.CONFIRM_TIMEOUT_MS|| 30000;
const confirmPollMs    = +process.env.CONFIRM_POLL_MS   || 1500;

const results = [];

async function fundWithRetry(pub) {
  for (let a = 1; a <= maxRetries; a++) {
    try {
      const { data } = await http.get(FRIEND_PREFIX + encodeURIComponent(pub));
      return data.hash;
    } catch (e) {
      const timeout = e.code === 'ECONNABORTED' || e.message.includes('timed out');
      const netfail = e.code === 'ECONNRESET' || e.code === 'ENETUNREACH';

      if ((timeout || netfail) && a < maxRetries) {
        await sleep(500 * a);
        socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');
        http = createHttp();
        continue;
      }

      if (e.response?.status === 400) throw new Error('friendbot rejected funding');
      if (a === maxRetries) return null;
    }
  }
  return null;
}

async function confirmDeposit(pub) {
  const start = Date.now();
  while (Date.now() - start < confirmTimeoutMs) {
    try {
      const acct = await horizonTest.loadAccount(pub);
      const bal  = acct.balances.find(b => b.asset_type === 'native');
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
  const pub  = pair.publicKey();
  const sec  = pair.secret();

  const record = { idx, pub, seed: sec };

  try {
    const tx = await fundWithRetry(pub);
    if (!tx) return false;

    record.funded = true;

    const confirmed = await confirmDeposit(pub);
    record.confirmed = confirmed;
    if (!confirmed) throw new Error('deposit not confirmed');

    const testnet   = await getBalances(horizonTest, pub);
    const futurenet = await getBalances(horizonFuture, pub);

    record.testnet   = testnet;
    record.futurenet = futurenet;

    results.push(record);
    return true;
  } catch (e) {
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
  return results.filter(r => r.status === 'fulfilled' && r.value).length;
}

(async () => {
  try {
    console.log('Checking SOCKS5 proxy at 127.0.0.1:3000...');
    await waitForProxyReady();
    console.log('Proxy is available.');
  } catch (e) {
    const msg = `Proxy check failed: ${e.message}. Simulation aborted, no network actions taken.`;
    const filename = `proxy_skipped_${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

    console.warn(msg);
    fs.writeFileSync(filename, msg + '\n');
    console.warn(`Details saved to: ${filename}`);
    process.exit(0);
  }

  let success = 0;
  let idx = 1;

  while (idx <= totalRuns) {
    const current = Math.min(batchSize, totalRuns - idx + 1);
    success += await runBatch(idx, current);
    idx += current;
  }

  fs.writeFileSync('stellar_accounts_output.json', JSON.stringify(results, null, 2));

  const findings = results.filter(r => {
    if (!r.futurenet || typeof r.futurenet !== 'object') return false;
    return Object.keys(r.futurenet).some(asset => asset !== 'XLM' && !asset.startsWith('error'));
  });

  if (findings.length > 0) {
    const now = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `suspicious_futurenet_accounts_${now}.json`;

    console.error('Suspicious accounts found on Futurenet:');
    findings.forEach((entry, idx) => {
      console.error(`[${idx + 1}] Index: ${entry.idx}`);
      console.error(`PubKey: ${entry.pub}`);
      console.error(`Seed:   ${entry.seed}`);
      console.error(`Testnet Balances:`, entry.testnet);
      console.error(`Futurenet Balances:`, entry.futurenet);
      if (entry.error) console.error(`Error: ${entry.error}`);
    });

    fs.writeFileSync(filename, JSON.stringify(findings, null, 2));
    console.error(`Details saved to: ${filename}`);
    process.exit(1);
  }

  console.log(`Completed successfully with ${success}/${totalRuns} accounts funded and confirmed.`);
})();
