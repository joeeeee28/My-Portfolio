/**
 * Encrypted secret vault (§55).
 *
 * Provider credentials are encrypted at rest with AES-256-GCM. The master key
 * comes from OS_MASTER_KEY when set; otherwise a per-install key file with
 * 0600 permissions is generated inside the data directory.
 *
 * Nothing in this module ever returns plaintext to an HTTP handler — callers
 * get `masked` values for display and the decrypted value only inside the
 * server-side provider that needs it.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { all, get, run, tx } from '@/db';
import { id, nowIso } from './id';

const ALGO = 'aes-256-gcm';

function keyFile(): string {
  return path.join(process.cwd(), '.data', 'master.key');
}

let cachedKey: Buffer | null = null;

export function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.OS_MASTER_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    return cachedKey;
  }
  const file = keyFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
  } else {
    cachedKey = crypto.randomBytes(32);
    fs.writeFileSync(file, cachedKey.toString('hex'), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
  return cachedKey;
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  const [v, ivB, tagB, dataB] = blob.split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const decipher = crypto.createDecipheriv(ALGO, masterKey(), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

/** Display-safe mask. Full value is never sent to the client. */
export function maskSecret(plaintext: string): string {
  const t = plaintext.trim();
  if (t.length <= 4) return '••••';
  const head = t.length > 12 ? t.slice(0, 4) : t.slice(0, 2);
  return `${head}${'•'.repeat(Math.min(12, Math.max(4, t.length - 4)))}${t.slice(-2)}`;
}

// ── Vault operations ─────────────────────────────────────────
export interface SecretRow {
  id: string;
  org_id: string;
  provider_key: string;
  label: string;
  last4: string | null;
  is_active: number;
  verified_at: string | null;
  verify_error: string | null;
  created_at: string;
  updated_at: string;
}

export function listSecrets(orgId: string): SecretRow[] {
  return all<SecretRow>(
    `SELECT id, org_id, provider_key, label, last4, is_active, verified_at, verify_error, created_at, updated_at
       FROM secrets WHERE org_id = ? ORDER BY provider_key`,
    [orgId]
  );
}

export function getSecret(orgId: string, providerKey: string): string | null {
  const row = get<{ cipher_blob: string; is_active: number }>(
    'SELECT cipher_blob, is_active FROM secrets WHERE org_id = ? AND provider_key = ?',
    [orgId, providerKey]
  );
  if (!row || !row.is_active) return null;
  try {
    return decryptSecret(row.cipher_blob);
  } catch {
    return null;
  }
}

export function hasSecret(orgId: string, providerKey: string): boolean {
  return getSecret(orgId, providerKey) !== null;
}

export function setSecret(
  orgId: string,
  providerKey: string,
  plaintext: string,
  label: string
): { id: string; last4: string } {
  const blob = encryptSecret(plaintext);
  const last4 = plaintext.length > 4 ? plaintext.slice(-4) : '••••';
  const now = nowIso();
  tx(() => {
    const existing = get<{ id: string }>('SELECT id FROM secrets WHERE org_id = ? AND provider_key = ?', [
      orgId,
      providerKey,
    ]);
    if (existing) {
      run(
        `UPDATE secrets SET cipher_blob = ?, last4 = ?, label = ?, is_active = 1, verified_at = NULL,
                verify_error = NULL, updated_at = ? WHERE id = ?`,
        [blob, last4, label, now, existing.id]
      );
    } else {
      run(
        `INSERT INTO secrets (id, org_id, provider_key, label, cipher_blob, last4, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,1,?,?)`,
        [id('sec'), orgId, providerKey, label, blob, last4, now, now]
      );
    }
  });
  return { id: providerKey, last4 };
}

export function deleteSecret(orgId: string, providerKey: string): boolean {
  const { changes } = run('DELETE FROM secrets WHERE org_id = ? AND provider_key = ?', [orgId, providerKey]);
  return changes > 0;
}

export function markSecretVerified(orgId: string, providerKey: string, ok: boolean, error?: string): void {
  run('UPDATE secrets SET verified_at = ?, verify_error = ?, updated_at = ? WHERE org_id = ? AND provider_key = ?', [
    ok ? nowIso() : null,
    error ?? null,
    nowIso(),
    orgId,
    providerKey,
  ]);
}

/** True when the process is running with the recommended production key setup. */
export function masterKeySource(): 'env' | 'file' {
  return process.env.OS_MASTER_KEY ? 'env' : 'file';
}
