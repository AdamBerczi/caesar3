// Run with: node --test web/cloud-sync.test.mjs
// Two simulated browsers sync through the real Worker (with an in-memory R2 bucket).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import worker from "./worker.js";
import { memoryBucket } from "./test-bucket.mjs";

const require = createRequire(import.meta.url);
const CloudSync = require("./cloud-sync.js");

function memoryFs(clock) {
    const files = new Map();
    return {
        files,
        put(name, text, mtime = clock.now()) {
            files.set(name, { bytes: new TextEncoder().encode(text), mtime });
        },
        text(name) {
            return files.has(name) ? new TextDecoder().decode(files.get(name).bytes) : null;
        },
        list() {
            return [...files].map(([name, file]) => ({ name, size: file.bytes.length, mtime: file.mtime }));
        },
        read(name) {
            return files.get(name).bytes;
        },
        write(name, bytes, mtime) {
            files.set(name, { bytes: new Uint8Array(bytes), mtime: mtime || clock.now() });
        },
        remove(name) {
            files.delete(name);
        },
        readText(name) {
            return this.text(name);
        },
        writeText(name, text) {
            this.put(name, text);
        },
        async persist() {}
    };
}

function setup() {
    let time = Date.UTC(2026, 9, 11, 12, 0, 0);
    const clock = { now: () => (time += 1000) };
    const bucket = memoryBucket();
    const env = { ALLOW_PUBLIC_DATA: "true", C3_DATA: bucket, ASSETS: { fetch: async () => new Response("static") } };
    let online = true;
    const browser = () => {
        const fs = memoryFs(clock);
        const notices = [];
        const states = [];
        const engine = CloudSync.create({
            fs,
            url: "cloud/saves",
            fetch: async (target, init) => {
                if (!online) {
                    throw new TypeError("Failed to fetch");
                }
                return worker.fetch(new Request("https://augustus.example/" + target, init), env);
            },
            now: () => new Date(clock.now()),
            isOnline: () => online,
            onNotice: message => notices.push(message),
            onStatus: state => states.push(state)
        });
        return { fs, engine, notices, states, sync: () => engine.sync() };
    };
    const cloudNames = () => [...bucket.objects.keys()].filter(key => key.includes("/files/")).map(key => key.split("/files/")[1]).sort();
    const trashCount = () => [...bucket.objects.keys()].filter(key => key.includes("/trash/")).length;
    return { browser, bucket, cloudNames, trashCount, setOnline: value => { online = value; } };
}

test("decide covers every case", () => {
    const d = CloudSync.decide;
    assert.equal(d("a", "a", null), "none");
    assert.equal(d(null, null, "a"), "none");
    assert.equal(d("a", null, null), "upload");
    assert.equal(d("a", null, "a"), "delete-local");
    assert.equal(d("b", null, "a"), "upload");
    assert.equal(d(null, "a", null), "download");
    assert.equal(d(null, "a", "a"), "delete-remote");
    assert.equal(d(null, "b", "a"), "download");
    assert.equal(d("a", "b", "a"), "download");
    assert.equal(d("a", "b", "b"), "upload");
    assert.equal(d("a", "b", null), "conflict");
    assert.equal(d("a", "b", "c"), "conflict");
});

test("conflict names are readable and unique", () => {
    const date = new Date(2026, 9, 11, 20, 4);
    const taken = new Set(["Rome (conflict 2026-10-11 20.04).sav"]);
    assert.equal(CloudSync.conflictName("Rome.sav", date, () => false), "Rome (conflict 2026-10-11 20.04).sav");
    assert.equal(CloudSync.conflictName("Rome.sav", date, name => taken.has(name)), "Rome (conflict 2026-10-11 20.04 2).sav");
});

test("a save made on one device appears on another, and changes travel both ways", async () => {
    const { browser, cloudNames } = setup();
    const a = browser(), b = browser();
    a.fs.put("Rome.sav", "v1");
    a.fs.put("augustus.ini", "settings stay local");
    await a.sync();
    assert.deepEqual(cloudNames(), ["Rome.sav"]);
    await b.sync();
    assert.equal(b.fs.text("Rome.sav"), "v1");
    assert.equal(b.fs.text("augustus.ini"), null);

    b.fs.put("Rome.sav", "v2");
    await b.sync();
    await a.sync();
    assert.equal(a.fs.text("Rome.sav"), "v2");
    assert.deepEqual(a.notices, []);
    assert.equal(a.states.at(-1), "synced");
});

test("editing on two devices before syncing keeps both copies, newest under the original name", async () => {
    const { browser, cloudNames } = setup();
    const a = browser(), b = browser();
    a.fs.put("Rome.sav", "v1");
    await a.sync();
    await b.sync();
    a.fs.put("Rome.sav", "from a");
    b.fs.put("Rome.sav", "from b (newer)");
    await a.sync();
    await b.sync();
    await a.sync();
    const names = cloudNames();
    assert.equal(names.length, 2);
    const copy = names.find(name => name !== "Rome.sav");
    assert.match(copy, /^Rome \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)\.sav$/);
    for (const device of [a, b]) {
        assert.equal(device.fs.text("Rome.sav"), "from b (newer)");
        assert.equal(device.fs.text(copy), "from a");
    }
    assert.equal(b.notices.length, 1);
    assert.match(b.notices[0], /Kept both/);
});

test("when the local copy is the newer one it wins the name, and the cloud copy is kept", async () => {
    const { browser } = setup();
    const a = browser(), b = browser();
    a.fs.put("Rome.sav", "v1");
    await a.sync();
    await b.sync();
    b.fs.put("Rome.sav", "from b");
    await b.sync();
    a.fs.put("Rome.sav", "from a (newer)");
    await a.sync();
    const copy = [...a.fs.files.keys()].find(name => name.startsWith("Rome (conflict"));
    assert.equal(a.fs.text("Rome.sav"), "from a (newer)");
    assert.equal(a.fs.text(copy), "from b");
    await b.sync();
    assert.equal(b.fs.text("Rome.sav"), "from a (newer)");
    assert.equal(b.fs.text(copy), "from b");
});

test("deleting a save passes on, and the cloud keeps it in the trash", async () => {
    const { browser, cloudNames, trashCount } = setup();
    const a = browser(), b = browser();
    a.fs.put("Rome.sav", "v1");
    a.fs.put("Carthage.sav", "c");
    await a.sync();
    await b.sync();
    a.fs.remove("Rome.sav");
    await a.sync();
    assert.deepEqual(cloudNames(), ["Carthage.sav"]);
    assert.equal(trashCount(), 1);
    await b.sync();
    assert.equal(b.fs.text("Rome.sav"), null);
    assert.equal(b.fs.text("Carthage.sav"), "c");
});

test("a save changed on one device survives being deleted on another", async () => {
    const { browser } = setup();
    const a = browser(), b = browser();
    a.fs.put("Rome.sav", "v1");
    a.fs.put("Carthage.sav", "c");
    await a.sync();
    await b.sync();
    a.fs.remove("Rome.sav");
    b.fs.put("Rome.sav", "v2");
    await a.sync(); // cloud copy goes to trash
    await b.sync(); // b's newer edit is uploaded again
    await a.sync();
    assert.equal(a.fs.text("Rome.sav"), "v2");
});

test("offline saves stay local and upload once the network is back", async () => {
    const { browser, cloudNames, setOnline } = setup();
    const a = browser();
    setOnline(false);
    a.fs.put("Rome.sav", "v1");
    await a.sync();
    assert.equal(a.states.at(-1), "offline");
    assert.deepEqual(cloudNames(), []);
    setOnline(true);
    await a.sync();
    assert.deepEqual(cloudNames(), ["Rome.sav"]);
});

test("a failed upload keeps the local save and reports, then succeeds later", async () => {
    const { browser, cloudNames, bucket } = setup();
    const a = browser();
    const put = bucket.put;
    bucket.put = async () => { throw new Error("R2 is down"); };
    a.fs.put("Rome.sav", "v1");
    await a.sync();
    assert.equal(a.states.at(-1), "error");
    assert.equal(a.fs.text("Rome.sav"), "v1");
    bucket.put = put;
    await a.sync();
    assert.deepEqual(cloudNames(), ["Rome.sav"]);
});

test("an emptied cloud folder never empties the browser", async () => {
    const { browser, bucket, cloudNames } = setup();
    const a = browser();
    a.fs.put("Rome.sav", "v1");
    a.fs.put("Carthage.sav", "c");
    await a.sync();
    bucket.objects.clear();
    await a.sync();
    assert.equal(a.fs.text("Rome.sav"), "v1");
    assert.deepEqual(cloudNames(), ["Carthage.sav", "Rome.sav"]);
});

test("deleting all local files brings the cloud saves back instead of deleting them", async () => {
    const { browser, cloudNames } = setup();
    const a = browser();
    a.fs.put("Rome.sav", "v1");
    a.fs.put("Carthage.sav", "c");
    await a.sync();
    a.engine.forget();
    a.fs.files.clear(); // "Delete all files" also removes the sync record
    await a.sync();
    assert.deepEqual(cloudNames(), ["Carthage.sav", "Rome.sav"]);
    assert.equal(a.fs.text("Rome.sav"), "v1");
});

test("an expired login pauses syncing without touching local files", async () => {
    const { browser } = setup();
    const a = browser();
    a.fs.put("Rome.sav", "v1");
    const engine = CloudSync.create({
        fs: a.fs,
        fetch: async () => new Response(null, { status: 302, headers: { Location: "https://team.cloudflareaccess.com/" } }),
        onStatus: state => a.states.push(state)
    });
    await engine.sync();
    assert.equal(a.states.at(-1), "signed-out");
    assert.equal(a.fs.text("Rome.sav"), "v1");
});
