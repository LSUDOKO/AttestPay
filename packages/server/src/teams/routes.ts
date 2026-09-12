// Dashboard REST surface for teams. Mounted under /api. Card-side access (what a
// role lets a member do to a card) is enforced by the parent router's card resolver;
// this file owns team membership and card assignment.

import { Hono } from "hono";
import type { Context } from "hono";
import { isAddress } from "viem";
import { RefusalError, type CardRow } from "@attestpay/engine";
import type { ApiEnv } from "../api/routes";
import type { AppDeps } from "../deps";
import type { Actor } from "../attestcoin/credit-routes";
import { ROLE_RANK, TEAM_ROLES, type TeamRole, type TeamRow } from "./store";

export type OwnedCardResolver = (c: Context<ApiEnv>, id: string, level?: "read" | "control" | "manage") => CardRow;
export type Handle = (c: Context<ApiEnv>, fn: () => Promise<unknown>) => Promise<Response>;
export type ActorResolver = (c: Context<ApiEnv>, requestedUserId?: string) => Actor;

const actorId = (a: Actor): string => (a.kind === "admin" ? a.userId : a.user.id);
const auditActor = (a: Actor): { kind: "admin" | "user"; id: string } =>
  a.kind === "admin" ? { kind: "admin", id: `admin:${a.userId}` } : { kind: "user", id: a.user.id };
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** Member ids are user ids; in the Privy lane that is the wallet address lowercased. */
export const memberIdFrom = (addressOrId: string): string => (/^0x[0-9a-fA-F]{40}$/.test(addressOrId) ? addressOrId.toLowerCase() : addressOrId);

export function teamRoutes(deps: AppDeps, ownedCard: OwnedCardResolver, handle: Handle, actor: ActorResolver): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const now = () => Math.floor(Date.now() / 1000);
  const teams = () => {
    if (!deps.teams) throw new RefusalError("invalid_terms", "teams are not enabled on this deployment");
    return deps.teams;
  };

  /** The team and the actor's role on it, or not-found for non-members. */
  const memberOf = (a: Actor, teamId: string): { team: TeamRow; role: TeamRole } => {
    const t = teams().getTeam(teamId);
    const role = t ? teams().roleOf(teamId, actorId(a)) : null;
    if (!t || !role) throw new RefusalError("card_not_found", "no such team");
    return { team: t, role };
  };

  const requireRole = (role: TeamRole, min: TeamRole, what: string): void => {
    if (ROLE_RANK[role] < ROLE_RANK[min]) throw new RefusalError("not_your_subcard", `${what} needs the ${min} role (you are ${role})`);
  };

  const teamView = (t: TeamRow, role: TeamRole) => {
    const ts = teams();
    return {
      team_id: t.id,
      name: t.name,
      owner: t.owner_user_id,
      your_role: role,
      members: ts.members(t.id).map((m) => ({ user_id: m.user_id, role: m.role, added_by: m.added_by, since: iso(m.created_at) })),
      cards: ts.teamCardIds(t.id).map((id) => {
        const card = deps.store.getCard(id);
        return { card_id: id, name: card?.name ?? null, status: card?.status ?? null, owner: card?.user_id ?? null };
      }),
      created_at: iso(t.created_at),
    };
  };

  app.post("/teams", (c) =>
    handle(c, async () => {
      const ts = teams();
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; userId?: string };
      const a = actor(c, body.userId);
      const name = body.name?.trim();
      if (!name || name.length > 80) throw new RefusalError("invalid_terms", "name is required (max 80 chars)");
      if (ts.teamsOf(actorId(a)).filter((t) => t.owner_user_id === actorId(a)).length >= 20) {
        throw new RefusalError("invalid_terms", "at most 20 teams per owner");
      }
      const t = ts.createTeam(name, actorId(a), now());
      deps.events?.audit(auditActor(a), "team.created", { type: "team", id: t.id }, { name });
      return teamView(t, "owner");
    }),
  );

  app.get("/teams", (c) =>
    handle(c, async () => {
      if (!deps.teams) return { configured: false, items: [] };
      const a = actor(c, c.req.query("userId"));
      return { configured: true, items: deps.teams.teamsOf(actorId(a)).map((t) => teamView(t, t.role)) };
    }),
  );

  app.get("/teams/:id", (c) =>
    handle(c, async () => {
      const a = actor(c, c.req.query("userId"));
      const { team, role } = memberOf(a, c.req.param("id"));
      return teamView(team, role);
    }),
  );

  app.patch("/teams/:id", (c) =>
    handle(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { name?: string; userId?: string };
      const a = actor(c, body.userId);
      const { team, role } = memberOf(a, c.req.param("id"));
      requireRole(role, "owner", "renaming a team");
      const name = body.name?.trim();
      if (!name || name.length > 80) throw new RefusalError("invalid_terms", "name is required (max 80 chars)");
      teams().renameTeam(team.id, name);
      deps.events?.audit(auditActor(a), "team.renamed", { type: "team", id: team.id }, { name });
      return teamView(teams().getTeam(team.id)!, role);
    }),
  );

  app.delete("/teams/:id", (c) =>
    handle(c, async () => {
      const a = actor(c, c.req.query("userId"));
      const { team, role } = memberOf(a, c.req.param("id"));
      requireRole(role, "owner", "deleting a team");
      teams().deleteTeam(team.id);
      deps.events?.audit(auditActor(a), "team.deleted", { type: "team", id: team.id });
      return { deleted: true };
    }),
  );

  // ---- members ----

  app.post("/teams/:id/members", (c) =>
    handle(c, async () => {
      const body = (await c.req.json().catch(() => ({}))) as { address?: string; user_id?: string; role?: string; userId?: string };
      const a = actor(c, body.userId);
      const { team, role } = memberOf(a, c.req.param("id"));
      requireRole(role, "admin", "adding members");
      const target = body.user_id ?? (body.address && isAddress(body.address) ? memberIdFrom(body.address) : null);
      if (!target) throw new RefusalError("invalid_terms", "address (a wallet) or user_id is required");
      const newRole = (body.role ?? "member") as TeamRole;
      if (!TEAM_ROLES.includes(newRole)) throw new RefusalError("invalid_terms", `role must be one of ${TEAM_ROLES.join(", ")}`);
      // Nobody grants a role above their own, and the owner seat is not grantable.
      if (newRole === "owner") throw new RefusalError("not_your_subcard", "the owner seat cannot be granted; transfer is not supported");
      if (ROLE_RANK[newRole] > ROLE_RANK[role]) throw new RefusalError("not_your_subcard", `you cannot grant ${newRole} as ${role}`);
      if (target === team.owner_user_id) throw new RefusalError("invalid_terms", "the owner already has the owner role");
      const existing = teams().roleOf(team.id, target);
      if (existing && ROLE_RANK[existing] > ROLE_RANK[role]) throw new RefusalError("not_your_subcard", `cannot change a ${existing}'s role as ${role}`);
      teams().setMember(team.id, target, newRole, actorId(a), now());
      deps.events?.audit(auditActor(a), "team.member_set", { type: "team", id: team.id }, { user_id: target, role: newRole });
      return teamView(team, role);
    }),
  );

  app.delete("/teams/:id/members/:userId", (c) =>
    handle(c, async () => {
      const a = actor(c, c.req.query("userId"));
      const { team, role } = memberOf(a, c.req.param("id"));
      const target = memberIdFrom(c.req.param("userId"));
      if (target === team.owner_user_id) throw new RefusalError("invalid_terms", "the owner cannot be removed; delete the team instead");
      const leaving = target === actorId(a);
      if (!leaving) {
        requireRole(role, "admin", "removing members");
        const theirs = teams().roleOf(team.id, target);
        if (!theirs) throw new RefusalError("card_not_found", "not a member");
        if (ROLE_RANK[theirs] > ROLE_RANK[role]) throw new RefusalError("not_your_subcard", `cannot remove a ${theirs} as ${role}`);
      }
      teams().removeMember(team.id, target);
      deps.events?.audit(auditActor(a), leaving ? "team.left" : "team.member_removed", { type: "team", id: team.id }, { user_id: target });
      return { removed: true };
    }),
  );

  // ---- card assignment ----

  /** Assigns (or, with team_id null, unassigns) a card. The card's OWNER decides;
   * they must also be at least admin on the receiving team. */
  app.post("/cards/:id/team", (c) =>
    handle(c, async () => {
      const ts = teams();
      const body = (await c.req.json().catch(() => ({}))) as { team_id?: string | null; userId?: string };
      const a = actor(c, body.userId);
      const card = ownedCard(c, c.req.param("id"), "manage");
      if (a.kind === "privy" && card.user_id !== a.user.id) throw new RefusalError("not_your_subcard", "only the card's owner may move it between teams");
      if (body.team_id === null || body.team_id === undefined) {
        ts.unassignCard(card.id);
        deps.events?.audit(auditActor(a), "card.team_unassigned", { type: "card", id: card.id });
        return { card_id: card.id, team: null };
      }
      const { team, role } = memberOf(a, body.team_id);
      requireRole(role, "admin", "assigning cards to a team");
      ts.assignCard(card.id, team.id, actorId(a), now());
      deps.events?.audit(auditActor(a), "card.team_assigned", { type: "card", id: card.id }, { team_id: team.id });
      return { card_id: card.id, team: { team_id: team.id, name: team.name } };
    }),
  );

  return app;
}
