#!/usr/bin/env bun
// Read-only liveness probe for the Attestcoin integration.
//
//   bun run packages/engine/scripts/attestcoin-probe.ts
//
// Spends no gas and needs no funded key: every check is a read. The point is to answer
// "is the cross-chain leg actually wired to a live protocol?" before anyone spends
// tCTC deploying, and to re-answer it later when something stops verifying.
//
// What it checks, in dependency order — each step is only meaningful if the one before
// it passed, so the script stops at the first hard failure rather than printing a wall
// of consequential errors:
//
//   1. Creditcoin RPC reachable, and it is really chain 102031
//   2. The ChainInfo precompile answers, and the configured chainKey is attested
//   3. Attestation is LIVE (lag is bounded), not merely present
//   4. The prover API agrees with the precompile about the attested height
//   5. A real proof can be generated for a real attested transaction
//   6. The returned proof has the structure the ASC expects
//   7. If ATTESTPAY_ASC_ADDRESS is set: the deployed ASC's wiring matches this config
//
// Exit code 0 = everything that could be checked passed.

import { Contract, JsonRpcProvider } from "ethers";
import {
  ATTESTPAY_ASC_ABI,
  CHAIN_INFO_ABI,
  CREDITCOIN_TESTNET,
  PRECOMPILES,
  attestcoinConfig,
  attestcoinDisabledReason,
  type ChainInfoContract,
} from "../src/attestcoin";

const CC_RPC = process.env.ATTESTPAY_CREDITCOIN_HTTP_RPC ?? "https://rpc.cc3-testnet.creditcoin.network";
const PROVER = process.env.ATTESTPAY_PROVER_API_URL ?? CREDITCOIN_TESTNET.proverApi;
const SOURCE_RPC = process.env.ATTESTPAY_SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com";
const CHAIN_KEY = Number(process.env.ATTESTPAY_ATTESTCOIN_CHAIN_KEY ?? "1");

/** Sepolia targets ~12s blocks; used only to turn a block lag into human minutes. */
const SOURCE_BLOCK_SECONDS = 12;
/** Above this the protocol is lagging badly enough to call out. */
const LAG_WARN_BLOCKS = 300;

let failures = 0;
let warnings = 0;

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => {
  warnings += 1;
  console.log(`  \x1b[33m!\x1b[0m ${m}`);
};
const bad = (m: string) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
};
const step = (n: number, m: string) => console.log(`\n\x1b[1m${n}. ${m}\x1b[0m`);

/** Declared as a function, not an arrow: TypeScript only narrows control flow through
 * a `never`-returning call when the callee is a function declaration, and the checks
 * below rely on that narrowing after a `die()`. */
function die(m: string): never {
  bad(m);
  console.log(`\n\x1b[31mProbe stopped: later checks depend on this one.\x1b[0m`);
  process.exit(1);
}

/** fetch with a timeout, so an unreachable endpoint fails in seconds not minutes. */
async function get(url: string, ms = 30_000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

const reason = (e: unknown): string =>
  e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);

async function main() {
  console.log("\x1b[1mAttestcoin integration probe\x1b[0m (read-only, no gas)");
  console.log(`  creditcoin : ${CC_RPC}`);
  console.log(`  prover     : ${PROVER}`);
  console.log(`  source rpc : ${SOURCE_RPC}`);
  console.log(`  chainKey   : ${CHAIN_KEY}`);

  // --- 1. Creditcoin RPC ---
  step(1, "Creditcoin RPC");
  const cc = new JsonRpcProvider(CC_RPC, undefined, { staticNetwork: true });
  let ccHead = 0;
  try {
    const net = await cc.getNetwork();
    ccHead = await cc.getBlockNumber();
    if (Number(net.chainId) !== CREDITCOIN_TESTNET.chainId) {
      die(`chain id is ${net.chainId}, expected ${CREDITCOIN_TESTNET.chainId} (CC3 testnet)`);
    }
    ok(`chain ${net.chainId} (${CREDITCOIN_TESTNET.name}), head ${ccHead.toLocaleString()}`);
  } catch (e) {
    die(`unreachable: ${reason(e)}`);
  }

  // --- 2. ChainInfo precompile + supported chains ---
  step(2, "ChainInfo precompile (0x…0fD3)");
  const chainInfo = new Contract(PRECOMPILES.chainInfo, CHAIN_INFO_ABI, cc) as ChainInfoContract;
  try {
    const chains = await chainInfo.get_supported_chains();
    const described = chains.map((c) => {
      // chainName is bytes holding ASCII; render it rather than dumping hex.
      const name = Buffer.from(c.chainName.replace(/^0x/, ""), "hex").toString("utf8");
      return { key: Number(c.chainKey), chainId: Number(c.chainId), name };
    });
    ok(`${described.length} attested source chain(s):`);
    for (const c of described) {
      console.log(`      chainKey ${c.key} → chainId ${c.chainId} (${c.name})`);
    }

    const mine = described.find((c) => c.key === CHAIN_KEY);
    if (!mine) {
      die(
        `configured chainKey ${CHAIN_KEY} is NOT attested; proofs would never verify. ` +
          `Pick one of: ${described.map((c) => c.key).join(", ")}`,
      );
    }
    ok(`configured chainKey ${CHAIN_KEY} is attested (${mine!.name}, chainId ${mine!.chainId})`);

    // The fact that motivated the whole PaymentAnchor design — worth restating from
    // live data rather than from a comment.
    if (!described.some((c) => c.chainId === 8453 || c.chainId === 84532)) {
      ok("Base is NOT an attested source chain → anchoring on an attested chain is required");
    } else {
      warn("Base now appears attested — PaymentAnchor could be skipped; see docs §2");
    }
  } catch (e) {
    die(`precompile call failed: ${reason(e)}`);
  }

  // --- 3. Attestation liveness ---
  step(3, "Attestation liveness");
  let attestedHeight = 0;
  try {
    const latest = await chainInfo.get_latest_attestation_height_and_hash(BigInt(CHAIN_KEY));
    if (!latest.exists) die(`no attestations exist for chainKey ${CHAIN_KEY}`);
    attestedHeight = Number(latest.height);
    ok(`latest attested height ${attestedHeight.toLocaleString()}`);

    const src = new JsonRpcProvider(SOURCE_RPC, undefined, { staticNetwork: true });
    const srcHead = await src.getBlockNumber();
    const lag = srcHead - attestedHeight;
    const mins = Math.round((lag * SOURCE_BLOCK_SECONDS) / 60);
    ok(`source head ${srcHead.toLocaleString()}`);
    if (lag < 0) {
      warn(`attested height is AHEAD of the source head by ${-lag} blocks (source RPC lagging?)`);
    } else if (lag > LAG_WARN_BLOCKS) {
      warn(`lag ${lag} blocks (~${mins} min) — above the ${LAG_WARN_BLOCKS}-block comfort line`);
    } else {
      ok(`lag ${lag} blocks (~${mins} min): attestation is live and current`);
    }
  } catch (e) {
    die(`liveness check failed: ${reason(e)}`);
  }

  // --- 4. Prover API agrees with the precompile ---
  step(4, "Prover API");
  let proverHeight = 0;
  try {
    const r = (await get(`${PROVER}/api/v1/attested-height/${CHAIN_KEY}`)) as {
      attestedHeight?: number;
    };
    if (typeof r.attestedHeight !== "number") die(`unexpected response: ${JSON.stringify(r)}`);
    proverHeight = r.attestedHeight;
    ok(`prover reports attested height ${proverHeight.toLocaleString()}`);

    // The prover serves from its own cache, so small drift is normal; a large gap means
    // proofs will fail for blocks the precompile already considers attested.
    const drift = Math.abs(proverHeight - attestedHeight);
    if (drift > 200) {
      warn(`prover and precompile disagree by ${drift} blocks — proof generation may lag`);
    } else {
      ok(`agrees with the precompile (drift ${drift} blocks)`);
    }
  } catch (e) {
    die(`prover API unreachable: ${reason(e)}`);
  }

  // --- 5 + 6. A real proof, with the structure the ASC expects ---
  step(5, "Proof generation for a real attested transaction");
  try {
    const src = new JsonRpcProvider(SOURCE_RPC, undefined, { staticNetwork: true });
    // Step back from the attested tip so the block is comfortably inside the
    // prover's cache, then find a block that actually contains transactions.
    let txHash: string | null = null;
    let atHeight = 0;
    for (const back of [60, 120, 240, 480]) {
      const h = Math.min(attestedHeight, proverHeight) - back;
      const block = await src.getBlock(h);
      if (block && block.transactions.length > 0) {
        txHash = block.transactions[0]!;
        atHeight = h;
        break;
      }
    }
    if (!txHash) die("could not find an attested source block containing a transaction");

    ok(`probing tx ${txHash!.slice(0, 18)}… from block ${atHeight.toLocaleString()}`);
    const proof = (await get(`${PROVER}/api/v1/proof-by-tx/${CHAIN_KEY}/${txHash}`, 180_000)) as {
      chainKey?: number;
      headerNumber?: number;
      txIndex?: number;
      txBytes?: string;
      merkleProof?: { root?: string; siblings?: unknown[] };
      continuityProof?: { lowerEndpointDigest?: string; roots?: unknown[] };
    };
    ok("proof generated");

    step(6, "Proof structure matches what AttestPayASC expects");
    const checks: Array<[string, boolean, string]> = [
      ["chainKey", proof.chainKey === CHAIN_KEY, String(proof.chainKey)],
      ["headerNumber", typeof proof.headerNumber === "number", String(proof.headerNumber)],
      ["txIndex", typeof proof.txIndex === "number", String(proof.txIndex)],
      [
        "txBytes",
        typeof proof.txBytes === "string" && proof.txBytes.startsWith("0x") && proof.txBytes.length > 2,
        `${((proof.txBytes?.length ?? 2) - 2) / 2} bytes`,
      ],
      [
        "merkleProof.root",
        typeof proof.merkleProof?.root === "string",
        String(proof.merkleProof?.root).slice(0, 18) + "…",
      ],
      [
        "merkleProof.siblings",
        Array.isArray(proof.merkleProof?.siblings),
        `${proof.merkleProof?.siblings?.length} entries`,
      ],
      [
        "continuityProof.lowerEndpointDigest",
        typeof proof.continuityProof?.lowerEndpointDigest === "string",
        String(proof.continuityProof?.lowerEndpointDigest).slice(0, 18) + "…",
      ],
      [
        "continuityProof.roots",
        Array.isArray(proof.continuityProof?.roots),
        `${proof.continuityProof?.roots?.length} root(s)`,
      ],
    ];
    for (const [field, good, detail] of checks) {
      if (good) ok(`${field}: ${detail}`);
      else bad(`${field}: missing or wrong type (got ${detail})`);
    }

    // The envelope the ASC's decoder depends on: abi.encode(uint8, bytes[]).
    if (proof.txBytes) {
      const typeTag = parseInt(proof.txBytes.slice(2, 66), 16);
      if (typeTag <= 4) ok(`txBytes envelope starts with a valid tx type tag (${typeTag})`);
      else bad(`txBytes envelope leads with ${typeTag}, not a tx type 0-4`);
    }
  } catch (e) {
    bad(`proof generation failed: ${reason(e)}`);
  }

  // --- 7. Deployed ASC wiring (only if configured) ---
  step(7, "Deployed AttestPayASC");
  const ascAddress = process.env.ATTESTPAY_ASC_ADDRESS?.trim();
  if (!ascAddress) {
    console.log(`  \x1b[2m· skipped: ATTESTPAY_ASC_ADDRESS not set (nothing deployed yet)\x1b[0m`);
  } else {
    try {
      const asc = new Contract(ascAddress, ATTESTPAY_ASC_ABI, cc);
      const [key, anchor, anchorer, prover] = (await Promise.all([
        asc.sourceChainKey!(),
        asc.paymentAnchor!(),
        asc.trustedAnchorer!(),
        asc.blockProver!(),
      ])) as [bigint, string, string, string];

      ok(`ASC at ${ascAddress}`);
      ok(`  sourceChainKey  ${key}`);
      ok(`  paymentAnchor   ${anchor}`);
      ok(`  trustedAnchorer ${anchorer}`);

      if (Number(key) !== CHAIN_KEY) {
        bad(`ASC sourceChainKey ${key} != configured ${CHAIN_KEY}: every proof would be for the wrong chain`);
      }
      if (prover.toLowerCase() !== PRECOMPILES.blockProver.toLowerCase()) {
        bad(`ASC blockProver is ${prover}, not the canonical precompile ${PRECOMPILES.blockProver}`);
      } else {
        ok("  blockProver is the canonical precompile");
      }

      const expectedAnchor = process.env.ATTESTPAY_PAYMENT_ANCHOR_ADDRESS?.trim();
      if (expectedAnchor && anchor.toLowerCase() !== expectedAnchor.toLowerCase()) {
        bad(`ASC paymentAnchor ${anchor} != configured ${expectedAnchor}`);
      }

      // The full server-side check also compares the anchorer against the signing key,
      // which this probe deliberately does not load.
      const cfg = attestcoinConfig();
      if (cfg) ok("server configuration resolves (anchorer key checked at server boot)");
      else warn(`server would run with Attestcoin OFF: ${attestcoinDisabledReason()}`);
    } catch (e) {
      bad(`could not read the ASC: ${reason(e)}`);
    }
  }

  // --- verdict ---
  console.log("");
  if (failures > 0) {
    console.log(`\x1b[31m${failures} check(s) failed\x1b[0m, ${warnings} warning(s)`);
    process.exit(1);
  }
  console.log(
    `\x1b[32mAll checks passed\x1b[0m${warnings > 0 ? `, ${warnings} warning(s)` : ""} — the Attestcoin protocol is live and the integration is wired correctly.`,
  );
}

main().catch((e) => {
  console.error(`\n\x1b[31mprobe crashed:\x1b[0m ${reason(e)}`);
  process.exit(1);
});
