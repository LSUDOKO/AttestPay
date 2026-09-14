// Privy session verification (server side). The dashboard sends the user's Privy
// access token as the API bearer; we verify it OFFLINE against the app's JWKS
// (ES256, iss "privy.io", aud = app id) — no Privy app secret, no per-request
// Privy API call. The verified claim is only WHO the user is (sub = did:privy:...);
// the wallet binding is proven separately at onboard (see routes.ts).

import { createRemoteJWKSet, errors, jwtVerify } from "jose";

export type PrivyAuth = { did: string };
/** Returns the verified identity, or null for any invalid/expired/foreign token. */
export type PrivyVerifier = (token: string) => Promise<PrivyAuth | null>;

// Logged at most once per distinct failure reason: this env var is the single most
// common Render/Fly/Railway misconfiguration (a pasted trailing newline, or the
// client id swapped in for the app id), and every prior version of this file swallowed
// jose's specific error, leaving only a bare 401 with nothing to grep in the deploy's
// logs. `err.code`/`err.claim`/`err.reason` are jose's own diagnostic fields — never
// the token or any secret — so this is safe to print.
const warnedReasons = new Set<string>();
function warnOnce(appId: string, e: unknown): void {
  let detail: string;
  if (e instanceof errors.JWTClaimValidationFailed) {
    detail = `claim "${e.claim}" failed (${e.reason}) — if claim is "aud", ATTESTPAY_PRIVY_APP_ID does not match the app id the token was issued for`;
  } else if (e instanceof errors.JWTExpired) {
    detail = "token expired (client clock skew, or a stale token was replayed)";
  } else if (e instanceof errors.JWKSNoMatchingKey || e instanceof errors.JWSSignatureVerificationFailed) {
    detail = "no matching signing key / bad signature — check ATTESTPAY_PRIVY_APP_ID is the exact app id, not the client id";
  } else if (e instanceof errors.JOSEError) {
    detail = `${e.code}: ${e.message}`;
  } else {
    detail = e instanceof Error ? e.message : String(e);
  }
  const key = `${appId}:${detail}`;
  if (warnedReasons.has(key)) return;
  warnedReasons.add(key);
  console.warn(`[privy] token rejected (appId=${appId}): ${detail}`);
}

export function makePrivyVerifier(appId: string): PrivyVerifier {
  // jose caches the JWKS and refetches on unknown-kid / cooldown — one fetch, not one per request
  const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: "privy.io",
        audience: appId,
        algorithms: ["ES256"],
      });
      return typeof payload.sub === "string" && payload.sub.startsWith("did:privy:")
        ? { did: payload.sub }
        : null;
    } catch (e) {
      warnOnce(appId, e); // invalid signature, expired, wrong aud/iss, malformed — logged once, then 401
      return null;
    }
  };
}

/** The message the embedded wallet signs at onboard to PROVE it belongs to this Privy
 * login. Including the DID makes the signature non-replayable by any other login
 * (a stolen signature recovers fine but carries the wrong DID). */
export const onboardProofMessage = (did: string): string => `attestpay-onboard:v1:${did}`;
