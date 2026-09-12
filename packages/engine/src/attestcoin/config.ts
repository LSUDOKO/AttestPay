// Attestcoin integration configuration, resolved from the environment.
//
// The whole integration is OPTIONAL and OFF by default. A deployment with no
// Attestcoin env vars must behave exactly as it did before — `pay` works, the
// dashboard works, the MCP tools that don't depend on Creditcoin are all present.
// That is why every consumer goes through `attestcoinConfig()` and handles `null`
// rather than reading `process.env` directly and assuming a value is there.
//
// Within the integration, the credit / dispute / guarantee / passport contracts are
// each optional again: a deployment that only ran the original payment ASC keeps
// working, and each feature switches on exactly when its address is configured.

import { keccak256, toHex, type Address } from "viem";
import { ATTESTCOIN_CHAIN_KEYS, CHAIN_KEY_TO_EVM_CHAIN_ID, CREDITCOIN_TESTNET } from "./types";

export type AttestcoinConfig = {
  /** Attestcoin source-chain key (1 = Ethereum Sepolia). In `auto` mode this is the
   * initial value and `AttestcoinClient.resolveChainKey` replaces it from the live
   * registry at boot. */
  chainKey: number;
  /** `env`: the operator pinned a key. `auto`: select from the ChainInfo registry the
   * key whose chain id matches the source RPC — so pointing the source RPC at a newly
   * attested chain (Base, one day) is the whole migration. */
  chainKeyMode: "env" | "auto";
  /** EVM chain id matching `chainKey`, for sanity-checking the source RPC. */
  sourceChainId: number;
  /** RPC for the source chain (where the anchors live). */
  sourceRpcUrl: string;
  /** `PaymentAnchor` address on the source chain. */
  anchorAddress: Address;
  /** `FactAnchor` on the source chain; null disables credit, disputes and proven revocations. */
  factAnchorAddress: Address | null;
  /** Creditcoin JSON-RPC (HTTP; the SDK needs a JsonRpcApiProvider). */
  creditcoinRpcUrl: string;
  creditcoinChainId: number;
  /** `AttestPayASC` address on Creditcoin. */
  ascAddress: Address;
  /** `AttestPayCreditLine` on Creditcoin; null disables credit lines. */
  creditLineAddress: Address | null;
  /** `AttestPayLedger` on Creditcoin; null disables disputes and proven revocations. */
  ledgerAddress: Address | null;
  /** `AttestPayGuarantee` on Creditcoin; null disables bond reads and operator bonding. */
  guaranteeAddress: Address | null;
  /** `CreditPassport` on Creditcoin; null disables the composed passport read. */
  passportAddress: Address | null;
  /** The chain AttestPay's USDC payments actually settle on. */
  paymentChainId: number;
  /** Proof generator API base URL. */
  proverApiUrl: string;
  /** Signer key used to write anchors on the source chain AND submit proofs on
   * Creditcoin. Both legs need gas (Sepolia ETH, tCTC). */
  privateKey: string;
  /** Block explorer base for the source chain, for receipt links. */
  sourceExplorer: string;
  /** Block explorer base for Creditcoin. */
  creditcoinExplorer: string;
};

/** Env var names, in one place so docs and code cannot drift. */
export const ENV = {
  chainKey: "ATTESTPAY_ATTESTCOIN_CHAIN_KEY",
  sourceRpc: "ATTESTPAY_SEPOLIA_RPC",
  anchor: "ATTESTPAY_PAYMENT_ANCHOR_ADDRESS",
  factAnchor: "ATTESTPAY_FACT_ANCHOR_ADDRESS",
  creditcoinRpc: "ATTESTPAY_CREDITCOIN_HTTP_RPC",
  asc: "ATTESTPAY_ASC_ADDRESS",
  creditLine: "ATTESTPAY_CREDIT_LINE_ADDRESS",
  ledger: "ATTESTPAY_LEDGER_ADDRESS",
  guarantee: "ATTESTPAY_GUARANTEE_ADDRESS",
  passport: "ATTESTPAY_PASSPORT_ADDRESS",
  paymentChainId: "ATTESTPAY_PAYMENT_CHAIN_ID",
  prover: "ATTESTPAY_PROVER_API_URL",
  privateKey: "ATTESTPAY_ATTESTCOIN_PRIVATE_KEY",
  enabled: "ATTESTPAY_ATTESTCOIN_ENABLED",
} as const;

const DEFAULT_SOURCE_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const SOURCE_EXPLORERS: Record<number, string> = {
  11155111: "https://sepolia.etherscan.io",
  1: "https://etherscan.io",
  8453: "https://basescan.org",
  84532: "https://sepolia.basescan.org",
};

/** Explorer for a source chain id, with a sensible fallback. */
export function sourceExplorerFor(chainId: number): string {
  return SOURCE_EXPLORERS[chainId] ?? "https://sepolia.etherscan.io";
}

/** Reads an env var, treating the empty string as absent.
 * `.env.example` ships optional vars as `KEY=`, and Bun loads those as "", so a
 * bare `?? default` would hand an empty URL to ethers and fail confusingly later. */
function env(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? undefined : raw.trim();
}

const addr = (name: string): Address | null => (env(name) as Address | undefined) ?? null;

/** Resolves the Attestcoin configuration, or null when the integration is not set up.
 *
 * Requires the three values that have no safe default — the anchor address, the ASC
 * address, and the signer key. Everything else falls back to a public default. */
export function attestcoinConfig(): AttestcoinConfig | null {
  if (env(ENV.enabled) === "0") return null;

  const anchorAddress = env(ENV.anchor);
  const ascAddress = env(ENV.asc);
  const privateKey = env(ENV.privateKey);
  if (!anchorAddress || !ascAddress || !privateKey) return null;

  const chainKeyRaw = env(ENV.chainKey);
  const auto = chainKeyRaw?.toLowerCase() === "auto";
  const chainKey = chainKeyRaw && !auto ? Number(chainKeyRaw) : ATTESTCOIN_CHAIN_KEYS.ethereumSepolia;
  if (!Number.isInteger(chainKey) || chainKey <= 0) return null;

  const sourceChainId = CHAIN_KEY_TO_EVM_CHAIN_ID[chainKey] ?? 0;
  const paymentChainRaw = env(ENV.paymentChainId);
  const paymentChainId = paymentChainRaw ? Number(paymentChainRaw) : 8453;

  return {
    chainKey,
    chainKeyMode: auto ? "auto" : "env",
    sourceChainId,
    sourceRpcUrl: env(ENV.sourceRpc) ?? DEFAULT_SOURCE_RPC,
    anchorAddress: anchorAddress as Address,
    factAnchorAddress: addr(ENV.factAnchor),
    creditcoinRpcUrl: env(ENV.creditcoinRpc) ?? "https://rpc.cc3-testnet.creditcoin.network",
    creditcoinChainId: CREDITCOIN_TESTNET.chainId,
    ascAddress: ascAddress as Address,
    creditLineAddress: addr(ENV.creditLine),
    ledgerAddress: addr(ENV.ledger),
    guaranteeAddress: addr(ENV.guarantee),
    passportAddress: addr(ENV.passport),
    paymentChainId: Number.isInteger(paymentChainId) && paymentChainId > 0 ? paymentChainId : 8453,
    proverApiUrl: env(ENV.prover) ?? CREDITCOIN_TESTNET.proverApi,
    privateKey: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    sourceExplorer: sourceExplorerFor(sourceChainId),
    creditcoinExplorer: CREDITCOIN_TESTNET.explorer,
  };
}

/** Which optional features a configuration switches on. Each needs both its
 * Creditcoin consumer and the shared `FactAnchor` on the source chain. */
export function attestcoinFeatures(config: AttestcoinConfig | null): {
  credit: boolean;
  disputes: boolean;
  guarantee: boolean;
  passport: boolean;
} {
  if (!config) return { credit: false, disputes: false, guarantee: false, passport: false };
  const facts = config.factAnchorAddress !== null;
  return {
    credit: facts && config.creditLineAddress !== null,
    disputes: facts && config.ledgerAddress !== null,
    guarantee: config.guaranteeAddress !== null,
    passport: config.passportAddress !== null,
  };
}

/** Explains why the integration is disabled, for health endpoints and startup logs.
 * An operator who set two of three required vars should be told which one is missing
 * rather than seeing a silent no-op. */
export function attestcoinDisabledReason(): string | null {
  if (env(ENV.enabled) === "0") return `disabled explicitly (${ENV.enabled}=0)`;
  const missing = [
    [ENV.anchor, env(ENV.anchor)],
    [ENV.asc, env(ENV.asc)],
    [ENV.privateKey, env(ENV.privateKey)],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length === 0) return null;
  return `not configured (missing ${missing.join(", ")})`;
}

/** The contract-level card id: `keccak256(utf8(cardId))`.
 *
 * AttestPay card ids are opaque strings; Solidity indexes on bytes32. Hashing keeps
 * the id a fixed 32 bytes regardless of length and lets it be an indexed event topic.
 * The mapping is one-way — the dashboard resolves a hash back to a card by looking it
 * up locally, never by trying to invert this. */
export function cardIdToBytes32(cardId: string): `0x${string}` {
  return keccak256(toHex(cardId));
}

/** The contract-level dispute id, same construction as card ids. */
export function disputeIdToBytes32(disputeId: string): `0x${string}` {
  return keccak256(toHex(`dispute:${disputeId}`));
}
