// Serves the Augustus web build and the owner's Caesar III game data.
//
// The static build (html, js, wasm, packed Augustus assets) comes from the assets binding. The original Caesar III
// files are proprietary: they live in a private R2 bucket and are only handed out to requests that carry a valid
// Cloudflare Access login for this application. Nothing in this repository or in the build contains game data.
// The same login also keys each player's cloud saves (/cloud/saves, see saves.js), stored in the same bucket.

import { verifyAccessIdentity } from "./access.js";
import { SAVES_PREFIX, handleSaves } from "./saves.js";

const DATA_PREFIX = "/c3data/";
const BUCKET_PREFIX = "c3/";
const MANIFEST_PATH = DATA_PREFIX + "manifest.json";

function text(status, body) {
    return new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// Returns { identity } for a signed-in request, or { denied: Response }
async function authorize(request, env) {
    if (env.ALLOW_PUBLIC_DATA === "true") {
        return { identity: { email: "local-dev" } };
    }
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
        return { denied: text(503, "Game data is disabled until ACCESS_TEAM_DOMAIN and ACCESS_AUD are configured, see web/README.md") };
    }
    const identity = await verifyAccessIdentity(request, { team: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD });
    return identity ? { identity } : { denied: text(403, "Sign in through Cloudflare Access to use the game data and cloud saves") };
}

async function manifest(env) {
    const files = [];
    let cursor;
    do {
        const page = await env.C3_DATA.list({ prefix: BUCKET_PREFIX, cursor, limit: 1000 });
        for (const object of page.objects) {
            files.push({ path: object.key.substring(BUCKET_PREFIX.length), size: object.size });
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    files.sort((a, b) => (a.path < b.path ? -1 : 1));
    return new Response(JSON.stringify({ files }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
}

async function gameFile(request, env, pathname) {
    let relative;
    try {
        relative = decodeURIComponent(pathname.substring(DATA_PREFIX.length));
    } catch (error) {
        return text(400, "Bad path");
    }
    const segments = relative.split("/");
    if (!relative || segments.some(segment => segment === "" || segment === "." || segment === "..")) {
        return text(400, "Bad path");
    }
    const object = request.method === "HEAD"
        ? await env.C3_DATA.head(BUCKET_PREFIX + relative)
        : await env.C3_DATA.get(BUCKET_PREFIX + relative);
    if (!object) {
        return text(404, "Not found");
    }
    const headers = new Headers({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "ETag": object.httpEtag,
        "Cache-Control": "private, no-cache"
    });
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const isSaves = url.pathname === SAVES_PREFIX || url.pathname.startsWith(SAVES_PREFIX + "/");
        if (!url.pathname.startsWith(DATA_PREFIX) && !isSaves) {
            return env.ASSETS.fetch(request);
        }
        if (!isSaves && request.method !== "GET" && request.method !== "HEAD") {
            return text(405, "Method not allowed");
        }
        const { identity, denied } = await authorize(request, env);
        if (denied) {
            return denied;
        }
        if (isSaves) {
            try {
                return await handleSaves(request, env, identity, url.pathname);
            } catch (error) {
                console.error(error);
                return text(502, "Cloud save storage failed, the browser keeps its copy and retries");
            }
        }
        return url.pathname === MANIFEST_PATH ? manifest(env) : gameFile(request, env, url.pathname);
    }
};
