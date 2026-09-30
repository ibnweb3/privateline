// The off-ledger database (SQLite, built into Node). It holds what must never go on a ledger:
// the link between a phone number (encrypted) and an account, the PIN hash, verification codes,
// sessions, pending SMS confirmations, alert subscriptions and a short activity log.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export interface User {
  id: string;
  email: string;
  phone_lookup: string;
  phone_enc: string;
  phone_tag: string;
  pin_hash: string;
  party: string;
  account_id: string;
  created_at: number;
  pin_failures: number;
  pin_locked_until: number;
  /** 1 after the user texts LOCK; only the website (email sign-in) unlocks. */
  locked: number;
}

export interface Pending {
  user_id: string;
  kind: string;
  payload: string;
  expires_at: number;
}

export interface Alert {
  user_id: string;
  symbol: string;
  pct: number;
  base_price: number;
}

export interface PhoneChange {
  user_id: string;
  proposal_cid: string;
  new_phone_enc: string;
  new_phone_lookup: string;
  new_phone_tag: string;
  ready_at: number;
}

const SCHEMA = `
create table if not exists users (
  id text primary key,
  email text not null unique,
  phone_lookup text not null unique,
  phone_enc text not null,
  phone_tag text not null,
  pin_hash text not null,
  party text not null,
  account_id text not null unique,
  created_at integer not null,
  pin_failures integer not null default 0,
  pin_locked_until integer not null default 0,
  locked integer not null default 0
);
create table if not exists codes (
  purpose text not null,
  target text not null,
  code_hash text not null,
  expires_at integer not null,
  attempts integer not null default 0,
  payload text,
  primary key (purpose, target)
);
create table if not exists signups (
  token_hash text primary key,
  email text not null,
  phone_enc text,
  phone_lookup text,
  phone_verified integer not null default 0,
  expires_at integer not null
);
create table if not exists sessions (
  token_hash text primary key,
  user_id text not null,
  expires_at integer not null
);
create table if not exists pending (
  user_id text primary key,
  kind text not null,
  payload text not null,
  expires_at integer not null
);
create table if not exists alerts (
  user_id text not null,
  symbol text not null,
  pct real not null,
  base_price real not null,
  primary key (user_id, symbol)
);
create table if not exists activity (
  id integer primary key autoincrement,
  user_id text not null,
  at integer not null,
  text text not null
);
create table if not exists phone_changes (
  user_id text primary key,
  proposal_cid text not null,
  new_phone_enc text not null,
  new_phone_lookup text not null,
  new_phone_tag text not null,
  ready_at integer not null
);
create table if not exists inbound (
  msg_id text primary key,
  at integer not null
);
`;

export class Db {
  private readonly db: DatabaseSync;

  constructor(path: string = process.env.DB_PATH ?? fileURLToPath(new URL("../data/privateline.db", import.meta.url))) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
  }

  private get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  // Users

  insertUser(user: User): void {
    this.run(
      `insert into users (id, email, phone_lookup, phone_enc, phone_tag, pin_hash, party, account_id, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      user.id, user.email, user.phone_lookup, user.phone_enc, user.phone_tag, user.pin_hash, user.party, user.account_id, user.created_at);
  }

  userByPhone(lookup: string): User | undefined {
    return this.get("select * from users where phone_lookup = ?", lookup);
  }

  userByEmail(email: string): User | undefined {
    return this.get("select * from users where email = ?", email);
  }

  userById(id: string): User | undefined {
    return this.get("select * from users where id = ?", id);
  }

  allUsers(): User[] {
    return this.all("select * from users order by created_at");
  }

  setPinState(userId: string, failures: number, lockedUntil: number): void {
    this.run("update users set pin_failures = ?, pin_locked_until = ? where id = ?", failures, lockedUntil, userId);
  }

  setLocked(userId: string, locked: boolean): void {
    this.run("update users set locked = ? where id = ?", locked ? 1 : 0, userId);
  }

  setPhone(userId: string, lookup: string, enc: string, tag: string): void {
    this.run("update users set phone_lookup = ?, phone_enc = ?, phone_tag = ? where id = ?", lookup, enc, tag, userId);
  }

  // Verification codes

  putCode(purpose: string, target: string, codeHash: string, expiresAt: number, payload?: string): void {
    this.run(
      `insert into codes (purpose, target, code_hash, expires_at, attempts, payload) values (?, ?, ?, ?, 0, ?)
       on conflict (purpose, target) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, payload = excluded.payload`,
      purpose, target, codeHash, expiresAt, payload ?? null);
  }

  code(purpose: string, target: string): { code_hash: string; expires_at: number; attempts: number; payload: string | null } | undefined {
    return this.get("select code_hash, expires_at, attempts, payload from codes where purpose = ? and target = ?", purpose, target);
  }

  bumpCodeAttempts(purpose: string, target: string): void {
    this.run("update codes set attempts = attempts + 1 where purpose = ? and target = ?", purpose, target);
  }

  deleteCode(purpose: string, target: string): void {
    this.run("delete from codes where purpose = ? and target = ?", purpose, target);
  }

  // Sign-ups in progress

  putSignup(tokenHash: string, email: string, expiresAt: number): void {
    this.run("insert or replace into signups (token_hash, email, expires_at) values (?, ?, ?)", tokenHash, email, expiresAt);
  }

  signup(tokenHash: string): { email: string; phone_enc: string | null; phone_lookup: string | null; phone_verified: number; expires_at: number } | undefined {
    return this.get("select email, phone_enc, phone_lookup, phone_verified, expires_at from signups where token_hash = ?", tokenHash);
  }

  setSignupPhone(tokenHash: string, enc: string, lookup: string): void {
    this.run("update signups set phone_enc = ?, phone_lookup = ?, phone_verified = 0 where token_hash = ?", enc, lookup, tokenHash);
  }

  markSignupPhoneVerified(tokenHash: string): void {
    this.run("update signups set phone_verified = 1 where token_hash = ?", tokenHash);
  }

  deleteSignup(tokenHash: string): void {
    this.run("delete from signups where token_hash = ?", tokenHash);
  }

  // Sessions

  putSession(tokenHash: string, userId: string, expiresAt: number): void {
    this.run("insert into sessions (token_hash, user_id, expires_at) values (?, ?, ?)", tokenHash, userId, expiresAt);
  }

  sessionUser(tokenHash: string, now: number): User | undefined {
    return this.get("select users.* from sessions join users on users.id = sessions.user_id where token_hash = ? and expires_at > ?", tokenHash, now);
  }

  deleteSession(tokenHash: string): void {
    this.run("delete from sessions where token_hash = ?", tokenHash);
  }

  // Pending SMS confirmations (at most one per user)

  putPending(userId: string, kind: string, payload: unknown, expiresAt: number): void {
    this.run("insert or replace into pending (user_id, kind, payload, expires_at) values (?, ?, ?, ?)", userId, kind, JSON.stringify(payload), expiresAt);
  }

  pending(userId: string): Pending | undefined {
    return this.get("select * from pending where user_id = ?", userId);
  }

  deletePending(userId: string): void {
    this.run("delete from pending where user_id = ?", userId);
  }

  // Alerts

  putAlert(alert: Alert): void {
    this.run("insert or replace into alerts (user_id, symbol, pct, base_price) values (?, ?, ?, ?)", alert.user_id, alert.symbol, alert.pct, alert.base_price);
  }

  alerts(userId?: string): Alert[] {
    return userId ? this.all("select * from alerts where user_id = ?", userId) : this.all("select * from alerts");
  }

  deleteAlerts(userId: string, symbol?: string): void {
    if (symbol) this.run("delete from alerts where user_id = ? and symbol = ?", userId, symbol);
    else this.run("delete from alerts where user_id = ?", userId);
  }

  // Activity log shown on the account page

  addActivity(userId: string, text: string): void {
    this.run("insert into activity (user_id, at, text) values (?, ?, ?)", userId, Date.now(), text);
  }

  activity(userId: string, limit = 20): { at: number; text: string }[] {
    return this.all("select at, text from activity where user_id = ? order by id desc limit ?", userId, limit);
  }

  // Phone changes waiting out their cooldown

  putPhoneChange(change: PhoneChange): void {
    this.run(
      `insert or replace into phone_changes (user_id, proposal_cid, new_phone_enc, new_phone_lookup, new_phone_tag, ready_at)
       values (?, ?, ?, ?, ?, ?)`,
      change.user_id, change.proposal_cid, change.new_phone_enc, change.new_phone_lookup, change.new_phone_tag, change.ready_at);
  }

  phoneChanges(): PhoneChange[] {
    return this.all("select * from phone_changes");
  }

  phoneChange(userId: string): PhoneChange | undefined {
    return this.get("select * from phone_changes where user_id = ?", userId);
  }

  deletePhoneChange(userId: string): void {
    this.run("delete from phone_changes where user_id = ?", userId);
  }

  // Webhook de-duplication (gateways retry)

  /** Record an inbound message id; false if it was already seen. */
  firstSighting(msgId: string): boolean {
    try {
      this.run("insert into inbound (msg_id, at) values (?, ?)", msgId, Date.now());
      return true;
    } catch {
      return false;
    }
  }
}
