import { Keypair, TransactionBuilder, Networks, Operation, Server, BASE_FEE } from '@stellar/stellar-sdk';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const TARGET_TPS = 1000;
const TOTAL_ACCOUNTS = 10000;
const BATCH_SIZE = 100; // Number of accounts funded per transaction
const HORIZON_URL = 'https://horizon-testnet.stellar.org'; // Use your own if needed
const FUNDING_SECRET = 'SB...'; // 🔐 High-balance funding account secret here

// Optional SOCKS5 proxy support
const socksAgent = new SocksProxyAgent('socks5h://127.0.0.1:3000');
const server = new Server(HORIZON_URL, { agent: socksAgent });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createAndFundAccounts() {
  const funderKeypair = Keypair.fromSecret(FUNDING_SECRET);
  const funderAccount = await server.loadAccount(funderKeypair.publicKey());
  let sequence = funderAccount.sequence;

  const allPromises = [];

  for (let i = 0; i < TOTAL_ACCOUNTS; i += BATCH_SIZE) {
    const txAccounts = [];
    for (let j = 0; j < BATCH_SIZE && i + j < TOTAL_ACCOUNTS; j++) {
      txAccounts.push(Keypair.random());
    }

    const txBuilder = new TransactionBuilder(funderAccount, {
      fee: (BASE_FEE * txAccounts.length).toString(),
      networkPassphrase: Networks.TESTNET,
    });

    for (const kp of txAccounts) {
      txBuilder.addOperation(Operation.createAccount({
        destination: kp.publicKey(),
        startingBalance: '2.5', // Enough for base reserve
      }));
    }

    const tx = txBuilder.setTimeout(0).build();
    tx.sign(funderKeypair);

    allPromises.push(
      server.submitTransaction(tx).catch(err => {
        console.error('Submit failed:', err?.response?.data?.extras?.result_codes || err.message);
      })
    );

    // Manually increment sequence for next batch (avoid refetching)
    sequence = (BigInt(sequence) + 1n).toString();
    funderAccount.incrementSequenceNumber();
  }

  console.log(`🚀 Submitting ${allPromises.length} transactions (~${TOTAL_ACCOUNTS} accounts)...`);

  const start = Date.now();
  await Promise.all(allPromises);
  const end = Date.now();

  const elapsedSec = (end - start) / 1000;
  const tps = Math.round(TOTAL_ACCOUNTS / elapsedSec);

  console.log(`✅ Done in ${elapsedSec.toFixed(2)} seconds (${tps} TPS)`);
}

(async () => {
  try {
    console.log('Starting high TPS account generator...');
    await createAndFundAccounts();
  } catch (e) {
    console.error('Fatal error:', e);
  }
})();
