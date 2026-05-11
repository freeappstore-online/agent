import { describe, it, expect, vi, beforeAll } from "vitest";
import { sendWebPush, type PushSubscription } from "./push";

// Generate a test VAPID key pair at runtime — never commit real keys
let VAPID_PUBLIC: string;
let VAPID_PRIVATE: string;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

beforeAll(async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey) as JsonWebKey;
  VAPID_PUBLIC = b64url(pubRaw);
  VAPID_PRIVATE = privJwk.d!;
});

const FAKE_SUB: PushSubscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-id-123",
};

describe("sendWebPush — no payload", () => {
  it("POSTs to the subscription endpoint", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(FAKE_SUB.endpoint);
      expect(opts.method).toBe("POST");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends VAPID Authorization header with JWT", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
      const headers = mockFetch.mock.calls[0][1].headers;

      // Authorization: vapid t=<JWT>, k=<publicKey>
      expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
      expect(headers.Authorization).toContain(VAPID_PUBLIC);

      // Extract JWT and verify structure (3 base64url parts)
      const jwt = headers.Authorization.match(/t=([^,]+)/)?.[1];
      expect(jwt).toBeDefined();
      const parts = jwt!.split(".");
      expect(parts).toHaveLength(3);

      // Decode header — should be {"typ":"JWT","alg":"ES256"}
      const jwtHeader = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
      expect(jwtHeader.typ).toBe("JWT");
      expect(jwtHeader.alg).toBe("ES256");

      // Decode payload — should have aud, exp, sub
      const jwtPayload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(jwtPayload.aud).toBe("https://fcm.googleapis.com");
      expect(jwtPayload.sub).toBe("mailto:noreply@freeappstore.online");
      expect(jwtPayload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sets TTL and Content-Length headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.TTL).toBe("86400");
      expect(headers["Content-Length"]).toBe("0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends no body for no-payload push", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
      expect(mockFetch.mock.calls[0][1].body).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns false on non-201 response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 410 }); // subscription expired
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await sendWebPush(FAKE_SUB, VAPID_PUBLIC, VAPID_PRIVATE);
      expect(result).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("audience matches subscription endpoint origin", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      // Test with Mozilla push service
      const mozSub: PushSubscription = {
        endpoint: "https://updates.push.services.mozilla.com/push/v1/test-123",
      };
      await sendWebPush(mozSub, VAPID_PUBLIC, VAPID_PRIVATE);
      const jwt = mockFetch.mock.calls[0][1].headers.Authorization.match(/t=([^,]+)/)?.[1];
      const payload = JSON.parse(atob(jwt!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      expect(payload.aud).toBe("https://updates.push.services.mozilla.com");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

