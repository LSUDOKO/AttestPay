// Public, client-safe constants + a read-only chain client. The Privy App ID and
// Client ID are PUBLIC client credentials (never the app secret).
//
// CHAIN: Base mainnet (8453) by default. Set NEXT_PUBLIC_ATTESTPAY_CHAIN_ID=84532 at
// BUILD time to run the dashboard against Base Sepolia, where USDC comes from a free
// faucet. This MUST match the server's ATTESTPAY_CHAIN_ID: the delegation signed here
// carries the chain id, so a mismatch produces signatures the relayer cannot redeem.

import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";

export const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "cmq14zjut00040cjv4fgj82vd";
export const PRIVY_CLIENT_ID =
  process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID ?? "client-WY6aErb7JSTTnL52yVH5tufA1xn1nLNvN1oBwKrNMEyfF";

const CHAINS = {
  8453: {
    name: "Base",
    chain: base,
    rpc: "https://mainnet.base.org",
    // Lowercase on purpose: consumers compare against user-supplied token lists
    // case-insensitively.
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address,
    // WETH is the OP-stack predeploy, identical on both chains.
    weth: "0x4200000000000000000000000000000000000006" as Address,
  },
  84532: {
    name: "Base Sepolia",
    chain: baseSepolia,
    rpc: "https://sepolia.base.org",
    usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e" as Address,
    weth: "0x4200000000000000000000000000000000000006" as Address,
  },
} as const;

const RAW_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ATTESTPAY_CHAIN_ID ?? 8453);
export const CHAIN_ID = (RAW_CHAIN_ID in CHAINS ? RAW_CHAIN_ID : 8453) as keyof typeof CHAINS;
const ACTIVE = CHAINS[CHAIN_ID];

export const BASE_RPC = process.env.NEXT_PUBLIC_BASE_RPC ?? ACTIVE.rpc;

/** Human name of the active chain. Funding copy MUST use this: telling someone to
 * "send USDC on Base" while the stack settles on Base Sepolia sends real money to a
 * network the cards cannot spend on. */
export const CHAIN_NAME = ACTIVE.name;

// DelegationManager (same on Base + Base Sepolia), verified Jun 5 2026.
export const DELEGATION_MANAGER = "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" as Address;

/** USDC on the active chain. Name kept for its many call sites. */
export const USDC_BASE = ACTIVE.usdc;
/** WETH on the active chain (the execute lane swaps USDC->WETH). */
export const WETH_BASE = ACTIVE.weth;

export const publicClient = createPublicClient({ chain: ACTIVE.chain, transport: http(BASE_RPC) });
