/** Web Push — send no-payload push notifications via VAPID. */

export interface PushSubscription {
  endpoint: string;
  keys?: { p256dh: string; auth: string };
}

/**
 * Send a no-payload push notification. The service worker shows a
 * predefined message when it receives the push event.
 * Returns true on success (HTTP 201), false on failure.
 */
export async function sendWebPush(
  subscription: PushSubscription,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  payload?: string,
): Promise<boolean> {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await createVapidJWT(audience, vapidPublicKey, vapidPrivateKey);

  const headers: Record<string, string> = {
    Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
    TTL: "86400",
  };

  let body: Uint8Array | null = null;

  if (payload && subscription.keys) {
    body = await encryptPayload(payload, subscription.keys);
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Encoding"] = "aes128gcm";
    headers["Content-Length"] = String(body.byteLength);
  } else {
    headers["Content-Length"] = "0";
  }

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers,
    body,
  });

  return res.status === 201;
}

// ── VAPID JWT ──

async function createVapidJWT(
  audience: string,
  publicKey: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const jwtPayload = b64url(JSON.stringify({
    aud: audience,
    exp: now + 86400,
    sub: "mailto:noreply@freeappstore.online",
  }));
  const unsigned = `${jwtHeader}.${jwtPayload}`;

  const pubBytes = b64urlDecode(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: privateKey,
  };

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key,
    new TextEncoder().encode(unsigned),
  );

  return `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ── Payload encryption (RFC 8291 / aes128gcm) ──

async function encryptPayload(
  payload: string,
  keys: { p256dh: string; auth: string },
): Promise<Uint8Array> {
  const data = new TextEncoder().encode(payload);

  // Generate ephemeral ECDH key pair
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  ) as CryptoKeyPair;
  const localPubRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey) as ArrayBuffer,
  );

  // Import subscriber's public key
  const subPubBytes = b64urlDecode(keys.p256dh);
  const subPub = await crypto.subtle.importKey(
    "raw", subPubBytes, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );

  // ECDH shared secret
  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: subPub } as unknown as SubtleCryptoDeriveKeyAlgorithm, localKeyPair.privateKey, 256,
    ),
  );

  const authSecret = b64urlDecode(keys.auth);

  // HKDF: PRK = HKDF-Extract(auth_secret, ecdh_secret)
  const prkKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveBits"]);
  const ikmForPRK = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret, info: buildInfo("WebPush: info\0", subPubBytes, localPubRaw) },
    prkKey, 256,
  );

  // Content encryption key
  const cekKey = await crypto.subtle.importKey("raw", new Uint8Array(ikmForPRK), "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: buildCEInfo("Content-Encoding: aes128gcm\0") },
    cekKey, 128,
  );

  // Nonce
  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: buildCEInfo("Content-Encoding: nonce\0") },
    cekKey, 96,
  );

  // Pad payload (add 0x02 delimiter)
  const padded = new Uint8Array(data.length + 1);
  padded.set(data);
  padded[data.length] = 2;

  // AES-128-GCM encrypt
  const aesKey = await crypto.subtle.importKey("raw", new Uint8Array(cekBits), "AES-GCM", false, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: new Uint8Array(nonceBits) }, aesKey, padded,
    ),
  );

  // Build aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const rs = data.length + 1 + 16 + 1; // padded + tag + padding delimiter overhead
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(localPubRaw, 21);

  const result = new Uint8Array(header.length + encrypted.length);
  result.set(header);
  result.set(encrypted, header.length);
  return result;
}

function buildInfo(prefix: string, subPub: Uint8Array, localPub: Uint8Array): Uint8Array {
  const p = new TextEncoder().encode(prefix);
  const info = new Uint8Array(p.length + subPub.length + localPub.length);
  info.set(p);
  info.set(subPub, p.length);
  info.set(localPub, p.length + subPub.length);
  return info;
}

function buildCEInfo(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

// ── Base64url helpers ──

function b64url(str: string): string {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(str: string): Uint8Array {
  return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
