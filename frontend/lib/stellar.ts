/**
* @file lib/stellar.ts
* @description Core Stellar blockchain interaction helpers for Stellar MicroPay.
* Uses the Horizon REST API — no private keys ever touch this module.
*
* @see {@link https://developers.stellar.org/docs/data/horizon | Stellar Horizon Docs}
* @see {@link https://stellar.github.io/js-stellar-sdk/ | stellar-sdk Reference}
*/

import {
  Horizon,
  Account,
  Transaction,
  Networks,
  Asset,
  Operation,
  TransactionBuilder,
  Memo,
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc,
  Federation,
} from "@stellar/stellar-sdk";

// ─── Config ────────────────────────────────────────────────────────────────

import {
  server,
  getServer,
  getNetworkConfig,
  setNetworkConfig,
  type NetworkConfig,
  DEFAULT_CONFIGS,
  NETWORK,
  HORIZON_URL,
  getNetworkPassphrase,
  NETWORK_PASSPHRASE,
} from "./stellarConfig";

import { apiFetch } from "./api";

export {
  server,
  getServer,
  getNetworkConfig,
  setNetworkConfig,
  type NetworkConfig,
  DEFAULT_CONFIGS,
  NETWORK,
  HORIZON_URL,
  getNetworkPassphrase,
  NETWORK_PASSPHRASE,
};

/** One XLM is divided into 10,000,000 stroops, Stellar's smallest unit. */
export const STELLAR_STROOPS_PER_XLM = 10_000_000;

/** Stellar's protocol minimum operation fee is 100 stroops. */
export const STELLAR_BASE_FEE_STROOPS = 100;

/** Default network fee in XLM, derived from the base fee in stroops. */
export const STELLAR_BASE_FEE_XLM =
  STELLAR_BASE_FEE_STROOPS / STELLAR_STROOPS_PER_XLM;

/** Transactions built for wallet signing expire after 60 seconds. */
export const STELLAR_TRANSACTION_TIMEOUT_SECONDS = 60;

/** Stellar MEMO_TEXT values are capped at 28 UTF-8 bytes by the protocol. */
export const STELLAR_MEMO_TEXT_MAX_BYTES = 28;

/** A base Stellar account must keep two reserve units before subentries. */
export const STELLAR_BASE_ACCOUNT_RESERVE_COUNT = 2;

/** Maximum allowed number of recipients in a single batch payment. */
export const MAX_BATCH_RECIPIENTS = 10;

/** Maximum allowed aggregate payment amount in XLM for a single batch payment. */
export const MAX_BATCH_TOTAL_XLM = 1000;

/**
 * Stellar base reserve in XLM.
 *
 * Each account holds (2 + subentry_count) base reserves of 0.5 XLM. Trustlines,
 * offers, signers, and data entries each count as one subentry.
 *
 * @see https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts#base-reserves
 */
export const STELLAR_BASE_RESERVE_XLM = 0.5;

/** Minimum XLM balance for an account with no subentries. */
export const STELLAR_MINIMUM_ACCOUNT_BALANCE_XLM =
  STELLAR_BASE_ACCOUNT_RESERVE_COUNT * STELLAR_BASE_RESERVE_XLM;

const STELLAR_BASE_FEE_STROOPS_STRING = String(STELLAR_BASE_FEE_STROOPS);
const ELEVATED_FEE_MAX_STROOPS = STELLAR_BASE_FEE_STROOPS * 10;

/** Truncate a memo string so its UTF-8 encoding fits within the Stellar MEMO_TEXT byte limit. */
export function truncateMemoText(memo: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(memo).length <= STELLAR_MEMO_TEXT_MAX_BYTES) {
    return memo;
  }

  let truncated = "";
  for (const char of memo) {
    const next = truncated + char;
    if (encoder.encode(next).length > STELLAR_MEMO_TEXT_MAX_BYTES) {
      break;
    }
    truncated = next;
  }

  return truncated;
}

/**
 * Validate batch payment parameters against row and aggregate limits.
 */
export function validateBatchPayment(destinations: Array<{ amount: string | number }>): void {
  if (!Array.isArray(destinations) || destinations.length === 0) {
    throw new Error("Batch payment must contain at least one recipient.");
  }
  if (destinations.length > MAX_BATCH_RECIPIENTS) {
    throw new Error(`Batch recipient count exceeds maximum allowed limit of ${MAX_BATCH_RECIPIENTS}.`);
  }
  let total = 0;
  for (const dest of destinations) {
    const amt = typeof dest.amount === "number" ? dest.amount : parseFloat(String(dest.amount || "0"));
    if (!Number.isFinite(amt) || amt <= 0) {
      throw new Error("Invalid recipient amount in batch payment.");
    }
    total += amt;
  }
  if (total > MAX_BATCH_TOTAL_XLM) {
    throw new Error(`Batch aggregate amount exceeds maximum allowed limit of ${MAX_BATCH_TOTAL_XLM} XLM.`);
  }
}

/**
 * USDC issuer (Circle) for the active network.
 *
 * If you intend to use USDC features on testnet, set `NEXT_PUBLIC_USDC_ISSUER`.
 */
export const USDC_ISSUER =
  process.env.NEXT_PUBLIC_USDC_ISSUER ||
  // Default to mainnet Circle issuer. (App can still run without USDC usage.)
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** USDC asset helper. */
export const USDC = new Asset("USDC", USDC_ISSUER);

/** Known assets for trustline management. */
export const KNOWN_ASSETS = {
  testnet: [
    { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    { code: "AQUA", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA7" }, // Example issuer
    { code: "yXLM", issuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55" }, // Example issuer
  ],
  mainnet: [
    { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
    { code: "AQUA", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA7" }, // Example issuer
    { code: "yXLM", issuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55" }, // Example issuer
  ],
};

/** Get known assets for the current network. */
export function getKnownAssets() {
  return KNOWN_ASSETS[NETWORK];
}

/** Soroban RPC server URL. Defaults to testnet. */
export function getSorobanRpcUrl(): string {
  const config = getNetworkConfig();
  if (config.network === "mainnet") {
    return "https://soroban.stellar.org";
  } else if (config.network === "testnet") {
    return "https://soroban-testnet.stellar.org";
  } else {
    // For custom networks, try to infer from Horizon URL
    const url = new URL(config.horizonUrl);
    return `https://soroban.${url.hostname}`;
  }
}

// For backwards compatibility
export const SOROBAN_RPC_URL = getSorobanRpcUrl();

/** Pre-configured Soroban RPC server instance. */
let _sorobanServer: rpc.Server | null = null;
/** Returns a cached Soroban RPC server instance. */
export function getSorobanServer(): rpc.Server {
  if (!_sorobanServer) {
    _sorobanServer = new rpc.Server(getSorobanRpcUrl());
  }
  return _sorobanServer;
}

/**
 * Validate stellar address format.
 */
export function isValidStellarAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  return /^G[A-Z0-9]{55}$/.test(address);
}

/**
 * Build a payment transaction.
 */
export async function buildPaymentTransaction({
  sourcePublicKey,
  destination,
  amount,
  memo,
  destinations,
}: {
  sourcePublicKey: string;
  destination?: string;
  amount?: string;
  memo?: string;
  destinations?: Array<{ destination: string; amount: string; memo?: string }>;
}): Promise<Transaction> {
  validatePublicKeyLocal(sourcePublicKey);

  const payments = destinations && destinations.length > 0
    ? destinations
    : [{ destination: destination!, amount: amount!, memo }];

  validateBatchPayment(payments);

  const serverInstance = getServer();
  const sourceAccountRecord = await serverInstance.loadAccount(sourcePublicKey);

  let builder = new TransactionBuilder(sourceAccountRecord, {
    fee: STELLAR_BASE_FEE_STROOPS_STRING,
    networkPassphrase: getNetworkPassphrase(),
  }).setTimeout(STELLAR_TRANSACTION_TIMEOUT_SECONDS);

  if (payments.length === 1 && payments[0].memo) {
    builder = builder.addMemo(Memo.text(truncateMemoText(payments[0].memo)));
  }

  for (const p of payments) {
    if (!isValidStellarAddress(p.destination)) {
      throw new Error(`Invalid destination address: ${p.destination}`);
    }
    const amtStr = String(p.amount);
    builder = builder.addOperation(
      Operation.payment({
        destination: p.destination,
        asset: Asset.native(),
        amount: amtStr,
      })
    );
  }

  return builder.build();
}

function validatePublicKeyLocal(publicKey: unknown): void {
  if (!isValidStellarAddress(publicKey)) {
    throw new Error("Invalid Stellar public key format");
  }
}

/**
 * Submit transaction to network.
 */
export async function submitTransaction(signedXDR: string): Promise<{ hash: string }> {
  const serverInstance = getServer();
  const tx = new Transaction(signedXDR, getNetworkPassphrase());
  const response = await serverInstance.submitTransaction(tx);
  return { hash: response.hash };
}
