// Attestcoin Protocol integration: cross-chain payment verification on Creditcoin.
//
// Read the flow top-down:
//   config.ts    — is the integration switched on, and wired to what?
//   types.ts     — the proof lifecycle and domain shapes
//   client.ts    — the network legs (anchor / prove / submit) + registry discovery
//   store.ts     — persistence for the lifecycle, credit lines, disputes
//   worker.ts    — the state machine that drives rows to 'verified' (payments + facts)
//   credit.ts    — credit lines: EIP-712 terms, draws, repayments
//   facts.ts     — disputes and proven revocations
//   passport.ts  — the signed, portable credit passport credential
//   health.ts    — attestation lag, queue depth, credit grading
//   abi.ts       — contract + precompile ABIs
//   telemetry.ts — SigNoz spans, metrics, structured logs

export * from "./types";
export * from "./config";
export * from "./abi";
export * from "./contracts";
export * from "./telemetry";
export * from "./client";
export * from "./store";
export * from "./worker";
export * from "./credit";
export * from "./facts";
export * from "./passport";
export * from "./health";
