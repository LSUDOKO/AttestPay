// @attestpay/sdk — a typed client for the AttestPay API.
//
// One class, one `fetch`, no framework. Two things beyond the HTTP wrapper are
// included because every integrator needs them and getting them subtly wrong is
// easy: verifying a webhook signature, and verifying a credit-passport credential.
// Both are pure functions that work in Node, Bun, browsers and workers.
//
//   const ap = new AttestPay({ baseUrl: "https://api.example.com", token: PRIVY_OR_ADMIN_TOKEN });
//   const lines = await ap.credit.list();
//   await ap.credit.draw(lines.as_borrower[0].line_id, { card_id, amount: "4.00" });
//
// The ops token acts for a user by passing `userId`; a Privy access token is already
// bound to its wallet and `userId` is ignored server-side.

import { recoverMessageAddress, type Address, type Hex } from "viem";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A non-2xx answer. `code` is the typed refusal (over_period_limit, card_not_found,
 * ...) when the server sent one, so callers can branch without parsing messages. */
export class AttestPayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "AttestPayError";
  }
}

// ---------------------------------------------------------------------------
// Shapes (the server's JSON, named)
// ---------------------------------------------------------------------------

export type CardTerms = {
  pay?: { period?: { amount: string; seconds: number }; lifetime?: { amount: string } };
  contract?: { targets: string[]; selectors: string[]; tokens?: string[]; perTradeMax?: string };
  expiry?: number;
  maxUses?: number;
  perTxMax?: string;
  merchants?: string[];
  subcards?: boolean;
};

export type CardState = {
  card_id: string;
  name: string;
  status: string;
  terms: CardTerms;
  remaining_this_period: string | null;
  remaining_lifetime: string | null;
  period_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
  parent_card_id?: string | null;
  created_at?: number;
  team?: { team_id: string; name: string } | null;
  your_role?: TeamRole;
};

export type Charge = { id: string; kind: string; to: string | null; amount: string; fee: string; status: string; tx: string | null; memo: string | null; at: number };

export type CardDetail = CardState & { charges: Charge[]; k_agent_address: string };

export type Receipt = { status: "confirmed" | "pending" | "failed" | "settlement_unconfirmed"; tx: string | null; to: string; amount: string; fee: string; remaining_this_period: string | null; memo?: string };

export type ProofStatus = "pending" | "anchoring" | "anchored" | "attested" | "proving" | "verified" | "failed";

export type CreditLineStatus = "proposed" | "signed" | "opening" | "open" | "active" | "repaid" | "defaulted" | "closed" | "failed";

export type CreditLine = {
  line_id: Hex;
  status: CreditLineStatus;
  lender: Address;
  borrower: Address;
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
  updated_at: string | null;
};

export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: "CreditLine";
  message: Record<string, string>;
};

export type CreditLineDetail = CreditLine & {
  typed_data: TypedData | null;
  events: Array<{ kind: "draw" | "repayment"; charge_id: string; amount: string; charge_status: string | null; tx_hash: string | null; explorer: string | null; at: string | null }>;
  facts: Fact[];
  on_chain: Record<string, unknown> | null;
  on_chain_error: string | null;
};

export type Fact = {
  fact_id: string;
  kind: "draw" | "repayment" | "dispute_opened" | "dispute_resolved" | "card_revoked";
  ref_id: string;
  status: ProofStatus;
  target: "credit_line" | "ledger";
  anchor_tx_hash: string | null;
  anchor_height: number | null;
  creditcoin_tx_hash: string | null;
  creditcoin_explorer: string | null;
  verified_at: string | null;
  error: string | null;
  attempts: number;
  created_at: string | null;
};

export type CreditExec = { receipt: Receipt; charge_id: string; fact_id: string | null; line: CreditLine };

export type DisputeStatus = "open" | "upheld" | "rejected" | "withdrawn";

export type Dispute = {
  dispute_id: string;
  charge_id: string;
  card_id: string;
  status: DisputeStatus;
  reason: string;
  resolution_note: string | null;
  opened_by: string;
  resolved_by: string | null;
  opened_at: string | null;
  resolved_at: string | null;
  facts: Fact[];
};

export type PassportJson = {
  account: Address;
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

export type PassportCredentialPayload = {
  type: "AttestPayCreditPassport";
  version: "1";
  issuer: string;
  chain_id: number;
  passport_contract: Address;
  issued_at: string;
  expires_at: string;
  passport: PassportJson;
};

export type PassportCredential = { payload: PassportCredentialPayload; signature: Hex; signer: Address; verification: string };

export type Passport = {
  configured: boolean;
  source?: string;
  account: Address;
  passport?: PassportJson;
  credential?: PassportCredential | null;
  local?: { credit_lines: CreditLine[]; disputes: Dispute[] } | null;
  note?: string;
  reason?: string;
};

export type Webhook = { webhook_id: string; url: string; events: string[]; description: string | null; active: boolean; created_at: string | null; updated_at: string | null };
export type Delivery = { delivery_id: string; event_id: string; event_type: string; status: "pending" | "delivered" | "failed" | "dead"; attempts: number; next_attempt_at: string | null; last_status_code: number | null; last_error: string | null; created_at: string | null; delivered_at: string | null };
export type EventRow = { id: string; type: string; user_id: string | null; card_id: string | null; data: Record<string, unknown>; created_at: string };
export type AuditEntry = { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> | null; ip: string | null };

export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type Team = {
  team_id: string;
  name: string;
  owner: string;
  your_role: TeamRole;
  members: Array<{ user_id: string; role: TeamRole; added_by: string; since: string }>;
  cards: Array<{ card_id: string; name: string | null; status: string | null; owner: string | null }>;
  created_at: string;
};

export type AttestcoinHealth = {
  configured: boolean;
  chainKey: number | null;
  chainKeySource: "env" | "registry" | null;
  supportedChains: Array<{ chainKey: number; chainId: number; name: string; encoding: number }> | null;
  paymentChainId: number | null;
  paymentChainAttested: boolean | null;
  latestAttestedHeight: number | null;
  sourceHead: number | null;
  attestationLagBlocks: number | null;
  queue: Record<ProofStatus, number>;
  factQueue: Record<ProofStatus, number>;
  features: { credit: boolean; disputes: boolean; guarantee: boolean; passport: boolean };
  contracts: Record<string, string | null>;
  error?: string;
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type AttestPayOptions = {
  /** e.g. https://api.example.com (the server root, not /api) */
  baseUrl: string;
  /** A Privy access token or the ops token; a function is called per request (token refresh). */
  token: string | (() => Promise<string> | string);
  /** With the ops token: the user to act as. Ignored on a Privy token. */
  userId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class AttestPay {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AttestPayOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async token(): Promise<string> {
    return typeof this.opts.token === "function" ? await this.opts.token() : this.opts.token;
  }

  /** The request core: JSON in, JSON out, typed refusals as AttestPayError. */
  async call<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; public?: boolean } = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    // Ops-token acting-as: userId rides the query for reads and deletes, the body otherwise.
    let payload = body;
    if (this.opts.userId) {
      if (method === "GET" || method === "DELETE") url.searchParams.set("userId", this.opts.userId);
      else payload = { userId: this.opts.userId, ...((body as Record<string, unknown>) ?? {}) };
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (!opts.public) headers.authorization = `Bearer ${await this.token()}`;
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await this.f(url, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (opts.raw) {
      if (!res.ok) throw new AttestPayError(res.status, await res.text());
      return (await res.text()) as unknown as T;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new AttestPayError(res.status, "malformed response body");
    }
    if (!res.ok) {
      const j = (json ?? {}) as { code?: string; message?: string; error?: string; detail?: Record<string, unknown> };
      throw new AttestPayError(res.status, j.message ?? j.error ?? `http ${res.status}`, j.code ?? null, j.detail ?? null);
    }
    return json as T;
  }

  private get = <T>(path: string) => this.call<T>("GET", path);
  private post = <T>(path: string, body: unknown = {}) => this.call<T>("POST", path, body);
  private put = <T>(path: string, body: unknown) => this.call<T>("PUT", path, body);
  private patch = <T>(path: string, body: unknown) => this.call<T>("PATCH", path, body);
  private del = <T>(path: string) => this.call<T>("DELETE", path);

  // ---- cards ----
  readonly cards = {
    list: () => this.get<CardState[]>("/api/cards"),
    get: (id: string) => this.get<CardDetail>(`/api/cards/${id}`),
    tree: () => this.get<{ tree: Array<{ card: CardState; children: unknown[] }> }>("/api/tree"),
    url: (id: string) => this.get<{ card_url: string }>(`/api/cards/${id}/url`),
    rotate: (id: string) => this.post<{ card_url: string }>(`/api/cards/${id}/rotate`),
    freeze: (id: string) => this.post<{ status: string }>(`/api/cards/${id}/freeze`),
    unfreeze: (id: string) => this.post<{ status: string }>(`/api/cards/${id}/unfreeze`),
    delete: (id: string) => this.del<{ deleted: boolean; removed: number }>(`/api/cards/${id}`),
    /** Ops lane only: server-signed issuance. */
    issue: (name: string, terms: CardTerms) => this.post<{ card_id: string; card_url: string; terms: CardTerms }>("/api/cards", { name, terms }),
    assignTeam: (id: string, teamId: string | null) => this.post<{ card_id: string; team: { team_id: string; name: string } | null }>(`/api/cards/${id}/team`, { team_id: teamId }),
  };

  // ---- cross-chain ----
  readonly attestcoin = {
    health: () => this.get<AttestcoinHealth>("/api/attestcoin/health"),
    stats: () => this.get<Record<string, unknown>>("/api/attestcoin/stats"),
    proofs: (cardId: string) => this.get<{ configured: boolean; items: Array<Record<string, unknown>>; stats: Record<string, unknown> | null }>(`/api/cards/${cardId}/attestcoin-proofs`),
    verify: (cardId: string, chargeId: string) => this.post<{ queued: boolean; reason?: string }>(`/api/cards/${cardId}/attestcoin-verify`, { charge_id: chargeId }),
    creditScore: (cardId: string) => this.get<Record<string, unknown>>(`/api/cards/${cardId}/credit-score`),
    facts: (cardId: string) => this.get<{ configured: boolean; items: Fact[] }>(`/api/cards/${cardId}/attestcoin-facts`),
    retryFact: (factId: string) => this.post<{ retried: boolean }>(`/api/attestcoin-facts/${factId}/retry`),
  };

  // ---- credit lines ----
  readonly credit = {
    propose: (input: { funding_card_id: string; borrower_card_id?: string; borrower_address?: Address; limit: string; interest_bps: number; expires_at: number }) =>
      this.post<CreditLineDetail>("/api/credit-lines", input),
    list: () => this.get<{ configured: boolean; as_lender: CreditLine[]; as_borrower: CreditLine[] }>("/api/credit-lines"),
    get: (id: string) => this.get<CreditLineDetail>(`/api/credit-lines/${id}`),
    sign: (id: string, party: "lender" | "borrower", signature: Hex) => this.post<CreditLineDetail>(`/api/credit-lines/${id}/sign`, { party, signature }),
    draw: (id: string, input: { card_id: string; amount: string; memo?: string; idempotency_key?: string }) => this.post<CreditExec>(`/api/credit-lines/${id}/draw`, input),
    repay: (id: string, input: { card_id: string; amount: string; memo?: string; idempotency_key?: string }) => this.post<CreditExec>(`/api/credit-lines/${id}/repay`, input),
    settle: (id: string, action: "default" | "close") => this.post<{ tx_hash: string; explorer: string; line: CreditLine }>(`/api/credit-lines/${id}/settle`, { action }),
    slash: (id: string) => this.post<{ tx_hash: string; explorer: string }>(`/api/credit-lines/${id}/slash`),
  };

  // ---- disputes ----
  readonly disputes = {
    open: (cardId: string, input: { charge_id: string; reason: string }) => this.post<Dispute>(`/api/cards/${cardId}/disputes`, input),
    forCard: (cardId: string) => this.get<{ configured: boolean; items: Dispute[] }>(`/api/cards/${cardId}/disputes`),
    list: (status?: DisputeStatus) => this.get<{ configured: boolean; items: Dispute[] }>(`/api/disputes${status ? `?status=${status}` : ""}`),
    resolve: (id: string, outcome: Exclude<DisputeStatus, "open">, note?: string) => this.post<Dispute>(`/api/disputes/${id}/resolve`, { outcome, note }),
  };

  // ---- passport + guarantees ----
  readonly passport = {
    /** Public: no token needed. */
    get: (address: Address) => this.call<Passport>("GET", `/passport/${address}`, undefined, { public: true }),
    forCard: (cardId: string) => this.get<Passport>(`/api/cards/${cardId}/passport`),
    /** Public: the server checks the signature against its anchorer. */
    verifyRemote: (credential: { payload: PassportCredentialPayload; signature: Hex }) =>
      this.call<{ valid: boolean; signer: Address | null; expired: boolean; reason?: string; expected_signer: Address | null }>("POST", "/passport/verify", credential, { public: true }),
    /** Local: pure signature + expiry check, no network. */
    verify: verifyPassportCredential,
  };

  readonly guarantees = {
    get: (address: Address) => this.get<{ configured: boolean; address: Address; bonded_ctc: string | null; guarantors: Array<{ guarantor: Address; bonded_ctc: string; unbond_requested_at: string | null }> }>(`/api/guarantees/${address}`),
    /** Ops lane only: bond from the server's anchorer key. */
    bond: (borrower: Address, amountCtc: string) => this.post<{ tx_hash: string; explorer: string; bonded_ctc: string }>("/api/guarantees/bond", { borrower, amount_ctc: amountCtc }),
  };

  // ---- webhooks, events, audit, alerts ----
  readonly webhooks = {
    create: (input: { url: string; events?: string[]; description?: string }) => this.post<Webhook & { secret: string }>("/api/webhooks", input),
    list: () => this.get<{ configured: boolean; items: Webhook[]; event_types: readonly string[] }>("/api/webhooks"),
    delete: (id: string) => this.del<{ deleted: boolean }>(`/api/webhooks/${id}`),
    pause: (id: string, active: boolean) => this.post<Webhook>(`/api/webhooks/${id}/pause`, { active }),
    test: (id: string) => this.post<{ delivery: Delivery; result: Record<string, number> }>(`/api/webhooks/${id}/test`),
    deliveries: (id: string) => this.get<{ items: Delivery[] }>(`/api/webhooks/${id}/deliveries`),
    retry: (id: string, deliveryId: string) => this.post<{ retried: boolean; delivery: Delivery }>(`/api/webhooks/${id}/deliveries/${deliveryId}/retry`),
    /** Verify an incoming delivery's signature header. */
    verify: verifyWebhookSignature,
  };

  readonly events = {
    list: (q: { limit?: number; card_id?: string } = {}) => this.get<{ configured: boolean; items: EventRow[] }>(`/api/events${query(q)}`),
  };

  readonly audit = {
    list: (q: { from?: number; to?: number; card_id?: string; action?: string; limit?: number; all?: boolean } = {}) =>
      this.get<{ configured: boolean; items: AuditEntry[] }>(`/api/audit${query({ ...q, all: q.all ? "1" : undefined })}`),
    csv: (q: { from?: number; to?: number; card_id?: string; action?: string; limit?: number; all?: boolean } = {}) =>
      this.call<string>("GET", `/api/audit${query({ ...q, all: q.all ? "1" : undefined, format: "csv" })}`, undefined, { raw: true }),
  };

  readonly alerts = {
    get: (cardId: string) => this.get<{ card_id: string; threshold_pct: number }>(`/api/cards/${cardId}/alerts`),
    set: (cardId: string, thresholdPct: number) => this.put<{ card_id: string; threshold_pct: number }>(`/api/cards/${cardId}/alerts`, { threshold_pct: thresholdPct }),
  };

  // ---- teams ----
  readonly teams = {
    create: (name: string) => this.post<Team>("/api/teams", { name }),
    list: () => this.get<{ configured: boolean; items: Team[] }>("/api/teams"),
    get: (id: string) => this.get<Team>(`/api/teams/${id}`),
    rename: (id: string, name: string) => this.patch<Team>(`/api/teams/${id}`, { name }),
    delete: (id: string) => this.del<{ deleted: boolean }>(`/api/teams/${id}`),
    addMember: (id: string, input: { address?: Address; user_id?: string; role?: TeamRole }) => this.post<Team>(`/api/teams/${id}/members`, input),
    removeMember: (id: string, userId: string) => this.del<{ removed: boolean }>(`/api/teams/${id}/members/${userId}`),
  };
}

function query(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Webhook signatures (WebCrypto, so it runs anywhere)
// ---------------------------------------------------------------------------

/** Verifies `X-AttestPay-Signature: t=<unix>,v1=<hex>` over the raw request body. */
export async function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Passport credentials
// ---------------------------------------------------------------------------

/** Key-sorted JSON: the canonical form the credential is signed over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export type CredentialCheck = { valid: boolean; signer: Address | null; expired: boolean; reason?: string };

/** Verifies a credit-passport credential locally: EIP-191 signature over the
 * canonical payload, optional expected signer (the AttestPay anchorer), expiry. */
export async function verifyPassportCredential(
  cred: { payload: PassportCredentialPayload; signature: Hex },
  opts: { expectedSigner?: Address; now?: number } = {},
): Promise<CredentialCheck> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  let signer: Address;
  try {
    signer = await recoverMessageAddress({ message: canonicalJson(cred.payload), signature: cred.signature });
  } catch {
    return { valid: false, signer: null, expired: false, reason: "signature is malformed" };
  }
  const expired = Date.parse(cred.payload.expires_at) / 1000 < now;
  if (opts.expectedSigner && signer.toLowerCase() !== opts.expectedSigner.toLowerCase()) {
    return { valid: false, signer, expired, reason: `signed by ${signer}, expected ${opts.expectedSigner}` };
  }
  if (cred.payload.type !== "AttestPayCreditPassport") return { valid: false, signer, expired, reason: `unexpected type ${cred.payload.type}` };
  if (expired) return { valid: false, signer, expired, reason: "credential has expired" };
  return { valid: true, signer, expired: false };
}
