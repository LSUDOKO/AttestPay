// Teams: several people operating one set of cards, with roles.
//
// A card still belongs to exactly one wallet (the delegator whose signature created
// it; only that wallet can revoke on-chain). A team is an ACCESS layer over cards:
// the owner assigns a card to a team, and members act on it according to their role.
//
//   viewer  read cards, charges, proofs, credit, disputes
//   member  + freeze / unfreeze, open disputes, draw and repay credit, alert settings
//   admin   + assign / unassign cards to the team, manage members below owner
//   owner   + everything, including deleting the team
//
// What a team can never do: issue a card, reveal or rotate its secret, or revoke it
// on-chain. Those need the owning wallet's signature or expose the card's bearer
// credential, and a role is not a key. Freeze is the team-level kill switch.
//
// Members are keyed by user id, which in the Privy lane is the wallet address
// lowercased — so a team can invite an address before it has ever signed in, and the
// membership attaches the moment it onboards.

import type { Database } from "bun:sqlite";

export type TeamRole = "owner" | "admin" | "member" | "viewer";
export const TEAM_ROLES: readonly TeamRole[] = ["owner", "admin", "member", "viewer"] as const;
export const ROLE_RANK: Record<TeamRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

/** What each access level needs, as a minimum role. */
export type AccessLevel = "read" | "control" | "manage";
export const ACCESS_MIN_ROLE: Record<AccessLevel, TeamRole> = { read: "viewer", control: "member", manage: "admin" };

export type TeamRow = { id: string; name: string; owner_user_id: string; created_at: number };
export type MemberRow = { team_id: string; user_id: string; role: TeamRole; added_by: string; created_at: number };
export type CardTeamRow = { card_id: string; team_id: string; assigned_by: string; created_at: number };

const newId = (): string => `team_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export class TeamStore {
  constructor(readonly db: Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_teams_owner ON teams(owner_user_id);
      CREATE TABLE IF NOT EXISTS team_members (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (team_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
      CREATE TABLE IF NOT EXISTS card_teams (
        card_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        assigned_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_card_teams_team ON card_teams(team_id);
    `);
  }

  createTeam(name: string, ownerUserId: string, now: number): TeamRow {
    const row: TeamRow = { id: newId(), name, owner_user_id: ownerUserId, created_at: now };
    const tx = this.db.transaction(() => {
      this.db.query(`INSERT INTO teams (id, name, owner_user_id, created_at) VALUES ($id, $n, $o, $now)`).run({ $id: row.id, $n: name, $o: ownerUserId, $now: now });
      this.db
        .query(`INSERT INTO team_members (team_id, user_id, role, added_by, created_at) VALUES ($t, $u, 'owner', $u, $now)`)
        .run({ $t: row.id, $u: ownerUserId, $now: now });
    });
    tx();
    return row;
  }

  getTeam(id: string): TeamRow | null {
    return (this.db.query(`SELECT * FROM teams WHERE id = $id`).get({ $id: id }) as TeamRow) ?? null;
  }

  renameTeam(id: string, name: string): void {
    this.db.query(`UPDATE teams SET name = $n WHERE id = $id`).run({ $n: name, $id: id });
  }

  deleteTeam(id: string): void {
    const tx = this.db.transaction(() => {
      this.db.query(`DELETE FROM card_teams WHERE team_id = $id`).run({ $id: id });
      this.db.query(`DELETE FROM team_members WHERE team_id = $id`).run({ $id: id });
      this.db.query(`DELETE FROM teams WHERE id = $id`).run({ $id: id });
    });
    tx();
  }

  /** Teams the user belongs to, with their role. */
  teamsOf(userId: string): Array<TeamRow & { role: TeamRole }> {
    return this.db
      .query(
        `SELECT t.*, m.role FROM teams t JOIN team_members m ON m.team_id = t.id WHERE m.user_id = $u ORDER BY t.created_at`,
      )
      .all({ $u: userId }) as Array<TeamRow & { role: TeamRole }>;
  }

  members(teamId: string): MemberRow[] {
    return this.db.query(`SELECT * FROM team_members WHERE team_id = $t ORDER BY created_at`).all({ $t: teamId }) as MemberRow[];
  }

  roleOf(teamId: string, userId: string): TeamRole | null {
    const r = this.db.query(`SELECT role FROM team_members WHERE team_id = $t AND user_id = $u`).get({ $t: teamId, $u: userId }) as { role: TeamRole } | null;
    return r?.role ?? null;
  }

  setMember(teamId: string, userId: string, role: TeamRole, addedBy: string, now: number): void {
    this.db
      .query(
        `INSERT INTO team_members (team_id, user_id, role, added_by, created_at) VALUES ($t, $u, $r, $by, $now)
         ON CONFLICT(team_id, user_id) DO UPDATE SET role = $r`,
      )
      .run({ $t: teamId, $u: userId, $r: role, $by: addedBy, $now: now });
  }

  removeMember(teamId: string, userId: string): void {
    this.db.query(`DELETE FROM team_members WHERE team_id = $t AND user_id = $u`).run({ $t: teamId, $u: userId });
  }

  assignCard(cardId: string, teamId: string, by: string, now: number): void {
    this.db
      .query(
        `INSERT INTO card_teams (card_id, team_id, assigned_by, created_at) VALUES ($c, $t, $by, $now)
         ON CONFLICT(card_id) DO UPDATE SET team_id = $t, assigned_by = $by, created_at = $now`,
      )
      .run({ $c: cardId, $t: teamId, $by: by, $now: now });
  }

  unassignCard(cardId: string): void {
    this.db.query(`DELETE FROM card_teams WHERE card_id = $c`).run({ $c: cardId });
  }

  teamOfCard(cardId: string): CardTeamRow | null {
    return (this.db.query(`SELECT * FROM card_teams WHERE card_id = $c`).get({ $c: cardId }) as CardTeamRow) ?? null;
  }

  teamCardIds(teamId: string): string[] {
    return (this.db.query(`SELECT card_id FROM card_teams WHERE team_id = $t ORDER BY created_at`).all({ $t: teamId }) as Array<{ card_id: string }>).map((r) => r.card_id);
  }

  /** The user's role on a card through team membership, or null. */
  roleOnCard(cardId: string, userId: string): TeamRole | null {
    const r = this.db
      .query(`SELECT m.role FROM card_teams ct JOIN team_members m ON m.team_id = ct.team_id WHERE ct.card_id = $c AND m.user_id = $u`)
      .get({ $c: cardId, $u: userId }) as { role: TeamRole } | null;
    return r?.role ?? null;
  }

  /** Every card the user can reach through a team, with the role and team. */
  teamCardsOf(userId: string): Array<{ card_id: string; team_id: string; team_name: string; role: TeamRole }> {
    return this.db
      .query(
        `SELECT ct.card_id, ct.team_id, t.name AS team_name, m.role
         FROM card_teams ct JOIN team_members m ON m.team_id = ct.team_id JOIN teams t ON t.id = ct.team_id
         WHERE m.user_id = $u ORDER BY ct.created_at`,
      )
      .all({ $u: userId }) as Array<{ card_id: string; team_id: string; team_name: string; role: TeamRole }>;
  }
}

/** Whether `role` satisfies `level`. */
export function roleAllows(role: TeamRole | null, level: AccessLevel): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[ACCESS_MIN_ROLE[level]];
}
