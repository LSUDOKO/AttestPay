// Chain + relayer constants for AttestPay. Base mainnet (8453) is THE chain (locked);
// Base Sepolia kept for dev-only experiments, never the demo.
// All values empirically verified Jun 5-6 2026 (probes/RESULTS.md).

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";

export const CHAINS = {
  8453: {
    name: "Base",
    chain: base,
    relayer: "https://relayer.1shotapi.com/relayers",
    // 1Shot Public Relayer: every leaf delegation's delegate MUST be this address.
    targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a" as Address,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
  },
  84532: {
    name: "Base Sepolia",
    chain: baseSepolia,
    relayer: "https://relayer.1shotapi.dev/relayers",
    targetAddress: "0xf1ef956eff4181Ce913b664713515996858B9Ca9" as Address,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
  },
} as const;

export type ChainId = keyof typeof CHAINS;

/** The chain this deployment settles on. Base mainnet by default; set
 * ATTESTPAY_CHAIN_ID=84532 to run the whole stack on Base Sepolia (free testnet USDC
 * from a faucet, the 1Shot .dev relayer, testnet enforcer addresses — all already in
 * CHAINS above). Every engine function takes an explicit chainId and falls back to
 * this, so the switch is one variable rather than a code change.
 *
 * An unknown value is a hard failure, not a silent fallback: quietly settling on
 * mainnet when the operator asked for a testnet is exactly the mistake worth crashing
 * on at boot. */
function resolveChainId(): ChainId {
  const raw = process.env.ATTESTPAY_CHAIN_ID?.trim();
  if (!raw) return 8453;
  const n = Number(raw);
  if (n in CHAINS) return n as ChainId;
  throw new Error(
    `ATTESTPAY_CHAIN_ID=${raw} is not a supported chain (supported: ${Object.keys(CHAINS).join(", ")})`,
  );
}

export const CHAIN_ID: ChainId = resolveChainId();

// Shared across both chains (verified identical).
export const FEE_COLLECTOR = "0xE936e8FAf4A5655469182A49a505055B71C17604" as Address;
export const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;

// SAK 1.6.0's getSmartAccountsEnvironment OMITS this enforcer; it IS deployed on both
// chains (eth_getCode verified). Always pass manually, never trust the SDK env map.
export const LOGICAL_OR_WRAPPER = "0xE1302607a3251AF54c3a6e69318d6aa07F5eB46c" as Address;

// Swap preset constants (Base mainnet).
export const SWAP_ROUTER_02 = "0x2626664c2603336E57B271c5C0b26F421741e481" as Address;
export const WETH = "0x4200000000000000000000000000000000000006" as Address;

// RPC: ATTESTPAY_RPC_URL (Alchemy in dev/prod) with public fallback.
//
// The name is case-sensitive and must match `.env.example`. This read was previously
// spelled in lowercase, so the configured RPC was never picked up and every call
// silently used the public endpoint — which rate-limits under load.
export function rpcUrl(chainId: ChainId = CHAIN_ID): string {
  if (chainId === CHAIN_ID && process.env.ATTESTPAY_RPC_URL) return process.env.ATTESTPAY_RPC_URL;
  return chainId === 8453 ? "https://mainnet.base.org" : "https://sepolia.base.org";
}

const clients = new Map<ChainId, PublicClient>();
export function publicClient(chainId: ChainId = CHAIN_ID): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    c = createPublicClient({
      chain: CHAINS[chainId].chain,
      transport: http(rpcUrl(chainId)),
    }) as PublicClient;
    clients.set(chainId, c);
  }
  return c;
}
