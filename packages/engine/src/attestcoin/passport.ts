// The credit passport as a portable, signed credential.
//
// `CreditPassport.passportOf` is the on-chain truth and any Creditcoin dApp can call
// it. Off-chain consumers — a merchant's backend, another agent framework — want the
// same record without an RPC: a JSON document they can verify with one signature
// check. That is what this module produces: the passport, canonicalised, signed by
// AttestPay's anchorer key (EIP-191), with the contract address and chain id inside
// the payload so a verifier knows exactly which on-chain state it summarises and can
// go read it themselves.
//
// The credential does not make the passport more trustworthy than the chain; it makes
// it more portable. The signature says "AttestPay read this from CreditPassport at
// this time", nothing more, and `verifyPassportCredential` checks exactly that.

import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import type { Passport } from "./types";
import { stableStringify } from "./worker";

export const PASSPORT_CREDENTIAL_TYPE = "AttestPayCreditPassport";
export const PASSPORT_CREDENTIAL_VERSION = "1";

/** Default credential lifetime. The passport changes as payments verify, so a
 * credential is a snapshot with a short shelf life, not a long-lived certificate. */
export const PASSPORT_CREDENTIAL_TTL_S = 24 * 3600;

export type PassportJson = {
  account: Address;
  verified_payments: number;
  verified_volume_usdc: string;
  first_payment_at: string | null;
  last_payment_at: string | null;
  within_terms_payments: number;
  terms_checked_payments: number;
  lines_opened: number;
  lines_repaid: number;
  lines_defaulted: number;
  total_drawn_usdc: string;
  total_repaid_usdc: string;
  disputes_opened: number;
  disputes_upheld: number;
  disputes_rejected: number;
  disputed_volume_usdc: string;
  guarantee_bonded_ctc: string;
  score: number;
  grade: string;
  as_of: string;
};

export type PassportCredentialPayload = {
  type: typeof PASSPORT_CREDENTIAL_TYPE;
  version: typeof PASSPORT_CREDENTIAL_VERSION;
  /** The issuing deployment, so two AttestPay instances cannot be confused. */
  issuer: string;
  chain_id: number;
  passport_contract: Address;
  issued_at: string;
  expires_at: string;
  passport: PassportJson;
};

export type PassportCredential = {
  payload: PassportCredentialPayload;
  /** EIP-191 signature over `canonicalPayload(payload)`. */
  signature: Hex;
  signer: Address;
  /** How to verify, stated in the document itself. */
  verification: string;
};

const usdc = (atoms: bigint): string => (Number(atoms) / 1e6).toFixed(6);
const ctc = (wei: bigint): string => (Number(wei) / 1e18).toFixed(6);
const iso = (sec: bigint | number): string | null => {
  const n = Number(sec);
  return n === 0 ? null : new Date(n * 1000).toISOString();
};

/** The passport as JSON-safe values with units in the field names. */
export function passportToJson(p: Passport): PassportJson {
  return {
    account: p.account,
    verified_payments: Number(p.verifiedPayments),
    verified_volume_usdc: usdc(p.verifiedVolume),
    first_payment_at: iso(p.firstPaymentAt),
    last_payment_at: iso(p.lastPaymentAt),
    within_terms_payments: Number(p.withinTermsPayments),
    terms_checked_payments: Number(p.termsCheckedPayments),
    lines_opened: Number(p.linesOpened),
    lines_repaid: Number(p.linesRepaid),
    lines_defaulted: Number(p.linesDefaulted),
    total_drawn_usdc: usdc(p.totalDrawn),
    total_repaid_usdc: usdc(p.totalRepaid),
    disputes_opened: Number(p.disputesOpened),
    disputes_upheld: Number(p.disputesUpheld),
    disputes_rejected: Number(p.disputesRejected),
    disputed_volume_usdc: usdc(p.disputedVolume),
    guarantee_bonded_ctc: ctc(p.guaranteeBonded),
    score: Number(p.score),
    grade: p.grade,
    as_of: iso(p.asOf) ?? new Date(0).toISOString(),
  };
}

/** The exact bytes that get signed: key-sorted JSON, so any implementation that
 * canonicalises the same way produces the same digest. */
export function canonicalPayload(payload: PassportCredentialPayload): string {
  return stableStringify(payload);
}

export async function issuePassportCredential(
  passport: Passport,
  opts: {
    signerPrivateKey: Hex;
    issuer: string;
    chainId: number;
    passportContract: Address;
    now?: number;
    ttlSeconds?: number;
  },
): Promise<PassportCredential> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const payload: PassportCredentialPayload = {
    type: PASSPORT_CREDENTIAL_TYPE,
    version: PASSPORT_CREDENTIAL_VERSION,
    issuer: opts.issuer,
    chain_id: opts.chainId,
    passport_contract: opts.passportContract,
    issued_at: new Date(now * 1000).toISOString(),
    expires_at: new Date((now + (opts.ttlSeconds ?? PASSPORT_CREDENTIAL_TTL_S)) * 1000).toISOString(),
    passport: passportToJson(passport),
  };
  const account = privateKeyToAccount(opts.signerPrivateKey);
  const signature = await account.signMessage({ message: canonicalPayload(payload) });
  return {
    payload,
    signature,
    signer: account.address,
    verification:
      "EIP-191 personal_sign over the key-sorted JSON of `payload`. Recover the signer and compare it to the AttestPay anchorer (the ASC's trustedAnchorer). The same facts are readable live from `passport_contract.passportOf(account)` on `chain_id`.",
  };
}

export type CredentialCheck = {
  valid: boolean;
  signer: Address | null;
  expired: boolean;
  reason?: string;
};

/** Verifies a credential: signature recovers to `expectedSigner` (when given) and
 * the document has not expired. */
export async function verifyPassportCredential(
  cred: { payload: PassportCredentialPayload; signature: Hex },
  opts: { expectedSigner?: Address; now?: number } = {},
): Promise<CredentialCheck> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: canonicalPayload(cred.payload), signature: cred.signature });
  } catch {
    return { valid: false, signer: null, expired: false, reason: "signature is malformed" };
  }
  const expired = Date.parse(cred.payload.expires_at) / 1000 < now;
  if (opts.expectedSigner && signer.toLowerCase() !== opts.expectedSigner.toLowerCase()) {
    return { valid: false, signer, expired, reason: `signed by ${signer}, expected ${opts.expectedSigner}` };
  }
  if (cred.payload.type !== PASSPORT_CREDENTIAL_TYPE) {
    return { valid: false, signer, expired, reason: `unexpected type ${cred.payload.type}` };
  }
  if (expired) return { valid: false, signer, expired, reason: "credential has expired" };
  return { valid: true, signer, expired: false };
}
