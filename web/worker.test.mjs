// Run with: node --test web/worker.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker from "./worker.js";
import { resetAccessKeyCache } from "./access.js";
import { memoryBucket } from "./test-bucket.mjs";

const TEAM = "team.cloudflareaccess.com";
const AUD = "app-aud-tag";

function b64url(bytes) {
    return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const keyPair = await webcrypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
const publicJwk = { ...(await webcrypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1", alg: "RS256" };

async function makeToken(overrides = {}, headerOverrides = {}) {
    const header = { alg: "RS256", kid: "k1", typ: "JWT", ...headerOverrides };
    const payload = { iss: "https://" + TEAM, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, ...overrides };
    const signingInput = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
    const signature = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, new TextEncoder().encode(signingInput));
    return signingInput + "." + b64url(new Uint8Array(signature));
}

const originalFetch = globalThis.fetch;
test.beforeEach(() => {
    resetAccessKeyCache();
    globalThis.fetch = async url => {
        assert.equal(String(url), "https://" + TEAM + "/cdn-cgi/access/certs");
        return new Response(JSON.stringify({ keys: [publicJwk] }));
    };
});
test.after(() => { globalThis.fetch = originalFetch; });

function bucket(files, pageSize = 1000) {
    const keys = Object.keys(files).sort();
    return {
        async list({ prefix, cursor, limit }) {
            const size = Math.min(pageSize, limit);
            const matching = keys.filter(key => key.startsWith(prefix));
            const start = cursor ? Number(cursor) : 0;
            const slice = matching.slice(start, start + size);
            return {
                objects: slice.map(key => ({ key, size: files[key].length })),
                truncated: start + size < matching.length,
                cursor: String(start + size)
            };
        },
        async get(key) {
            return key in files ? { size: files[key].length, httpEtag: '"e"', body: files[key] } : null;
        },
        async head(key) {
            return key in files ? { size: files[key].length, httpEtag: '"e"' } : null;
        }
    };
}

const files = { "c3/C3.sg2": "abc", "c3/wavs/a.wav": "hello", "other/x": "no" };
const env = (extra = {}) => ({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    C3_DATA: bucket(files),
    ASSETS: { fetch: async () => new Response("static") },
    ...extra
});
const get = async (path, e, headers = {}, method = "GET") =>
    worker.fetch(new Request("https://augustus.example" + path, { method, headers }), e);
const signedIn = async () => ({ "Cf-Access-Jwt-Assertion": await makeToken() });

test("static files never need a login", async () => {
    const response = await get("/index.html", env());
    assert.equal(await response.text(), "static");
});

test("game data refuses requests without a login", async () => {
    assert.equal((await get("/c3data/manifest.json", env())).status, 403);
    assert.equal((await get("/c3data/C3.sg2", env())).status, 403);
});

test("game data refuses forged, expired and foreign tokens", async () => {
    const forged = (await makeToken()).split(".").slice(0, 2).join(".") + "." + b64url(new Uint8Array(256));
    assert.equal((await get("/c3data/manifest.json", env(), { "Cf-Access-Jwt-Assertion": forged })).status, 403);
    const expired = await makeToken({ exp: Math.floor(Date.now() / 1000) - 5 });
    assert.equal((await get("/c3data/manifest.json", env(), { "Cf-Access-Jwt-Assertion": expired })).status, 403);
    const wrongAudience = await makeToken({ aud: ["someone-else"] });
    assert.equal((await get("/c3data/manifest.json", env(), { "Cf-Access-Jwt-Assertion": wrongAudience })).status, 403);
    const wrongIssuer = await makeToken({ iss: "https://evil.cloudflareaccess.com" });
    assert.equal((await get("/c3data/manifest.json", env(), { "Cf-Access-Jwt-Assertion": wrongIssuer })).status, 403);
    const wrongAlg = await makeToken({}, { alg: "none" });
    assert.equal((await get("/c3data/manifest.json", env(), { "Cf-Access-Jwt-Assertion": wrongAlg })).status, 403);
});

test("the CF_Authorization cookie is accepted as well", async () => {
    const response = await get("/c3data/manifest.json", env(), { Cookie: "a=b; CF_Authorization=" + (await makeToken()) });
    assert.equal(response.status, 200);
});

test("game data stays disabled until Access is configured", async () => {
    const response = await get("/c3data/manifest.json", env({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }), await signedIn());
    assert.equal(response.status, 503);
});

test("manifest lists only the game data prefix, across pages", async () => {
    const many = {};
    for (let i = 0; i < 25; i++) many["c3/f" + String(i).padStart(2, "0")] = "x".repeat(i + 1);
    const response = await get("/c3data/manifest.json", env({ C3_DATA: bucket({ ...many, "elsewhere/x": "y" }, 10) }), await signedIn());
    const body = await response.json();
    assert.equal(body.files.length, 25);
    assert.deepEqual(body.files[0], { path: "f00", size: 1 });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("serves a file with its size, and nested paths", async () => {
    const headers = await signedIn();
    const flat = await get("/c3data/C3.sg2", env(), headers);
    assert.equal(await flat.text(), "abc");
    assert.equal(flat.headers.get("Content-Length"), "3");
    const nested = await get("/c3data/wavs/a.wav", env(), headers);
    assert.equal(await nested.text(), "hello");
    assert.equal((await get("/c3data/missing.bin", env(), headers)).status, 404);
    assert.equal((await get("/c3data/C3.sg2", env(), headers, "HEAD")).status, 200);
});

test("rejects path tricks and other methods", async () => {
    const headers = await signedIn();
    // The URL parser resolves %2e%2e before the Worker sees it, which lands outside the game data route
    assert.equal(await (await get("/c3data/%2e%2e/secret", env(), headers)).text(), "static");
    assert.equal((await get("/c3data/%252e%252e/secret", env(), headers)).status, 404);
    assert.equal((await get("/c3data/wavs//a.wav", env(), headers)).status, 400);
    assert.equal((await get("/c3data/", env(), headers)).status, 400);
    assert.equal((await get("/c3data/%zz", env(), headers)).status, 400);
    assert.equal((await get("/c3data/C3.sg2", env(), headers, "POST")).status, 405);
});

test("local development can opt out of the login", async () => {
    const response = await get("/c3data/manifest.json", env({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", ALLOW_PUBLIC_DATA: "true" }));
    assert.equal(response.status, 200);
});

// ---- cloud saves ------------------------------------------------------------------------------------------------

const savesEnv = () => env({ C3_DATA: memoryBucket() });
const as = async email => ({ "Cf-Access-Jwt-Assertion": await makeToken({ email }), "X-Augustus-Cloud": "1" });
const put = async (e, name, body, headers) => worker.fetch(new Request("https://augustus.example/cloud/saves/" + encodeURIComponent(name),
    { method: "PUT", body, headers }), e);
const NONE = { "X-Save-Base": "none" };

test("cloud saves need a login", async () => {
    const e = savesEnv();
    assert.equal((await get("/cloud/saves", e)).status, 403);
    assert.equal((await put(e, "a.sav", "x", NONE)).status, 403);
});

test("cloud saves are kept per player", async () => {
    const e = savesEnv();
    assert.equal((await put(e, "Rome.sav", "adam's", { ...(await as("Adam@Example.com")), ...NONE })).status, 200);
    const mine = await (await get("/cloud/saves", e, await as("adam@example.com"))).json();
    assert.equal(mine.user, "adam@example.com");
    assert.deepEqual(mine.files.map(f => f.name), ["Rome.sav"]);
    assert.equal(mine.files[0].hash.length, 64);
    const theirs = await (await get("/cloud/saves", e, await as("someone@example.com"))).json();
    assert.deepEqual(theirs.files, []);
    assert.equal((await get("/cloud/saves/Rome.sav", e, await as("someone@example.com"))).status, 404);
    const file = await get("/cloud/saves/Rome.sav", e, await as("adam@example.com"));
    assert.equal(await file.text(), "adam's");
    assert.equal(file.headers.get("X-Save-Hash"), mine.files[0].hash);
});

test("cloud save uploads refuse to overwrite a version they have not seen", async () => {
    const e = savesEnv();
    const h = await as("adam@example.com");
    const first = await (await put(e, "Rome.sav", "v1", { ...h, ...NONE })).json();
    // A second device that never saw v1 cannot replace it
    assert.equal((await put(e, "Rome.sav", "other", { ...h, ...NONE })).status, 409);
    assert.equal((await put(e, "Rome.sav", "other", { ...h, "X-Save-Base": "0".repeat(64) })).status, 409);
    // Uploading the same content again is fine, and so is replacing the version that was seen
    assert.equal((await put(e, "Rome.sav", "v1", { ...h, ...NONE })).status, 200);
    assert.equal((await put(e, "Rome.sav", "v2", { ...h, "X-Save-Base": first.hash })).status, 200);
    assert.equal((await put(e, "Rome.sav", "v2", { ...h })).status, 400);
});

test("cloud save deletes go to the trash and need the current version", async () => {
    const bucket = memoryBucket();
    const e = env({ C3_DATA: bucket });
    const h = await as("adam@example.com");
    const stored = await (await put(e, "Rome.sav", "v1", { ...h, ...NONE })).json();
    assert.equal((await get("/cloud/saves/Rome.sav", e, { ...h, "X-Save-Base": "0".repeat(64) }, "DELETE")).status, 409);
    assert.equal((await get("/cloud/saves/Rome.sav", e, { ...h, "X-Save-Base": stored.hash }, "DELETE")).status, 200);
    const keys = [...bucket.objects.keys()];
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^saves\/adam%40example\.com\/trash\/.* Rome\.sav$/);
});

test("cloud saves only accept save file names and the anti-forgery header", async () => {
    const e = savesEnv();
    const h = await as("adam@example.com");
    for (const name of ["evil.exe", ".hidden.sav", "a/b.sav", "..\\x.sav", " space.sav"]) {
        assert.equal((await put(e, name, "x", { ...h, ...NONE })).status, 400, name);
    }
    const { ["X-Augustus-Cloud"]: _, ...noHeader } = h;
    assert.equal((await put(e, "Rome.sav", "x", { ...noHeader, ...NONE })).status, 403);
    assert.equal((await put(e, "Rome.svx", "", { ...h, ...NONE })).status, 400);
});
