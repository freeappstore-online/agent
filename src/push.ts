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
export async function sendWebPush(subscription: PushSubscription, vapidPublicKey: string, vapidPrivateKey: string): Promise<boolean> {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await createVapidJWT(audience, vapidPublicKey, vapidPrivateKey);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${vapidPublicKey}`,
      TTL: "86400",
      "Content-Length": "0",
    },
  });

  return res.status === 201;
}

// ── VAPID JWT ──

async function createVapidJWT(audience: string, publicKey: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const jwtPayload = b64url(
    JSON.stringify({
      aud: audience,
      exp: now + 86400,
      sub: "mailto:noreply@freeappstore.online",
    }),
  );
  const unsigned = `${jwtHeader}.${jwtPayload}`;

  const pubBytes = b64urlDecode(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: privateKey,
  };

  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned));

  return `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ── Base64url helpers ──

function b64url(str: string): string {
  return btoa(str).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(str: string): Uint8Array {
  return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}
