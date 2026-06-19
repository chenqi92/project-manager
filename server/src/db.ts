import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface AccountRow {
  account_id: string;
  token_hash: string;
  created_at: number;
}

export interface VaultRow {
  account_id: string;
  blob: string;
  revision: number;
  updated_at: number;
}

/** 对高熵随机 token 用 SHA-256 索引存储已足够（无字典攻击空间）。 */
export function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 存储层。服务器只读写不透明的密文 blob 与同步元数据（revision/updated_at），
 * 永不解析 EncryptedVault.data。换 Cloudflare 时只需把这一层换成 D1/KV。
 */
export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vaults (
        account_id TEXT PRIMARY KEY REFERENCES accounts(account_id),
        blob       TEXT NOT NULL,
        revision   INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  countAccounts(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    return row.n;
  }

  accountByToken(token: string): AccountRow | undefined {
    return this.db
      .prepare('SELECT * FROM accounts WHERE token_hash = ?')
      .get(sha256hex(token)) as AccountRow | undefined;
  }

  createAccount(token?: string): { accountId: string; token: string } {
    const accountId = randomUUID();
    const t = token ?? randomBytes(32).toString('base64url');
    this.db
      .prepare('INSERT INTO accounts (account_id, token_hash, created_at) VALUES (?, ?, ?)')
      .run(accountId, sha256hex(t), Date.now());
    return { accountId, token: t };
  }

  getVault(accountId: string): VaultRow | undefined {
    return this.db
      .prepare('SELECT * FROM vaults WHERE account_id = ?')
      .get(accountId) as VaultRow | undefined;
  }

  putVault(accountId: string, blob: string, revision: number): void {
    this.db
      .prepare(
        `INSERT INTO vaults (account_id, blob, revision, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           blob = excluded.blob, revision = excluded.revision, updated_at = excluded.updated_at`,
      )
      .run(accountId, blob, revision, Date.now());
  }

  deleteVault(accountId: string): void {
    this.db.prepare('DELETE FROM vaults WHERE account_id = ?').run(accountId);
  }
}
