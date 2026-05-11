import { describe, it, expect, vi } from "vitest";
import { sendWebPush, type PushSubscription } from "./push";

// Test VAPID keys (the ones we generated for the platform)
const VAPID_PUBLIC = "BM0KWao4V5j4j1L4dOJhmG6w9kVgiUANKzCDGCqcZE3izzT_tJhB5bq2CvtkthveWR2VUGvadFbGMQP6Qablybk";
const VAPID_PRIVATE = "PBDJUL-Y5qEqONcEMJZLC6u0Lz9owu2vT3-j0DNWjNQ";

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
      expect(mockFetch.mock.calls[0][1].body).toBeNull();
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

describe("sendWebPush — with payload", () => {
  it("sends encrypted body when payload + keys provided", async () => {
    // Generate a real P-256 key pair for the subscriber
    const subKeyPair = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    );
    const subPubRaw = new Uint8Array(
      await crypto.subtle.exportKey("raw", subKeyPair.publicKey),
    );
    const authSecret = crypto.getRandomValues(new Uint8Array(16));

    const sub: PushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-encrypted",
      keys: {
        p256dh: btoa(String.fromCharCode(...subPubRaw)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"),
        auth: btoa(String.fromCharCode(...authSecret)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"),
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      const result = await sendWebPush(sub, VAPID_PUBLIC, VAPID_PRIVATE, "Build complete!");
      expect(result).toBe(true);

      const opts = mockFetch.mock.calls[0][1];
      expect(opts.headers["Content-Type"]).toBe("application/octet-stream");
      expect(opts.headers["Content-Encoding"]).toBe("aes128gcm");
      expect(opts.body).toBeInstanceOf(Uint8Array);
      // aes128gcm header: 16 (salt) + 4 (rs) + 1 (idlen) + 65 (keyid) = 86 bytes minimum
      expect(opts.body.byteLength).toBeGreaterThan(86);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("skips encryption when keys not provided", async () => {
    const sub: PushSubscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/no-keys",
      // no keys
    };

    const mockFetch = vi.fn().mockResolvedValue({ status: 201 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as any;

    try {
      await sendWebPush(sub, VAPID_PUBLIC, VAPID_PRIVATE, "Build complete!");
      const opts = mockFetch.mock.calls[0][1];
      // Falls back to no-payload push
      expect(opts.body).toBeNull();
      expect(opts.headers["Content-Length"]).toBe("0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
