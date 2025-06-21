import axios from 'axios';
import {
  Keypair,
  Server,
  TransactionBuilder,
  Networks,
  Operation,
  BASE_FEE
} from '@stellar/stellar-sdk';

const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIEND_BOT = 'https://friendbot.stellar.org';
const STARTING_BALANCE = '2.5'; // For each new account
const DURATION_SEC = 10; // How long to hammer Horizon
const PARALLEL_TXS = 100; // How many concurrent tx per loop

const server = new Server(HORIZON);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fundViaFriendbot(pubkey) {
  console.log(`🔄 Funding account ${pubkey} via friendbot...`);
  const res = await axios.get(`${FRIEND_BOT}/?addr=${encodeURIComponent(pubkey)}`);
  console.log(`✅ Friendbot tx hash: ${res.data.hash}`);
}

function createCreateAccountTx(sourceAccount, funderKeypair, destination) {
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE.toString(),
    networkPassphrase: Networks.TESTNET
  })
    .addOperation(Operation.createAccount({
      destination,
      startingBalance: STARTING_BALANCE
    }))
    .setTimeout(30)
    .build();

  tx.sign(funderKeypair);
  return tx;
}

async function benchmarkTPS(funderKeypair) {
  let sourceAccount = await server.loadAccount(funderKeypair.publicKey());
  let sequence = BigInt(sourceAccount.sequence);

  let totalSubmitted = 0;
  let totalSuccess = 0;
  let totalFailed = 0;

  const start = Date.now();
  const end = start + DURATION_SEC * 1000;

  while (Date.now() < end) {
    const batch = Array.from({ length: PARALLEL_TXS }, async (_, i) => {
      const destination = Keypair.random().publicKey();
      const account = {
        accountId: funderKeypair.publicKey(),
        sequence: (sequence + BigInt(i + 1)).toString()
      };

      const tx = createCreateAccountTx(account, funderKeypair, destination);

      try {
        await server.submitTransaction(tx);
        totalSuccess++;
      } catch (e) {
        totalFailed++;
      }
      totalSubmitted++;
    });

    await Promise.allSettled(batch);
    sequence += BigInt(PARALLEL_TXS);
  }

  const durationSec = (Date.now() - start) / 1000;
  const tps = totalSuccess / durationSec;

  console.log(`\n=== 📊 TPS Benchmark Report ===`);
  console.log(`⏱ Duration: ${durationSec.toFixed(2)} sec`);
  console.log(`📦 Submitted: ${totalSubmitted}`);
  console.log(`✅ Successes: ${totalSuccess}`);
  console.log(`❌ Failures: ${totalFailed}`);
  console.log(`⚡️ TPS: ${tps.toFixed(2)}\n`);
}

(async () => {
  const funderKeypair = Keypair.random();
  const pub = funderKeypair.publicKey();
  console.log(`🔐 Generated funder keypair`);
  console.log(`📤 Public Key: ${pub}`);
  console.log(`🔑 Secret Key: ${funderKeypair.secret()}`);

  try {
    await fundViaFriendbot(pub);
    await sleep(3000); // wait for ledger to close
    await benchmarkTPS(funderKeypair);
  } catch (err) {
    console.error(`❌ Error:`, err.response?.data || err.message || err);
  }
})();
