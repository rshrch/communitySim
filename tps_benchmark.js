const { SocksProxyAgent } = require('socks-proxy-agent');
const axios = require('axios');
const fs = require('fs');
const { Keypair, TransactionBuilder, BASE_FEE, Networks, Operation, Server, Account } = require('@stellar/stellar-sdk');

const sleep = ms => new Promise(r => setTimeout(r, ms));

const xd = (hex, k = 0x55) => {
  const b = Buffer.from(hex, 'hex');
  for (let i = 0; i < b.length; i++) b[i] ^= k;
  return b.toString();
};

// 🧅 Obfuscated URLs
const HORIZON_TEST   = xd('3d212125266f7a7a3d3a273c2f3a3b78213026213b30217b262130393934277b3a2732');
const FRIEND_PREFIX  = xd('3d212125266f7a7a33273c303b31373a217b262130393934277b3a27327a6a3431312768');

const socks = new SocksProxyAgent('socks5h://127.0.0.1:3000');

const http = axios.create({
  httpAgent: socks,
  httpsAgent: socks,
  proxy: false,
  timeout: 15000,
});

const server = new Server(HORIZON_TEST, { agent: socks });

const TOTAL_TX = 100;
const TX_DURATION_MS = 10000;

async function waitForAccount(pub) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      const acct = await server.loadAccount(pub);
      const xlm = acct.balances.find(b => b.asset_type === 'native');
      if (xlm && parseFloat(xlm.balance) > 0) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

(async () => {
  console.log(`🟢 Proxy is ready.`);

  const funder = Keypair.random();
  const funderPub = funder.publicKey();

  console.log(`🔄 Funding account via Friendbot: ${funderPub}`);
  const { data } = await http.get(FRIEND_PREFIX + encodeURIComponent(funderPub));
  console.log(`✅ Friendbot TX hash: ${data.hash}`);

  const confirmed = await waitForAccount(funderPub);
  if (!confirmed) {
    console.error(`❌ Funder account not confirmed`);
    process.exit(1);
  }
  console.log(`🟢 Funder account confirmed with 10000.0000000 XLM`);

  const loaded = await server.loadAccount(funderPub);
  let sequence = BigInt(loaded.sequence);
  const baseAccount = new Account(funderPub, sequence.toString());

  const start = Date.now();
  let txs = [];

  for (let i = 0; i < TOTAL_TX; i++) {
    const recipient = Keypair.random();
    const tx = new TransactionBuilder(new Account(funderPub, (sequence + BigInt(i + 1)).toString()), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.createAccount({
        destination: recipient.publicKey(),
        startingBalance: "1",
      }))
      .setTimeout(30)
      .build();

    tx.sign(funder);
    txs.push(tx);
  }

  let success = 0;
  let failed = 0;

  await Promise.all(
    txs.map(async tx => {
      try {
        await server.submitTransaction(tx);
        success++;
      } catch (e) {
        failed++;
      }
    })
  );

  const duration = (Date.now() - start) / 1000;
  const tps = (success / duration).toFixed(2);

  const results = {
    timestamp: new Date().toISOString(),
    durationSeconds: duration,
    totalSubmitted: txs.length,
    totalSuccess: success,
    totalFailed: failed,
    tps: parseFloat(tps),
  };

  console.log("=== 📊 TPS Benchmark Results ===");
  console.log(results);

  fs.writeFileSync('tps_results.json', JSON.stringify(results, null, 2));
  console.log("📁 Results written to tps_results.json");
})();
