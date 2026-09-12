// Dashboard API client. AUTH: every call carries the user's Privy access token; the
// server verifies it against the app JWKS and scopes every route to the authenticated
// user (no shared admin token in the browser, ever). IDENTITY: the Privy embedded
// wallet address is the userId (one user row per wallet, bound to the Privy DID at
// onboard), and issuance is CLIENT-signed (onboard -> prepare -> sign -> finalize).

import { getAccessToken } from "@privy-io/react-auth";

const BASE = process.env.NEXT_PUBLIC_ATTESTPAY_API ?? "http://localhost:4070/api";

type Hex = `0x${string}`;
type Wire7702Auth = { chainId: Hex; address: Hex; nonce: Hex; yParity: Hex; r: Hex; s: Hex };
export type WireDelegation = {
  delegator: Hex;
  delegate: Hex;
  authority: Hex;
  caveats: { enforcer: Hex; terms: Hex; args: Hex }[];
  salt: Hex;
  signature: Hex;
};

// Nothing in the boot path may await forever: a wedged token refresh (stale
// session on iOS Safari, in-app browsers) or a stalled connection must surface
// as an error the UI can show, never an infinite "Loading…".
const TOKEN_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 20_000;
// Venice NL compile is an LLM round-trip (slow model + a parse-retry pass), far slower
// than every other API call. Give it its own budget so the dashboard doesn't abort while
// the server is still drafting (was: shared 20s -> "request timed out" mid-compile).
const COMPILE_TIMEOUT_MS = 65_000;

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    clearTimeout(t);
  }
}

/** AbortSignal.timeout where it exists; a hand-rolled controller for older WebKit */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && "timeout" in AbortSignal) return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(new DOMException("request timed out", "TimeoutError")), ms);
  return ctl.signal;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // refreshes if near expiry; null when logged out
  const token = await withTimeout(getAccessToken(), TOKEN_TIMEOUT_MS, "session token");
  if (!token) throw new Error("not signed in");
  const signal = init?.signal ?? timeoutSignal(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init?.headers,
      },
      cache: "no-store",
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error("request timed out");
    }
    throw e;
  }
  // a non-JSON ERROR body (edge/proxy HTML on 502/503) falls back to the status
  // line; a malformed or cut-off body on a 2xx must SURFACE, never return null-as-T
  let body: { message?: string; error?: string } | null = null;
  try {
    body = (await res.json()) as { message?: string; error?: string } | null;
  } catch (e) {
    if (res.ok) {
      if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
        throw new Error("request timed out");
      }
      throw new Error("malformed response body");
    }
  }
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `http ${res.status}`);
  return body as T;
}

export type ContractTermsInput = {
  targets: string[];
  selectors: string[];
  /** ERC-20 tokens the card may grant allowances on (#42). Unioned into targets server-side. */
  tokens?: string[];
  /** per-allowance USDC ceiling (#42). */
  perTradeMax?: string;
};

export type CardTermsInput = {
  pay?: { period?: { amount: string; seconds: number }; lifetime?: { amount: string } };
  /** contract scope: enables the agent's `execute` tool surface (swaps, approvals, calls). */
  contract?: ContractTermsInput;
  expiry?: number;
  maxUses?: number;
  perTxMax?: string;
  merchants?: string[];
  subcards?: boolean;
};

/** A resolved entity in a compiled draft: a human label + provenance for an address the
 * user reviews instead of raw hex (#43). */
export type CompileLabel = {
  query: string;
  address: string;
  label: string;
  kind: "token" | "protocol" | "verified_contract" | "raw_address";
  source: "registry" | "basescan" | "user_input";
  decimals?: number;
};

export type CompileResult = {
  draft: CardTermsInput | null;
  labels: CompileLabel[];
  warnings: string[];
};

export type CardState = {
  card_id: string;
  name: string;
  status: string;
  terms: CardTermsInput;
  remaining_this_period: string | null;
  remaining_lifetime: string | null;
  period_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
  parent_card_id?: string | null;
  created_at?: number;
  team?: { team_id: string; name: string } | null;
  your_role?: "owner" | "admin" | "member" | "viewer";
};

export type TreeNode = { card: CardState; children: TreeNode[] };

export type Charge = {
  id: string;
  kind: string;
  to: string | null;
  amount: string;
  fee: string;
  status: string;
  tx: string | null;
  memo: string | null;
  at: number;
};

/** the linked test-mode Visa (owner view) · linked:false when no fiat lane */
export type FiatCard = {
  linked: boolean;
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  number?: string | null;
  cvc?: string | null;
  cardholder_name?: string | null;
};

// ---------------------------------------------------------------------------
// Attestcoin cross-chain verification
// ---------------------------------------------------------------------------

/** Where a payment has reached in the cross-chain proof pipeline. */
export type ProofStatus =
  | "pending"
  | "anchoring"
  | "anchored"
  | "attested"
  | "proving"
  | "verified"
  | "failed";

/** One leg of a payment's journey, with the link that proves it. */
export type ProofLeg = { tx_hash: string; explorer: string | null; height?: number | null };

export type AttestcoinProofRow = {
  charge_id: string;
  status: ProofStatus;
  amount: string | null;
  merchant: string | null;
  memo: string | null;
  /** the USDC transfer on Base */
  source: ProofLeg | null;
  /** the anchor on the attested source chain */
  anchor: ProofLeg | null;
  /** the verification on Creditcoin */
  creditcoin: ProofLeg | null;
  verified_at: string | null;
  error: string | null;
  attempts: number;
  created_at: string | null;
};

export type AttestcoinProofs = {
  configured: boolean;
  items: AttestcoinProofRow[];
  stats: {
    total: number;
    verified: number;
    failed: number;
    inFlight: number;
    avg_verify_seconds: number | null;
  } | null;
};

export type CreditScore = {
  configured: boolean;
  reason?: string;
  error?: string;
  /** false when the figures came from the local cache because Creditcoin was down */
  live?: boolean;
  synced_at?: string | null;
  payer?: string;
  grade?: "A" | "B" | "C" | "D" | "F";
  score?: number;
  basis?: string;
  total_verified_payments?: number;
  total_verified_volume?: string;
  first_payment_at?: string | null;
  last_payment_at?: string | null;
  within_terms_payments?: number;
  terms_checked_payments?: number;
  asc_explorer?: string;
};

export type AttestcoinHealth = {
  configured: boolean;
  chainKey: number | null;
  latestAttestedHeight: number | null;
  sourceHead: number | null;
  /** null means "could not find out", which is NOT the same as zero lag */
  attestationLagBlocks: number | null;
  queue: Record<ProofStatus, number>;
  creditcoinChainId: number | null;
  ascAddress: string | null;
  anchorAddress: string | null;
  error?: string;
};


// ---------------------------------------------------------------------------
// Credit lines, disputes, passport, guarantees, facts
// ---------------------------------------------------------------------------

export type CreditLineStatus = "proposed" | "signed" | "opening" | "open" | "active" | "repaid" | "defaulted" | "closed" | "failed";

export type CreditLine = {
  line_id: string;
  status: CreditLineStatus;
  lender: string;
  borrower: string;
  borrower_card_id: string | null;
  funding_card_id: string;
  limit: string;
  interest_bps: number;
  expires_at: string | null;
  drawn: string;
  repaid: string;
  owed: string;
  outstanding: string;
  available: string;
  signatures: { lender: boolean; borrower: boolean };
  creditcoin_tx_hash: string | null;
  creditcoin_explorer: string | null;
  error: string | null;
  created_at: string | null;
};

export type TypedDataWire = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string>;
};

export type Fact = {
  fact_id: string;
  kind: "draw" | "repayment" | "dispute_opened" | "dispute_resolved" | "card_revoked";
  ref_id: string;
  status: ProofStatus;
  target: "credit_line" | "ledger";
  anchor_tx_hash: string | null;
  creditcoin_tx_hash: string | null;
  creditcoin_explorer: string | null;
  verified_at: string | null;
  error: string | null;
  attempts: number;
  created_at: string | null;
};

export type CreditLineDetail = CreditLine & {
  typed_data: TypedDataWire | null;
  events: Array<{ kind: "draw" | "repayment"; charge_id: string; amount: string; charge_status: string | null; tx_hash: string | null; explorer: string | null; at: string | null }>;
  facts: Fact[];
  on_chain: Record<string, string | null> | null;
  on_chain_error: string | null;
};

export type Dispute = {
  dispute_id: string;
  charge_id: string;
  card_id: string;
  status: "open" | "upheld" | "rejected" | "withdrawn";
  reason: string;
  resolution_note: string | null;
  opened_by: string;
  resolved_by: string | null;
  opened_at: string | null;
  resolved_at: string | null;
  facts: Fact[];
};

export type PassportJson = {
  account: string;
  verified_payments: number;
  verified_volume_usdc: string;
  first_payment_at: string | null;
  last_payment_at: string | null;
  within_terms_payments: number;
  terms_checked_payments: number;
  lines_opened?: number;
  lines_repaid?: number;
  lines_defaulted?: number;
  total_drawn_usdc?: string;
  total_repaid_usdc?: string;
  disputes_opened?: number;
  disputes_upheld?: number;
  disputes_rejected?: number;
  disputed_volume_usdc?: string;
  guarantee_bonded_ctc?: string;
  score: number;
  grade: string;
  as_of?: string;
};

export type Passport = {
  configured: boolean;
  source?: string;
  account: string;
  passport?: PassportJson;
  credential?: { payload: Record<string, unknown>; signature: string; signer: string; verification: string } | null;
  local?: { credit_lines: CreditLine[]; disputes: Dispute[] } | null;
  note?: string;
  reason?: string;
  contracts?: { passport: string; explorer: string };
};

export type Webhook = { webhook_id: string; url: string; events: string[]; description: string | null; active: boolean; created_at: string | null };
export type Delivery = { delivery_id: string; event_type: string; status: string; attempts: number; next_attempt_at: string | null; last_status_code: number | null; last_error: string | null; created_at: string | null; delivered_at: string | null };
export type EventRow = { id: string; type: string; card_id: string | null; data: Record<string, unknown>; created_at: string };
export type AuditEntry = { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> | null; ip: string | null };
export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type Team = {
  team_id: string;
  name: string;
  owner: string;
  your_role: TeamRole;
  members: Array<{ user_id: string; role: TeamRole; since: string }>;
  cards: Array<{ card_id: string; name: string | null; status: string | null; owner: string | null }>;
};

/** The server root (the API base without /api), for public routes. */
export const API_ORIGIN = BASE.replace(/\/api\/?$/, "");

/** Unauthenticated GET/POST against the server root (the passport is public). */
export async function publicCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_ORIGIN}${path}`, { ...init, headers: { "content-type": "application/json", ...init?.headers }, cache: "no-store" });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? `http ${res.status}`);
  return body as T;
}

export const api = {
  // --- Privy lane: onboard + client-signed issuance ---
  // proof = personal_sign("attestpay-onboard:v1:<did>") · binds the wallet to THIS login
  onboard: (address: string, auth7702: Wire7702Auth, proof: Hex) =>
    call<{ user_id: string; address: string; revocation_nonce: string; has_auth7702: boolean }>("/onboard", {
      method: "POST",
      body: JSON.stringify({ address, auth7702, proof }),
    }),
  prepareCard: (name: string, terms: CardTermsInput, userAddress: string) =>
    call<{ prepare_id: string; chain_id: number; k_agent_address: string; delegation: WireDelegation }>("/cards/prepare", {
      method: "POST",
      body: JSON.stringify({ name, terms, userAddress }),
    }),
  finalizeCard: (prepareId: string, signature: string) =>
    call<{ card_id: string; card_url: string; terms: CardTermsInput }>("/cards/finalize", {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),

  // --- Venice NL compiler: free-text intent -> DRAFT CardTerms (#43; never issues) ---
  compile: (intent: string) =>
    call<CompileResult>("/cards/compile", {
      method: "POST",
      body: JSON.stringify({ intent }),
      signal: timeoutSignal(COMPILE_TIMEOUT_MS),
    }),

  // --- reads + server-side controls (scoped to the embedded-wallet userId) ---
  tree: (userId: string) => call<{ tree: TreeNode[] }>(`/tree?userId=${encodeURIComponent(userId)}`),
  cards: () => call<CardState[]>("/cards"),
  card: (id: string) => call<CardState & { charges: Charge[]; k_agent_address: string }>(`/cards/${id}`),
  url: (id: string) => call<{ card_url: string }>(`/cards/${id}/url`),
  fiatCard: (id: string) => call<FiatCard>(`/cards/${id}/fiat`),
  rotate: (id: string) => call<{ card_url: string }>(`/cards/${id}/rotate`, { method: "POST" }),
  freeze: (id: string) => call<{ status: string }>(`/cards/${id}/freeze`, { method: "POST" }),
  unfreeze: (id: string) => call<{ status: string }>(`/cards/${id}/unfreeze`, { method: "POST" }),
  // bookkeeping removal of a DEAD card + its subtree (server refuses live cards)
  deleteCard: (id: string) => call<{ deleted: boolean; removed: number }>(`/cards/${id}`, { method: "DELETE" }),

  // --- on-chain USER-signed ops: the embedded wallet signs an admin leaf in the
  // browser (prepare -> signDelegation -> finalize). Sub-card revokes come back
  // immediately from prepare (server-side kill, nothing to sign). ---
  prepareRevoke: (id: string) =>
    call<
      | { prepare_id: string; chain_id: number; kind: "revoke"; delegation: WireDelegation }
      | { status: "revoked"; onchain: false }
    >(`/cards/${id}/revoke/prepare`, { method: "POST", body: "{}" }),
  finalizeRevoke: (id: string, prepareId: string, signature: string) =>
    call<{ status: string; tx: string | null }>(`/cards/${id}/revoke/finalize`, {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),
  prepareNuke: () =>
    call<{ prepare_id: string; chain_id: number; kind: "nuke"; delegation: WireDelegation }>("/nuke/prepare", {
      method: "POST",
      body: "{}",
    }),
  finalizeNuke: (prepareId: string, signature: string) =>
    call<{ status: string; tx: string | null; new_nonce: string }>("/nuke/finalize", {
      method: "POST",
      body: JSON.stringify({ prepare_id: prepareId, signature }),
    }),

  // --- Attestcoin cross-chain verification ---
  attestcoinProofs: (id: string) => call<AttestcoinProofs>(`/cards/${id}/attestcoin-proofs`),
  creditScore: (id: string) => call<CreditScore>(`/cards/${id}/credit-score`),
  attestcoinHealth: () => call<AttestcoinHealth>("/attestcoin/health"),
  verifyPayment: (id: string, chargeId: string) =>
    call<{ queued: boolean; reason?: string; charge_id?: string; creditcoin_tx_hash?: string }>(
      `/cards/${id}/attestcoin-verify`,
      { method: "POST", body: JSON.stringify({ charge_id: chargeId }) },
    ),

  // --- OAuth consent (the /connect card-picker page) ---
  oauthRequest: (id: string) =>
    call<{
      request_id: string;
      client_name: string | null;
      redirect_host: string;
      scope: string | null;
      expires_at: number;
    }>(`/oauth/request?id=${encodeURIComponent(id)}`),
  oauthApprove: (requestId: string, cardId: string) =>
    call<{ redirect_to: string }>("/oauth/approve", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, card_id: cardId }),
    }),
  oauthDeny: (requestId: string) =>
    call<{ redirect_to: string }>("/oauth/deny", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId }),
    }),
  // --- credit lines ---
  creditLines: () => call<{ configured: boolean; as_lender: CreditLine[]; as_borrower: CreditLine[] }>("/credit-lines"),
  creditLine: (id: string) => call<CreditLineDetail>(`/credit-lines/${id}`),
  proposeCreditLine: (input: { funding_card_id: string; borrower_card_id?: string; borrower_address?: string; limit: string; interest_bps: number; expires_at: number }) =>
    call<CreditLineDetail>("/credit-lines", { method: "POST", body: JSON.stringify(input) }),
  signCreditLine: (id: string, party: "lender" | "borrower", signature: string) =>
    call<CreditLineDetail>(`/credit-lines/${id}/sign`, { method: "POST", body: JSON.stringify({ party, signature }) }),
  drawCredit: (id: string, input: { card_id: string; amount: string; memo?: string }) =>
    call<{ receipt: { status: string; tx: string | null }; charge_id: string; line: CreditLine }>(`/credit-lines/${id}/draw`, { method: "POST", body: JSON.stringify(input) }),
  repayCredit: (id: string, input: { card_id: string; amount: string }) =>
    call<{ receipt: { status: string; tx: string | null }; charge_id: string; line: CreditLine }>(`/credit-lines/${id}/repay`, { method: "POST", body: JSON.stringify(input) }),
  settleCreditLine: (id: string, action: "default" | "close") =>
    call<{ tx_hash: string; line: CreditLine }>(`/credit-lines/${id}/settle`, { method: "POST", body: JSON.stringify({ action }) }),

  // --- disputes ---
  disputes: (cardId: string) => call<{ configured: boolean; items: Dispute[] }>(`/cards/${cardId}/disputes`),
  openDispute: (cardId: string, charge_id: string, reason: string) =>
    call<Dispute>(`/cards/${cardId}/disputes`, { method: "POST", body: JSON.stringify({ charge_id, reason }) }),
  resolveDispute: (id: string, outcome: "upheld" | "rejected" | "withdrawn", note?: string) =>
    call<Dispute>(`/disputes/${id}/resolve`, { method: "POST", body: JSON.stringify({ outcome, note }) }),

  // --- passport, guarantees, facts ---
  passport: (cardId: string) => call<Passport>(`/cards/${cardId}/passport`),
  publicPassport: (address: string) => publicCall<Passport>(`/passport/${address}`),
  verifyPassport: (credential: { payload: Record<string, unknown>; signature: string }) =>
    publicCall<{ valid: boolean; signer: string | null; expired: boolean; reason?: string; expected_signer: string | null }>("/passport/verify", { method: "POST", body: JSON.stringify(credential) }),
  guarantee: (address: string) => call<{ configured: boolean; bonded_ctc: string | null; guarantors: Array<{ guarantor: string; bonded_ctc: string }> }>(`/guarantees/${address}`),
  attestcoinFacts: (cardId: string) => call<{ configured: boolean; items: Fact[] }>(`/cards/${cardId}/attestcoin-facts`),
  retryFact: (factId: string) => call<{ retried: boolean }>(`/attestcoin-facts/${factId}/retry`, { method: "POST", body: "{}" }),

  // --- webhooks, events, audit, alerts ---
  webhooks: () => call<{ configured: boolean; items: Webhook[]; event_types: string[] }>("/webhooks"),
  createWebhook: (input: { url: string; events: string[]; description?: string }) =>
    call<Webhook & { secret: string }>("/webhooks", { method: "POST", body: JSON.stringify(input) }),
  deleteWebhook: (id: string) => call<{ deleted: boolean }>(`/webhooks/${id}`, { method: "DELETE" }),
  pauseWebhook: (id: string, active: boolean) => call<Webhook>(`/webhooks/${id}/pause`, { method: "POST", body: JSON.stringify({ active }) }),
  testWebhook: (id: string) => call<{ delivery: Delivery }>(`/webhooks/${id}/test`, { method: "POST", body: "{}" }),
  deliveries: (id: string) => call<{ items: Delivery[] }>(`/webhooks/${id}/deliveries`),
  events: (q: { limit?: number; card_id?: string } = {}) =>
    call<{ configured: boolean; items: EventRow[] }>(`/events?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`),
  audit: (q: { card_id?: string; action?: string; limit?: number } = {}) =>
    call<{ configured: boolean; items: AuditEntry[] }>(`/audit?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()}`),
  auditCsv: async (q: { card_id?: string; action?: string } = {}): Promise<string> => {
    const token = await getAccessToken();
    const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(q).filter(([, v]) => v !== undefined) as [string, string][]), format: "csv" });
    const res = await fetch(`${BASE}/audit?${qs}`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.text();
  },
  alerts: (cardId: string) => call<{ threshold_pct: number }>(`/cards/${cardId}/alerts`),
  setAlerts: (cardId: string, threshold_pct: number) => call<{ threshold_pct: number }>(`/cards/${cardId}/alerts`, { method: "PUT", body: JSON.stringify({ threshold_pct }) }),

  // --- teams ---
  teams: () => call<{ configured: boolean; items: Team[] }>("/teams"),
  createTeam: (name: string) => call<Team>("/teams", { method: "POST", body: JSON.stringify({ name }) }),
  deleteTeam: (id: string) => call<{ deleted: boolean }>(`/teams/${id}`, { method: "DELETE" }),
  addMember: (id: string, address: string, role: TeamRole) => call<Team>(`/teams/${id}/members`, { method: "POST", body: JSON.stringify({ address, role }) }),
  removeMember: (id: string, userId: string) => call<{ removed: boolean }>(`/teams/${id}/members/${userId}`, { method: "DELETE" }),
  assignTeam: (cardId: string, teamId: string | null) => call<{ team: { team_id: string; name: string } | null }>(`/cards/${cardId}/team`, { method: "POST", body: JSON.stringify({ team_id: teamId }) }),
};
