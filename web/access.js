// Verification of Cloudflare Access login tokens, so the game data is only ever served to signed-in users.
// The token is a signed JWT that Access adds to every request it lets through. Checking only that the header is
// present would be useless, as anyone could add it themselves: the signature, issuer and audience must be verified.

const JWKS_CACHE_MS = 60 * 60 * 1000;
let jwksCache = { team: null, keys: null, fetchedAt: 0 };

function base64UrlToBytes(value) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function parseJson(bytes) {
    return JSON.parse(new TextDecoder().decode(bytes));
}

async function getKeys(team, fetchFn) {
    const now = Date.now();
    if (jwksCache.team === team && jwksCache.keys && now - jwksCache.fetchedAt < JWKS_CACHE_MS) {
        return jwksCache.keys;
    }
    const response = await fetchFn("https://" + team + "/cdn-cgi/access/certs");
    if (!response.ok) {
        throw new Error("Could not fetch the Access signing keys: " + response.status);
    }
    const body = await response.json();
    jwksCache = { team, keys: body.keys || [], fetchedAt: now };
    return jwksCache.keys;
}

export function resetAccessKeyCache() {
    jwksCache = { team: null, keys: null, fetchedAt: 0 };
}

function readToken(request) {
    const header = request.headers.get("Cf-Access-Jwt-Assertion");
    if (header) {
        return header;
    }
    const cookies = request.headers.get("Cookie") || "";
    const match = cookies.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
    return match ? match[1] : null;
}

/**
 * @returns {Promise<boolean>} true only for an unexpired token signed by the team's keys for this application
 */
export async function verifyAccessRequest(request, options, fetchFn = fetch, nowSeconds = Date.now() / 1000) {
    return (await verifyAccessIdentity(request, options, fetchFn, nowSeconds)) !== null;
}

/**
 * @returns {Promise<object|null>} the token's claims (email, sub, ...) only for an unexpired token signed by the team's
 * keys for this application, null otherwise
 */
export async function verifyAccessIdentity(request, { team, audience }, fetchFn = fetch, nowSeconds = Date.now() / 1000) {
    const token = readToken(request);
    if (!token) {
        return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
        return null;
    }
    try {
        const header = parseJson(base64UrlToBytes(parts[0]));
        const payload = parseJson(base64UrlToBytes(parts[1]));
        if (header.alg !== "RS256") {
            return null;
        }
        if (payload.iss !== "https://" + team) {
            return null;
        }
        const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!audiences.includes(audience)) {
            return null;
        }
        if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
            return null;
        }
        if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + 60) {
            return null;
        }
        const keys = await getKeys(team, fetchFn);
        const jwk = keys.find(key => key.kid === header.kid);
        if (!jwk) {
            return null;
        }
        const key = await crypto.subtle.importKey("jwk", jwk,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlToBytes(parts[2]),
            new TextEncoder().encode(parts[0] + "." + parts[1]));
        return valid ? payload : null;
    } catch (error) {
        return null;
    }
}
