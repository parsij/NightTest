import {
  encodeFunctionData,
  getAddress,
  isAddress,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
} from 'viem'
import { recoverAuthorizationAddress } from 'viem/utils'
import './style.css'

const BSC_CHAIN_ID = 56n
const BSC_CHAIN_ID_HEX = '0x38'
const EXECUTOR = getAddress('0x973731BE76BdB84B994D32eF1E9607edebfBE470')
const EXECUTOR_VERSION_DATA = encodeFunctionData({
  abi: [{
    type: 'function',
    name: 'version',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ type: 'string' }],
  }],
  functionName: 'version',
})

let provider = null
let account = null

const $ = (id) => document.getElementById(id)

function json(value) {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2)
}

function sameAddress(a, b) {
  return isAddress(a ?? '') && isAddress(b ?? '') && getAddress(a) === getAddress(b)
}

async function findNightlyProvider() {
  if (window.nightly?.ethereum?.request) return window.nightly.ethereum

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      window.removeEventListener('eip6963:announceProvider', onProvider)
      resolve(value)
    }
    const onProvider = (event) => {
      const detail = event.detail
      if (detail?.info?.rdns === 'app.nightly' && detail?.provider?.request) {
        finish(detail.provider)
      }
    }
    window.addEventListener('eip6963:announceProvider', onProvider)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => finish(null), 500)
  })
}

async function connect() {
  provider = await findNightlyProvider()
  if (!provider) throw new Error('Nightly EVM provider was not detected. Install/enable the Nightly browser extension.')

  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  if (!Array.isArray(accounts) || !isAddress(accounts[0] ?? '')) {
    throw new Error('Nightly did not return a valid EVM account.')
  }
  account = getAddress(accounts[0])
  const chainId = await provider.request({ method: 'eth_chainId' })

  $('wallet-status').textContent = provider.isNightly === false ? 'Connected provider' : 'Connected'
  $('account').textContent = account
  $('chain').textContent = `${chainId} (${BigInt(chainId).toString()})`
  $('test-legacy').disabled = false
  $('test-7702').disabled = false

  if (BigInt(chainId) !== BSC_CHAIN_ID) {
    throw new Error(`Nightly is connected to chain ${BigInt(chainId)}. Switch Nightly to BNB Chain (56) before testing.`)
  }
}

async function requireReady() {
  if (!provider || !account) throw new Error('Connect Nightly first.')
  const chainId = await provider.request({ method: 'eth_chainId' })
  if (BigInt(chainId) !== BSC_CHAIN_ID) {
    throw new Error(`Wrong chain: ${BigInt(chainId)}. Switch Nightly to BNB Chain (56).`)
  }
}

async function pendingNonce() {
  const value = await provider.request({
    method: 'eth_getTransactionCount',
    params: [account, 'pending'],
  })
  return BigInt(value)
}

function documentedZeroGasTransaction(nonce) {
  return {
    from: account,
    to: account,
    value: '0x0',
    data: '0x',
    gas: toHex(21_000n),
    gasPrice: '0x0',
    nonce: toHex(nonce),
  }
}

function currentGasAssistTransaction(nonce) {
  return {
    type: '0x4',
    chainId: BSC_CHAIN_ID_HEX,
    from: account,
    to: account,
    nonce: toHex(nonce),
    gas: toHex(300_000n),
    maxFeePerGas: '0x0',
    maxPriorityFeePerGas: '0x0',
    value: '0x0',
    data: EXECUTOR_VERSION_DATA,
    authorizationList: [{
      chainId: BSC_CHAIN_ID_HEX,
      address: EXECUTOR,
      nonce: toHex(nonce + 1n),
    }],
  }
}

async function signRaw(tx) {
  const signed = await provider.request({
    method: 'eth_signTransaction',
    params: [tx],
  })
  if (typeof signed !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(signed)) {
    throw new Error('Nightly did not return a raw signed hex transaction.')
  }
  return signed
}

function check(label, ok, actual) {
  return { label, ok: Boolean(ok), actual: typeof actual === 'bigint' ? actual.toString() : actual }
}

async function inspectSigned(raw, requested, mode) {
  const parsed = parseTransaction(raw)
  const signer = await recoverTransactionAddress({ serializedTransaction: raw })
  const requestedNonce = BigInt(requested.nonce)
  const checks = [
    check('transaction signer is connected account', sameAddress(signer, account), signer),
    check('recipient stayed the connected account', sameAddress(parsed.to, account), parsed.to),
    check('nonce was not changed', parsed.nonce === requestedNonce, parsed.nonce),
    check('value stayed zero', parsed.value === 0n, parsed.value),
  ]

  if (mode === 'legacy') {
    checks.push(
      check('gasPrice stayed exactly zero', parsed.gasPrice === 0n, parsed.gasPrice),
      check('gas limit stayed 21000', parsed.gas === 21_000n, parsed.gas),
    )
  } else {
    checks.push(
      check('transaction is EIP-7702', parsed.type === 'eip7702', parsed.type),
      check('chainId stayed BNB Chain 56', BigInt(parsed.chainId ?? 0) === BSC_CHAIN_ID, parsed.chainId),
      check('maxFeePerGas stayed exactly zero', parsed.maxFeePerGas === 0n, parsed.maxFeePerGas),
      check('maxPriorityFeePerGas stayed exactly zero', parsed.maxPriorityFeePerGas === 0n, parsed.maxPriorityFeePerGas),
      check('gas limit stayed 300000', parsed.gas === 300_000n, parsed.gas),
      check('calldata stayed executor version()', parsed.data?.toLowerCase() === requested.data.toLowerCase(), parsed.data),
    )

    const auth = parsed.authorizationList?.[0]
    checks.push(
      check('signed authorization exists', Boolean(auth), auth ? 'present' : 'missing'),
      check('authorization delegates to current Pistachio executor', sameAddress(auth?.address, EXECUTOR), auth?.address),
      check('authorization chainId stayed 56', BigInt(auth?.chainId ?? 0) === BSC_CHAIN_ID, auth?.chainId),
      check('authorization nonce stayed tx nonce + 1', BigInt(auth?.nonce ?? -1) === requestedNonce + 1n, auth?.nonce),
    )

    if (auth) {
      try {
        const authority = await recoverAuthorizationAddress({ authorization: auth })
        checks.push(check('authorization signer is connected account', sameAddress(authority, account), authority))
      } catch (error) {
        checks.push(check('authorization signature is valid', false, error?.message ?? String(error)))
      }
    }
  }

  return { parsed, signer, checks, passed: checks.every((item) => item.ok) }
}

function renderResult(result) {
  const failed = result.checks.filter((item) => !item.ok)
  $('result').className = `result ${result.passed ? 'pass' : 'fail'}`
  $('result').innerHTML = result.passed
    ? '<strong>PASS</strong> Nightly returned a raw signed transaction without changing the tested fields.'
    : `<strong>FAIL</strong> ${failed.length} field check${failed.length === 1 ? '' : 's'} failed.<ul>${failed.map((item) => `<li>${item.label}: <code>${String(item.actual)}</code></li>`).join('')}</ul>`
}

async function run(mode) {
  await requireReady()
  $('result').className = 'result muted'
  $('result').textContent = 'Waiting for Nightly signature…'
  $('parsed').textContent = '-'
  $('raw').textContent = '-'

  const nonce = await pendingNonce()
  const requested = mode === 'legacy'
    ? documentedZeroGasTransaction(nonce)
    : currentGasAssistTransaction(nonce)

  $('requested').textContent = json(requested)
  const raw = await signRaw(requested)
  $('raw').textContent = raw

  const inspection = await inspectSigned(raw, requested, mode)
  $('parsed').textContent = json({
    type: inspection.parsed.type,
    chainId: inspection.parsed.chainId,
    nonce: inspection.parsed.nonce,
    to: inspection.parsed.to,
    value: inspection.parsed.value,
    gas: inspection.parsed.gas,
    gasPrice: inspection.parsed.gasPrice,
    maxFeePerGas: inspection.parsed.maxFeePerGas,
    maxPriorityFeePerGas: inspection.parsed.maxPriorityFeePerGas,
    data: inspection.parsed.data,
    authorizationList: inspection.parsed.authorizationList,
    recoveredSigner: inspection.signer,
    checks: inspection.checks,
  })
  renderResult(inspection)
}

function handle(action) {
  return async () => {
    try {
      await action()
    } catch (error) {
      $('result').className = 'result fail'
      $('result').textContent = `ERROR: ${error?.message ?? String(error)}`
    }
  }
}

$('connect').addEventListener('click', handle(connect))
$('test-legacy').addEventListener('click', handle(() => run('legacy')))
$('test-7702').addEventListener('click', handle(() => run('eip7702')))
