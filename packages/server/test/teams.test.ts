// Teams and roles through the REAL app, on the Privy lane (the lane where scoping
// actually bites). Privy verification is faked: the bearer token IS the DID, so each
// user gets a distinct session without a real Privy round-trip.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { KeyedMutex, Store, issueRootCard, type Relayer } from "@attestpay/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { EventBus } from "../src/events/bus";
import { EventStore } from "../src/events/store";
import { TeamStore, roleAllows } from "../src/teams/store";

const owner = privateKeyToAccount(generatePrivateKey());
const alice = privateKeyToAccount(generatePrivateKey());
const bob = privateKeyToAccount(generatePrivateKey());
const OWNER_ID = owner.address.toLowerCase();
const ALICE_ID = alice.address.toLowerCase();
const BOB_ID = bob.address.toLowerCase();

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let teams: TeamStore;
let cardId: string;

const fakeRelayer = {
  getFeeData: async () => ({ minFee: "0.01", rate: 1, gasPrice: "1", expiry: 0, feeCollector: "0xE936e8FAf4A5655469182A49a505055B71C17604", targetAddress: "0x26a529124f0bbf9af9d8f9f84a43efe47cf1199a", context: "ctx" }),
  estimate: async () => ({ success: true, requiredPaymentAmount: "10000", context: "ctx", error: null, raw: null }),
  send: async () => "0xreq",
  getStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null }),
  waitForStatus: async () => ({ status: 200, txHash: "0xfaketx", raw: null, timedOut: false }),
};

beforeAll(async () => {
  process.env.ATTESTPAY_MASTER_KEY = "a".repeat(64);
  process.env.ATTESTPAY_RPC_URL = "http://127.0.0.1:1";
  store = new Store(":memory:");
  teams = new TeamStore(store.db);
  const deps: AppDeps = {
    store,
    relayer: fakeRelayer as unknown as Relayer,
    userSigner: null,
    adminToken: null,
    // The bearer token is `did:<user id>`; every known DID verifies.
    verifyPrivyToken: async (token: string) => (token.startsWith("did:") ? { did: token } : null),
    spendMutex: new KeyedMutex(),
    spendOverrides: { codeCheck: async () => true, confirmViaChain: false, feeJitter: (b) => b },
    events: new EventBus(new EventStore(store.db), store),
    teams,
  };
  for (const [id, acct] of [
    [OWNER_ID, owner],
    [ALICE_ID, alice],
    [BOB_ID, bob],
  ] as const) {
    store.upsertUser({ id, address: acct.address, privyDid: `did:${id}` });
  }
  const issued = await issueRootCard(
    { store, userSigner: owner, revocationNonceOverride: 0n },
    { userId: OWNER_ID, name: "shared card", terms: { pay: { period: { amount: "10.00", seconds: 604800 } } } },
  );
  cardId = issued.cardId;
  server = Bun.serve({ port: 0, fetch: createApp(deps).fetch });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  store?.close();
});

const as = (userId: string) => (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer did:${userId}`, "content-type": "application/json", ...(init.headers ?? {}) } });
const post = (userId: string, path: string, body: unknown) => as(userId)(path, { method: "POST", body: JSON.stringify(body) });

// ---------------------------------------------------------------------------

describe("role arithmetic", () => {
  test("roleAllows follows the ladder", () => {
    expect(roleAllows("viewer", "read")).toBe(true);
    expect(roleAllows("viewer", "control")).toBe(false);
    expect(roleAllows("member", "control")).toBe(true);
    expect(roleAllows("member", "manage")).toBe(false);
    expect(roleAllows("admin", "manage")).toBe(true);
    expect(roleAllows("owner", "manage")).toBe(true);
    expect(roleAllows(null, "read")).toBe(false);
  });
});

describe("teams over the API", () => {
  let teamId: string;

  test("a stranger cannot see the owner's card", async () => {
    expect((await as(ALICE_ID)(`/api/cards/${cardId}`)).status).toBe(422);
    const list = (await (await as(ALICE_ID)("/api/cards")).json()) as unknown[];
    expect(list).toHaveLength(0);
  });

  test("owner creates a team and invites alice (viewer) and bob (member) by address", async () => {
    const r = await post(OWNER_ID, "/api/teams", { name: "ops" });
    expect(r.status).toBe(200);
    const t = (await r.json()) as { team_id: string; your_role: string; members: Array<{ user_id: string; role: string }> };
    teamId = t.team_id;
    expect(t.your_role).toBe("owner");
    expect(t.members).toEqual([expect.objectContaining({ user_id: OWNER_ID, role: "owner" })]);

    expect((await post(OWNER_ID, `/api/teams/${teamId}/members`, { address: alice.address, role: "viewer" })).status).toBe(200);
    expect((await post(OWNER_ID, `/api/teams/${teamId}/members`, { address: bob.address, role: "member" })).status).toBe(200);
    // The owner seat is not grantable; nobody grants above themselves.
    expect((await post(OWNER_ID, `/api/teams/${teamId}/members`, { address: bob.address, role: "owner" })).status).toBe(422);

    const mine = (await (await as(ALICE_ID)("/api/teams")).json()) as { items: Array<{ team_id: string; your_role: string }> };
    expect(mine.items).toEqual([expect.objectContaining({ team_id: teamId, your_role: "viewer" })]);
  });

  test("assigning the card makes it visible with the member's role", async () => {
    // Only the card's owner assigns, and must be admin+ on the team.
    expect((await post(BOB_ID, `/api/cards/${cardId}/team`, { team_id: teamId })).status).toBe(422);
    expect((await post(OWNER_ID, `/api/cards/${cardId}/team`, { team_id: teamId })).status).toBe(200);

    const alicesView = (await (await as(ALICE_ID)(`/api/cards/${cardId}`)).json()) as { name: string; your_role: string; team: { team_id: string } };
    expect(alicesView.name).toBe("shared card");
    expect(alicesView.your_role).toBe("viewer");
    expect(alicesView.team.team_id).toBe(teamId);

    const list = (await (await as(BOB_ID)("/api/cards")).json()) as Array<{ card_id: string; your_role: string; team: { name: string } }>;
    expect(list).toEqual([expect.objectContaining({ card_id: cardId, your_role: "member", team: { team_id: teamId, name: "ops" } })]);

    const ownersList = (await (await as(OWNER_ID)("/api/cards")).json()) as Array<{ card_id: string; your_role: string }>;
    expect(ownersList).toHaveLength(1);
    expect(ownersList[0]!.your_role).toBe("owner");
  });

  test("a viewer reads but cannot control; a member controls but cannot manage", async () => {
    // read
    expect((await as(ALICE_ID)(`/api/cards/${cardId}/attestcoin-proofs`)).status).toBe(200);
    expect((await as(ALICE_ID)(`/api/cards/${cardId}/alerts`)).status).toBe(200);
    // control: freeze
    expect((await post(ALICE_ID, `/api/cards/${cardId}/freeze`, {})).status).toBe(422);
    expect((await post(BOB_ID, `/api/cards/${cardId}/freeze`, {})).status).toBe(200);
    expect(store.getCard(cardId)!.status).toBe("frozen");
    expect((await post(BOB_ID, `/api/cards/${cardId}/unfreeze`, {})).status).toBe(200);
    // manage: the card URL (the bearer secret) is owner-only, whatever the role
    expect((await as(BOB_ID)(`/api/cards/${cardId}/url`)).status).toBe(422);
    expect((await as(ALICE_ID)(`/api/cards/${cardId}/url`)).status).toBe(422);
    expect((await as(OWNER_ID)(`/api/cards/${cardId}/url`)).status).toBe(200);
    // rotate too
    expect((await post(BOB_ID, `/api/cards/${cardId}/rotate`, {})).status).toBe(422);
  });

  test("the audit log names the acting member", async () => {
    const audit = (await (await as(OWNER_ID)(`/api/audit?card_id=${cardId}`)).json()) as { items: Array<{ action: string; actor: string }> };
    expect(audit.items.some((a) => a.action === "card.frozen" && a.actor === `user:${BOB_ID}`)).toBe(true);
    expect(audit.items.some((a) => a.action === "card.team_assigned")).toBe(true);
  });

  test("membership management respects the ladder", async () => {
    // A member cannot add members; an admin can, but not above admin.
    expect((await post(BOB_ID, `/api/teams/${teamId}/members`, { address: alice.address, role: "member" })).status).toBe(422);
    expect((await post(OWNER_ID, `/api/teams/${teamId}/members`, { address: bob.address, role: "admin" })).status).toBe(200);
    expect((await post(BOB_ID, `/api/teams/${teamId}/members`, { address: alice.address, role: "member" })).status).toBe(200);
    expect(teams.roleOf(teamId, ALICE_ID)).toBe("member");
    // An admin cannot remove the owner, and cannot demote... well, remove another admin? (no: equal rank ok)
    expect((await as(BOB_ID)(`/api/teams/${teamId}/members/${OWNER_ID}`, { method: "DELETE" })).status).toBe(422);
    // A member can leave on their own.
    expect((await as(ALICE_ID)(`/api/teams/${teamId}/members/${ALICE_ID}`, { method: "DELETE" })).status).toBe(200);
    expect(teams.roleOf(teamId, ALICE_ID)).toBeNull();
    expect((await as(ALICE_ID)(`/api/cards/${cardId}`)).status).toBe(422);
  });

  test("unassigning and deleting", async () => {
    expect((await post(OWNER_ID, `/api/cards/${cardId}/team`, { team_id: null })).status).toBe(200);
    expect((await as(BOB_ID)(`/api/cards/${cardId}`)).status).toBe(422);
    // Only the owner deletes the team.
    expect((await as(BOB_ID)(`/api/teams/${teamId}`, { method: "DELETE" })).status).toBe(422);
    expect((await as(OWNER_ID)(`/api/teams/${teamId}`, { method: "DELETE" })).status).toBe(200);
    expect(teams.getTeam(teamId)).toBeNull();
    expect((await as(BOB_ID)(`/api/teams/${teamId}`)).status).toBe(422);
  });
});
