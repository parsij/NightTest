# NightTest

Local Nightly Wallet compatibility lab for PistachioSwap Gas Assist signing.

## What this tests

Nightly's EVM documentation says its injected provider supports `eth_signTransaction` and returns a raw signed transaction without broadcasting it. This repo checks whether the returned bytes preserve the fields Pistachio Gas Assist needs.

There are two tests:

1. **Documented zero-gas raw signing**
   - BNB Chain
   - self-transfer, zero value
   - `gasPrice: 0x0`
   - `eth_signTransaction`
   - verifies Nightly returned raw bytes and did not replace zero gas

2. **Current Pistachio atomic Gas Assist shape**
   - BNB Chain `0x38`
   - transaction type `0x4` (EIP-7702)
   - `maxFeePerGas: 0x0`
   - `maxPriorityFeePerGas: 0x0`
   - transaction calls the connected EOA
   - authorization delegates to current same-chain `GasAssistAtomicExecutor`:
     `0x973731BE76BdB84B994D32eF1E9607edebfBE470`
   - authorization nonce = transaction nonce + 1, matching the current Gas-Assist service
   - parses the returned raw transaction with `viem`
   - recovers both the transaction signer and EIP-7702 authorization signer
   - reports any field Nightly changed

The second shape is intentionally a compatibility probe. Nightly documents ordinary EVM `eth_signTransaction`, but its public EVM transaction-format page does not currently document EIP-7702 `authorizationList` fields. The point of this repo is to test the real wallet before touching PistachioSwap production code.

## Safety

**This app never calls `eth_sendTransaction` or `eth_sendRawTransaction`. It does not submit to MegaFuel and does not broadcast anything.**

The returned raw transaction is displayed locally for inspection. Treat it as broadcastable transaction data and do not paste it into untrusted sites.

## Run locally

```bash
pnpm install
pnpm dev
```

Open the localhost URL printed by Vite, install/enable Nightly Wallet, switch Nightly to **BNB Chain (56)**, then:

1. Connect Nightly.
2. Run **Sign zero-gas test**.
3. If that passes, run **Sign current Gas Assist shape**.

A full pass on test 2 means Nightly returned a signed type-4 transaction whose transaction signer, authorization signer, executor, chain ID, nonce, gas limit and zero-fee fields all match the requested Pistachio Gas Assist shape.

## Implementation references

The test intentionally mirrors the current project rather than inventing a new signing format:

- `parsij/Gas-Assist/src/gas-assist/prepaid/atomic/transaction.ts`
- `parsij/Gas-Assist/src/gas-assist/prepaid/atomic/service.ts`
- `parsij/PistachioSwap/src/features/gas-assist/services/metamaskMultichain.js` for strict raw-transaction parsing/recovery ideas
- same `viem` version family currently used by PistachioSwap
