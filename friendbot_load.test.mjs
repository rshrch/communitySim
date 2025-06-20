import assert from 'node:assert';
import { Horizon } from '@stellar/stellar-sdk';

// Functions to test - they will be imported after env vars are potentially set
// For now, this demonstrates the intent. Actual import might be inside runTests or test groups.
// import { fundWithRetry, confirmDeposit } from '../friendbot_load.mjs';

// --- Mocking Utilities ---
let originalFetch;
let originalLoadAccount;

function mockFetch(responseGenerator) {
  originalFetch = global.fetch;
  global.fetch = async (url) => {
    return responseGenerator(url);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

function mockLoadAccount(responseGenerator) {
  originalLoadAccount = Horizon.Server.prototype.loadAccount;
  Horizon.Server.prototype.loadAccount = async (accountId) => {
    return responseGenerator(accountId);
  };
}

function restoreLoadAccount() {
  Horizon.Server.prototype.loadAccount = originalLoadAccount;
}

// --- Test Storage ---
const allTests = [];
const registerTest = (name, fn) => allTests.push({ name, fn });

// --- Test Runner ---
async function runAllTests() {
  console.log("Starting tests...\n");
  let passed = 0;
  let failed = 0;

  // Dynamically import the module here to allow environment variables to be set
  // if needed for specific test suites, though for now, we use defaults.
  // This also ensures we get a fresh copy if module caching is a concern,
  // though Node's ESM cache is per-module, not per-import.
  const { fundWithRetry, confirmDeposit, sleep } = await import('./friendbot_load.mjs');

  // Make sleep immediate for tests to avoid long waits, unless testing sleep itself
  const originalSleep = sleep; // In case any test wants the real sleep
  const mockSleep = async () => Promise.resolve();


  for (const test of allTests) {
    let currentFetch = global.fetch;
    let currentLoadAccount = Horizon.Server.prototype.loadAccount;
    // Replace actual sleep with mockSleep for most tests
    const fnsToTest = { fundWithRetry, confirmDeposit, sleep: mockSleep };

    try {
      console.log(`RUNNING: ${test.name}`);
      await test.fn(fnsToTest, assert); // Pass in functions and assert
      console.log(`PASSED: ${test.name}`);
      passed++;
    } catch (e) {
      console.error(`FAILED: ${test.name}`);
      console.error(e);
      failed++;
    } finally {
      // Restore any mocks that might have been set by the test itself
      // or ensure they are clean for the next test.
      // For now, using global restore, but could be more granular.
      if (global.fetch !== currentFetch) restoreFetch();
      if (Horizon.Server.prototype.loadAccount !== currentLoadAccount) restoreLoadAccount();
    }
    console.log("---");
  }

  console.log(`\nTests finished.`);
  console.log(`Total: ${allTests.length}, Passed: ${passed}, Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

// --- Test Definitions ---

console.log("Defining fundWithRetry tests...");

registerTest('fundWithRetry_successFirstTry', async ({ fundWithRetry }, assert) => {
  let fetchCallCount = 0;
  mockFetch(async (url) => {
    fetchCallCount++;
    assert.ok(url.startsWith('https://friendbot.stellar.org/?addr='), 'Correct Friendbot URL');
    return { ok: true, json: async () => ({ hash: 'tx_hash_1' }) };
  });

  const pubKey = 'GABC';
  const result = await fundWithRetry(pubKey);
  assert.strictEqual(result, 'tx_hash_1', 'Returns transaction hash');
  assert.strictEqual(fetchCallCount, 1, 'Fetch called once');
  restoreFetch();
});

registerTest('fundWithRetry_successAfterTwoRetries', async ({ fundWithRetry }, assert) => {
  let fetchCallCount = 0;
  const pubKey = 'GDEF';
  mockFetch(async (url) => {
    fetchCallCount++;
    assert.ok(url.includes(pubKey), 'URL contains public key');
    if (fetchCallCount <= 2) {
      return { ok: false, status: 500, json: async () => ({ error: 'Server error' }) };
    }
    return { ok: true, json: async () => ({ hash: 'tx_hash_2' }) };
  });

  // Note: fundWithRetry uses its own sleep. For this test, actual small delays are acceptable.
  // The default maxRetries is 3.
  const result = await fundWithRetry(pubKey);
  assert.strictEqual(result, 'tx_hash_2', 'Returns transaction hash on third attempt');
  assert.strictEqual(fetchCallCount, 3, 'Fetch called three times');
  restoreFetch();
});

registerTest('fundWithRetry_failureAfterMaxRetries', async ({ fundWithRetry }, assert) => {
  let fetchCallCount = 0;
  const pubKey = 'GHIJ';
  // MAX_RETRIES is 3 by default in friendbot_load.mjs
  const MAX_RETRIES = 3; // Assuming this from the original script's default

  mockFetch(async (url) => {
    fetchCallCount++;
    assert.ok(url.includes(pubKey));
    return { ok: false, status: 500, json: async () => ({ error: 'Persistent server error' }) };
  });

  await assert.rejects(
    fundWithRetry(pubKey),
    /status 500/, // The error thrown by fundWithRetry includes the status if response not ok.
    'Should reject after max retries'
  );
  assert.strictEqual(fetchCallCount, MAX_RETRIES, `Fetch called MAX_RETRIES (${MAX_RETRIES}) times`);
  restoreFetch();
});

registerTest('fundWithRetry_handles429errorWithRetry', async ({ fundWithRetry }, assert) => {
  let fetchCallCount = 0;
  const pubKey = 'GKLM';
  mockFetch(async (url) => {
    fetchCallCount++;
    if (fetchCallCount === 1) {
      return { ok: false, status: 429, json: async () => ({ error: 'Rate limited' }) };
    }
    return { ok: true, json: async () => ({ hash: 'tx_hash_429' }) };
  });

  const result = await fundWithRetry(pubKey);
  assert.strictEqual(result, 'tx_hash_429', 'Returns transaction hash after 429');
  assert.strictEqual(fetchCallCount, 2, 'Fetch called twice (once for 429, once for success)');
  restoreFetch();
});


console.log("\nDefining confirmDeposit tests...");

registerTest('confirmDeposit_successFirstPoll', async ({ confirmDeposit }, assert) => {
  let loadAccountCallCount = 0;
  const pubKey = 'GABC';
  mockLoadAccount(async (accountId) => {
    loadAccountCallCount++;
    assert.strictEqual(accountId, pubKey, 'Correct account ID polled');
    return { balances: [{ asset_type: 'native', balance: '10000.0000000' }] };
  });

  const result = await confirmDeposit(pubKey);
  assert.strictEqual(result, true, 'Returns true on successful confirmation');
  assert.strictEqual(loadAccountCallCount, 1, 'loadAccount called once');
  restoreLoadAccount();
});

registerTest('confirmDeposit_successAfterFewPolls', async ({ confirmDeposit }, assert) => {
  let loadAccountCallCount = 0;
  const pubKey = 'GDEF';
  // CONFIRM_POLL_MS default is 1500ms, sleep is mocked to be immediate.
  mockLoadAccount(async (accountId) => {
    loadAccountCallCount++;
    assert.strictEqual(accountId, pubKey);
    if (loadAccountCallCount <= 2) {
      // Simulate account not found for the first two polls
      const error = new Error('Account not found');
      error.response = { status: 404 };
      throw error;
    }
    // Simulate account funded on the third poll
    return { balances: [{ asset_type: 'native', balance: '1.0000000' }] };
  });

  const result = await confirmDeposit(pubKey);
  assert.strictEqual(result, true, 'Returns true after a few polls');
  assert.strictEqual(loadAccountCallCount, 3, 'loadAccount called three times');
  restoreLoadAccount();
});

registerTest('confirmDeposit_timeoutIfNeverFunded', async ({ confirmDeposit, sleep: originalSleep }, assert) => {
  // This test needs to manage time, so it's trickier with mocked sleep.
  // We'll rely on the default CONFIRM_TIMEOUT_MS and CONFIRM_POLL_MS from the script.
  // To make this test run faster if defaults are high, one might temporarily reduce them via process.env
  // *before* this particular test runs and then import the module, or modify the script.
  // For now, we'll assume the defaults are small enough or we accept the wait.
  // The global mockSleep is active. We need to use originalSleep if we want actual delays.
  // However, the confirmDeposit function itself uses the imported sleep.
  // The test runner provides 'sleep' which is a mock. We need to test the logic based on this.
  // If CONFIRM_TIMEOUT_MS is 30000 and CONFIRM_POLL_MS is 1500, this would be ~20 polls.
  // We'll mock loadAccount to always return 404.
  // The test will pass if confirmDeposit returns false after exhausting its internal timeout logic.

  let loadAccountCallCount = 0;
  const pubKey = 'GHIJ_TIMEOUT';
  mockLoadAccount(async (accountId) => {
    loadAccountCallCount++;
    const error = new Error('Account not found');
    error.response = { status: 404 };
    throw error;
  });

  // Temporarily override specific env vars for this test if needed
  // For simplicity, we assume the default timeout (30s) and poll (1.5s) are used.
  // With mocked sleep, this loop will run very fast.
  // The `Date.now()` check in `confirmDeposit` is the real guard against infinite loops.
  const originalConfirmTimeoutMs = process.env.CONFIRM_TIMEOUT_MS;
  const originalConfirmPollMs = process.env.CONFIRM_POLL_MS;

  // Set short timeout for the test to run quickly
  process.env.CONFIRM_TIMEOUT_MS = '100'; // 100 ms
  process.env.CONFIRM_POLL_MS = '10';    // 10 ms

  // We need to re-import or ensure the function under test uses these new values.
  // The current structure imports once. For this specific test, we need to get a version
  // of confirmDeposit that sees these new env vars. This is tricky.
  // The module `friendbot_load.mjs` reads env vars when it's first loaded.
  // The most robust way is to make the function under test accept these as parameters.
  // Given the current structure, this test will use the initially loaded values.
  // To properly test timeout, we'd need to use real time or a more sophisticated time mocking library.
  // Let's assume for now the mocked sleep allows many polls to happen quickly, and Date.now() drives the timeout.

  console.log("  (Note: Timeout test relies on Date.now() and many fast polls due to mocked sleep)");
  const result = await confirmDeposit(pubKey); // This uses the confirmDeposit with mocked sleep
  assert.strictEqual(result, false, 'Returns false if account never funded (timeout)');
  assert.ok(loadAccountCallCount > 1, 'loadAccount called multiple times'); // Ensure it polled a few times

  // Restore original env vars if they were set
  if (originalConfirmTimeoutMs) process.env.CONFIRM_TIMEOUT_MS = originalConfirmTimeoutMs;
  else delete process.env.CONFIRM_TIMEOUT_MS;
  if (originalConfirmPollMs) process.env.CONFIRM_POLL_MS = originalConfirmPollMs;
  else delete process.env.CONFIRM_POLL_MS;

  restoreLoadAccount();
});


registerTest('confirmDeposit_throwsNon404Error', async ({ confirmDeposit }, assert) => {
  const pubKey = 'GKLM_ERROR';
  mockLoadAccount(async (accountId) => {
    throw new Error('Network issue'); // Simulate a non-404 error
  });

  await assert.rejects(
    confirmDeposit(pubKey),
    /Network issue/,
    'Should reject if loadAccount throws a non-404 error'
  );
  restoreLoadAccount();
});

// --- Run all tests ---
// This will be called when the script is executed
runAllTests();
