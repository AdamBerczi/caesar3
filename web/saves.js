// Cloud saves: each signed-in player's saved games, kept in the same private R2 bucket as the game data.
//
// The browser keeps working on its local copy (IndexedDB) and synchronises with this API in the background, see
// web/cloud-sync.js. Every object is stored under the player's own prefix, derived from their Cloudflare Access login,
// so one player can never read or change another player's saves. Nothing is ever deleted outright: a deleted save is
// moved to the player's trash prefix, where it can be recovered from the R2 dashboard.
//
//   GET    /cloud/saves          list: { user, files: [{ name, size, hash, modified }] }
//   GET    /cloud/saves/<name>   the save file, with X-Save-Hash and X-Save-Modified
//   PUT    /cloud/saves/<name>   upload; X-Save-Base is the hash the client last synced ("none" for a new file)
//   DELETE /cloud/saves/<name>   move to trash; X-Save-Base must match the stored hash
//
// A PUT or DELETE whose base does not match what is stored answers 409, so an outdated browser can never overwrite a
// newer save from another device: it has to download the newer one first and decide (see cloud-sync.js).

export const SAVES_PREFIX = "/cloud/saves";
export const MAX_SAVE_BYTES = 32 * 1024 * 1024;
const SAVE_NAME = /^[^/\\\u0000-\u001f.][^/\\\u0000-\u001f]{0,150}\.(sav|svx|map)$/i;

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
}

function text(status, body) {
    return new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

// The storage folder of one player. The Access email is stable across devices and readable in the R2 dashboard.
export function userKey(identity) {
    const id = String(identity.email || identity.sub || "").trim().toLowerCase();
    return id ? encodeURIComponent(id) : null;
}

export function isValidSaveName(name) {
    return typeof name === "string" && SAVE_NAME.test(name) && name.trim() === name;
}

async function sha256Hex(buffer) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
    return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function describe(object, name) {
    const meta = object.customMetadata || {};
    return {
        name,
        size: object.size,
        hash: meta.sha256 || "",
        modified: Number(meta.modified) || (object.uploaded ? object.uploaded.getTime() : 0)
    };
}

async function list(bucket, root, user) {
    const files = [];
    let cursor;
    do {
        const page = await bucket.list({ prefix: root, cursor, limit: 1000, include: ["customMetadata"] });
        for (const object of page.objects) {
            const name = object.key.substring(root.length);
            if (isValidSaveName(name)) {
                files.push(describe(object, name));
            }
        }
        cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    files.sort((a, b) => (a.name < b.name ? -1 : 1));
    return json(200, { user: decodeURIComponent(user), files });
}

function baseOf(request) {
    const base = (request.headers.get("X-Save-Base") || "").trim().toLowerCase();
    return base === "none" || /^[0-9a-f]{64}$/.test(base) ? base : null;
}

async function download(bucket, key, name) {
    const object = await bucket.get(key);
    if (!object) {
        return text(404, "Not found");
    }
    const info = describe(object, name);
    return new Response(object.body, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(object.size),
            "Cache-Control": "no-store",
            "X-Save-Hash": info.hash,
            "X-Save-Modified": String(info.modified)
        }
    });
}

async function upload(request, bucket, key, name) {
    const base = baseOf(request);
    if (!base) {
        return text(400, "X-Save-Base must be the last synced hash, or none");
    }
    const declared = Number(request.headers.get("Content-Length"));
    if (declared > MAX_SAVE_BYTES) {
        return text(413, "Save files are limited to " + MAX_SAVE_BYTES + " bytes");
    }
    const body = await request.arrayBuffer();
    if (body.byteLength === 0 || body.byteLength > MAX_SAVE_BYTES) {
        return text(body.byteLength ? 413 : 400, body.byteLength ? "Save file too large" : "Empty save file");
    }
    const hash = await sha256Hex(body);
    let modified = Math.floor(Number(request.headers.get("X-Save-Modified")));
    if (!Number.isFinite(modified) || modified <= 0) {
        modified = Date.now();
    }
    const current = await bucket.head(key);
    const currentHash = current ? describe(current, name).hash : null;
    if (currentHash === hash) {
        return json(200, describe(current, name)); // already there, nothing to do
    }
    if (current ? currentHash !== base : base !== "none") {
        return json(409, { error: "conflict", current: current ? describe(current, name) : null });
    }
    const options = { customMetadata: { sha256: hash, modified: String(modified) }, sha256: hash };
    if (current) {
        // Only replace exactly the version that was checked above, in case another device uploads at the same moment
        options.onlyIf = { etagMatches: current.etag };
    }
    const stored = await bucket.put(key, body, options);
    if (!stored) {
        return json(409, { error: "conflict", current: null });
    }
    return json(200, { name, size: body.byteLength, hash, modified });
}

async function remove(request, bucket, key, trashRoot, name) {
    const base = baseOf(request);
    if (!base || base === "none") {
        return text(400, "X-Save-Base must be the hash of the version being deleted");
    }
    const current = await bucket.get(key);
    if (!current) {
        return json(200, { deleted: false });
    }
    const info = describe(current, name);
    if (info.hash !== base) {
        await current.body.cancel();
        return json(409, { error: "conflict", current: info });
    }
    const data = await current.arrayBuffer();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await bucket.put(trashRoot + stamp + " " + name, data, { customMetadata: current.customMetadata || {} });
    await bucket.delete(key);
    return json(200, { deleted: true });
}

/**
 * Answers a /cloud/saves request for an already verified Access identity.
 */
export async function handleSaves(request, env, identity, pathname) {
    const user = userKey(identity);
    if (!user) {
        return text(403, "Your login has no email address to keep saves under");
    }
    const root = "saves/" + user + "/files/";
    const trashRoot = "saves/" + user + "/trash/";
    const bucket = env.C3_DATA;

    if (request.method !== "GET" && request.method !== "HEAD") {
        // Forces a CORS preflight for any cross-site attempt, which this Worker never answers
        if (request.headers.get("X-Augustus-Cloud") !== "1") {
            return text(403, "Missing X-Augustus-Cloud header");
        }
    }
    if (pathname === SAVES_PREFIX || pathname === SAVES_PREFIX + "/") {
        return request.method === "GET" ? list(bucket, root, user) : text(405, "Method not allowed");
    }
    let name;
    try {
        name = decodeURIComponent(pathname.substring(SAVES_PREFIX.length + 1));
    } catch (error) {
        return text(400, "Bad name");
    }
    if (!isValidSaveName(name)) {
        return text(400, "Not a save file name");
    }
    const key = root + name;
    switch (request.method) {
        case "GET":
            return download(bucket, key, name);
        case "PUT":
            return upload(request, bucket, key, name);
        case "DELETE":
            return remove(request, bucket, key, trashRoot, name);
        default:
            return text(405, "Method not allowed");
    }
}
