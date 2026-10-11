import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM envelope for per-tool secrets. Key: SECRETS_KEY (any string; hashed to 32 bytes). */
const key = () => {
  const k = process.env.SECRETS_KEY;
  if (!k) throw new Error('SECRETS_KEY is required to store tool secrets.');
  return createHash('sha256').update(k).digest();
};

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map(p => Buffer.from(p, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
