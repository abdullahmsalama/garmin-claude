// Encryption for Garmin tokens at rest (AES-GCM) and signing for the owner's login cookie (HMAC).
// Both keys are derived (HKDF) from a Worker secret, so the secret itself is never used directly.

const enc = new TextEncoder(), dec = new TextDecoder();
export const b64u = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export const randomId = (bytes = 24) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

const cache = new Map();
async function derive(secret, info, algo, usages) {
  if (!secret || secret.length < 16) throw new Error('OWNER_PASSWORD is missing or too short');
  const id = `${info}|${secret}`;
  if (cache.has(id)) return cache.get(id);
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('garmin-connector'), info: enc.encode(info) }, base, algo, false, usages);
  cache.set(id, key);
  return key;
}
// The key material: an ENCRYPTION_KEY secret if you set one, otherwise your OWNER_PASSWORD (so a
// Deploy-button setup needs only one secret). Changing the password means re-entering the Garmin key.
const secretOf = env => env.ENCRYPTION_KEY || (env.OWNER_PASSWORD ? `owner-password-derived:${env.OWNER_PASSWORD}` : '');
const aesKey = env => derive(secretOf(env), 'tokens-v1', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']);
const hmacKey = env => derive(secretOf(env), 'session-v1', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign', 'verify']);

export async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(text));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function decrypt(env, blob) {
  const [v, iv, ct] = String(blob).split('.');
  if (v !== 'v1') throw new Error('unknown token format');
  return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await aesKey(env), unb64u(ct)));
}

export async function sign(env, text) { return b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(text))); }
export async function verify(env, text, sig) {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(text)); } catch { return false; }
}
// Compares two strings without leaking how much of them matched.
export async function sameSecret(env, a, b) {
  const [x, y] = await Promise.all([sign(env, `cmp:${a}`), sign(env, `cmp:${b}`)]);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0 && typeof b === 'string' && b.length > 0;
}

export async function pkcePair() {
  const verifier = randomId(48);
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  return { verifier, challenge };
}
