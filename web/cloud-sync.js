// Cloud save sync for the hosted browser build.
//
// The game always reads and writes its saves in the browser's own storage (Emscripten's IDBFS), so playing never
// waits for the network. This module copies saves between that storage and the player's cloud folder
// (/cloud/saves, see saves.js) in the background: after every save, every minute, when the network comes back and
// when the page is shown again.
//
// For each save it compares three versions by content hash: the local file, the cloud file and the "base", the version
// both sides had at the last successful sync (kept in a small file next to the saves). Whichever side changed since
// the base is copied to the other. If both changed, nothing is overwritten: the newer copy keeps the name, the other
// one is kept under "<name> (conflict <date>)", on both sides, and the player is told. A deletion is only passed on
// when the other side still has exactly the deleted version, and the cloud keeps deleted saves in a trash folder.
//
// Works in the page (window.CloudSync) and in Node for the tests (module.exports).
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.CloudSync = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    var BASE_FILE = ".augustus-cloud.json";
    var SAVE_EXTENSIONS = [".sav", ".svx", ".map"];
    var MAX_PASSES = 4;
    var PERIODIC_MS = 60 * 1000;
    var DEBOUNCE_MS = 1500;

    function isSaveName(name) {
        var lower = name.toLowerCase();
        return name.charAt(0) !== "." && SAVE_EXTENSIONS.some(function (ext) { return lower.endsWith(ext); });
    }

    // What to do with one save, given the hashes of its local, cloud and last synced versions (null when absent)
    function decide(local, remote, base) {
        if (local === remote) {
            return "none";
        }
        if (local && !remote) {
            return base === local ? "delete-local" : "upload";
        }
        if (!local && remote) {
            return base === remote ? "delete-remote" : "download";
        }
        if (base === local) {
            return "download";
        }
        if (base === remote) {
            return "upload";
        }
        return "conflict";
    }

    function pad(number) {
        return (number < 10 ? "0" : "") + number;
    }

    // "Rome.sav" -> "Rome (conflict 2026-10-11 20.24).sav", unique among the given names
    function conflictName(name, date, taken) {
        var dot = name.lastIndexOf(".");
        var stem = name.substring(0, dot).substring(0, 100);
        var ext = name.substring(dot);
        var label = "conflict " + date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
            " " + pad(date.getHours()) + "." + pad(date.getMinutes());
        var candidate = stem + " (" + label + ")" + ext;
        for (var i = 2; taken(candidate); i++) {
            candidate = stem + " (" + label + " " + i + ")" + ext;
        }
        return candidate;
    }

    function hexOf(buffer) {
        var bytes = new Uint8Array(buffer);
        var out = "";
        for (var i = 0; i < bytes.length; i++) {
            out += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
        }
        return out;
    }

    function sha256(bytes) {
        return crypto.subtle.digest("SHA-256", bytes).then(hexOf);
    }

    function SyncError(kind, message) {
        this.kind = kind; // "offline", "signed-out", "conflict" or "error"
        this.message = message;
    }

    /**
     * options.fs: { list() -> [{ name, size, mtime }], read(name) -> Uint8Array, write(name, bytes, mtime),
     *               remove(name), readText(name) -> string|null, writeText(name, text), persist() -> Promise }
     * options.fetch, options.url ("cloud/saves"), options.onStatus(state, detail), options.onNotice(message),
     * options.now() -> Date, options.isOnline() -> boolean
     */
    function create(options) {
        var fs = options.fs;
        var fetchFn = options.fetch;
        var url = options.url || "cloud/saves";
        var now = options.now || function () { return new Date(); };
        var isOnline = options.isOnline || function () { return true; };
        var onStatus = options.onStatus || function () {};
        var onNotice = options.onNotice || function () {};
        var hashCache = {};
        var running = null;
        var again = false;
        var timer = null;
        var state = "idle";
        var generation = 0;

        function setState(next, detail) {
            state = next;
            onStatus(next, detail || {});
        }

        function readBase() {
            try {
                var parsed = JSON.parse(fs.readText(BASE_FILE) || "{}");
                return parsed && typeof parsed.files === "object" && parsed.files ? parsed : { files: {} };
            } catch (e) {
                return { files: {} };
            }
        }

        function request(method, name, init) {
            init = init || {};
            init.method = method;
            init.credentials = "same-origin";
            init.cache = "no-store";
            // A login that expired is answered by Cloudflare Access with a redirect to its sign-in page
            init.redirect = "manual";
            init.headers = init.headers || {};
            if (method !== "GET") {
                init.headers["X-Augustus-Cloud"] = "1";
            }
            var target = url + (name ? "/" + encodeURIComponent(name) : "");
            return fetchFn(target, init).then(function (response) {
                if (response.type === "opaqueredirect" || response.status === 401 || response.status === 403 ||
                    (response.status >= 300 && response.status < 400)) {
                    throw new SyncError("signed-out", "Your sign-in has expired. Reload the page to sign in again.");
                }
                if (response.status === 409) {
                    throw new SyncError("conflict", "changed elsewhere");
                }
                if (!response.ok) {
                    throw new SyncError("error", "The cloud answered " + response.status);
                }
                return response;
            }, function (error) {
                if (error instanceof SyncError) {
                    throw error;
                }
                throw new SyncError("offline", "No connection to the cloud");
            });
        }

        function localHashes() {
            var files = fs.list().filter(function (file) { return isSaveName(file.name); });
            var result = {};
            return files.reduce(function (chain, file) {
                return chain.then(function () {
                    var cached = hashCache[file.name];
                    if (cached && cached.size === file.size && cached.mtime === file.mtime) {
                        result[file.name] = { hash: cached.hash, mtime: file.mtime };
                        return;
                    }
                    return sha256(fs.read(file.name)).then(function (hash) {
                        hashCache[file.name] = { size: file.size, mtime: file.mtime, hash: hash };
                        result[file.name] = { hash: hash, mtime: file.mtime };
                    });
                });
            }, Promise.resolve()).then(function () { return result; });
        }

        function download(name) {
            return request("GET", name).then(function (response) {
                var modified = Number(response.headers.get("X-Save-Modified")) || now().getTime();
                return response.arrayBuffer().then(function (buffer) {
                    return { bytes: new Uint8Array(buffer), modified: modified };
                });
            });
        }

        function writeLocal(name, file) {
            fs.write(name, file.bytes, file.modified);
            delete hashCache[name];
        }

        function upload(name, base, mtime) {
            return request("PUT", name, {
                body: fs.read(name),
                headers: { "X-Save-Base": base || "none", "X-Save-Modified": String(Math.floor(mtime)) }
            }).then(function (response) { return response.json(); });
        }

        // One comparison of every save on both sides. Resolves to true when something changed and another pass
        // should confirm that everything is now equal.
        function pass(base, notices) {
            return Promise.all([localHashes(), request("GET").then(function (r) { return r.json(); })]).then(function (both) {
                var local = both[0];
                var remote = {};
                (both[1].files || []).forEach(function (file) { remote[file.name] = file; });
                // The base belongs to one cloud account. Signed in as someone else, nothing is known to be in sync,
                // so nothing may be deleted on either side.
                if (base.user !== both[1].user) {
                    base.user = both[1].user;
                    base.files = {};
                }
                // An empty cloud folder while saves were synced before is far likelier to be a storage mishap than
                // the player deleting every save elsewhere: never let it empty this browser too.
                var cloudWiped = Object.keys(remote).length === 0 && Object.keys(base.files).length > 1;
                // The same the other way round, for example browser storage that was cleared during a sync
                var localWiped = Object.keys(local).length === 0 && Object.keys(base.files).length > 1;
                var names = {};
                [local, remote, base.files].forEach(function (set) {
                    Object.keys(set).forEach(function (name) {
                        if (isSaveName(name)) {
                            names[name] = true;
                        }
                    });
                });
                var taken = function (name) {
                    return !!(names[name] || local[name] || remote[name]);
                };
                var changed = false;
                return Object.keys(names).sort().reduce(function (chain, name) {
                    return chain.then(function () {
                        var l = local[name] ? local[name].hash : null;
                        var r = remote[name] ? remote[name].hash : null;
                        var b = base.files[name] || null;
                        var action = decide(l, r, b);
                        if (action === "delete-local" && cloudWiped) {
                            action = "upload";
                        } else if (action === "delete-remote" && localWiped) {
                            action = "download";
                        }
                        if (action === "none") {
                            if (l) {
                                base.files[name] = l;
                            } else {
                                delete base.files[name];
                            }
                            return;
                        }
                        changed = true;
                        var step;
                        switch (action) {
                            case "upload":
                                step = upload(name, r, local[name].mtime).then(function (stored) {
                                    base.files[name] = stored.hash;
                                });
                                break;
                            case "download":
                                step = download(name).then(function (file) {
                                    writeLocal(name, file);
                                    base.files[name] = r;
                                });
                                break;
                            case "delete-local":
                                fs.remove(name);
                                delete hashCache[name];
                                delete base.files[name];
                                step = Promise.resolve();
                                break;
                            case "delete-remote":
                                step = request("DELETE", name, { headers: { "X-Save-Base": r } }).then(function () {
                                    delete base.files[name];
                                });
                                break;
                            case "conflict":
                                step = download(name).then(function (cloudFile) {
                                    var copy = conflictName(name, now(), taken);
                                    names[copy] = true;
                                    var localNewer = local[name].mtime >= cloudFile.modified;
                                    if (localNewer) {
                                        // The cloud version is kept as the copy; the local one replaces it in the cloud
                                        writeLocal(copy, cloudFile);
                                        return upload(name, r, local[name].mtime).then(function (stored) {
                                            base.files[name] = stored.hash;
                                            notices.push(conflictNotice(name, copy, "this browser", "the cloud"));
                                        });
                                    }
                                    // The local version is kept as the copy; the cloud one takes its name
                                    writeLocal(copy, { bytes: fs.read(name), modified: local[name].mtime });
                                    writeLocal(name, cloudFile);
                                    base.files[name] = r;
                                    notices.push(conflictNotice(name, copy, "the cloud", "this browser"));
                                });
                                break;
                        }
                        return step.catch(function (error) {
                            // Someone else changed this save in the meantime: look again on the next pass
                            if (error instanceof SyncError && error.kind === "conflict") {
                                return;
                            }
                            throw error;
                        });
                    });
                }, Promise.resolve()).then(function () { return changed; });
            });
        }

        function conflictNotice(name, copy, newer, older) {
            return name + " was changed in two places. Kept both: the newer one (from " + newer + ") as " + name +
                ", the other (from " + older + ") as " + copy + ".";
        }

        function runOnce() {
            if (!isOnline()) {
                setState("offline", { message: "Offline, saves stay in this browser and sync later" });
                return Promise.resolve(false);
            }
            setState("syncing");
            var base = readBase();
            var startedIn = generation;
            var notices = [];
            var passes = 0;
            var wroteLocal = false;
            var loop = function () {
                passes++;
                return pass(base, notices).then(function (changed) {
                    wroteLocal = wroteLocal || changed;
                    return changed && passes < MAX_PASSES ? loop() : null;
                });
            };
            var finish = function () {
                if (startedIn !== generation) {
                    return Promise.resolve(); // the local files were reset meanwhile, what we know is stale
                }
                fs.writeText(BASE_FILE, JSON.stringify({ version: 1, user: base.user, files: base.files }));
                return fs.persist();
            };
            return loop().then(finish).then(function () {
                notices.forEach(onNotice);
                setState("synced", { at: now(), count: Object.keys(base.files).length });
                return wroteLocal;
            }, function (error) {
                // Keep what was done so far, then report
                return finish().then(function () {
                    notices.forEach(onNotice);
                    var kind = error instanceof SyncError ? error.kind : "error";
                    setState(kind === "conflict" ? "error" : kind, {
                        message: error && error.message ? error.message : String(error)
                    });
                    if (!(error instanceof SyncError)) {
                        console.error(error);
                    }
                    return false;
                });
            });
        }

        // Runs a sync now, or right after the one in progress. Resolves when the requested sync has finished.
        function sync() {
            if (running) {
                again = true;
                return running;
            }
            running = runOnce().then(function (result) {
                running = null;
                if (again) {
                    again = false;
                    return sync();
                }
                return result;
            });
            return running;
        }

        function schedule(delay) {
            if (state === "signed-out") {
                return;
            }
            clearTimeout(timer);
            timer = setTimeout(function () {
                timer = null;
                sync();
            }, delay === undefined ? DEBOUNCE_MS : delay);
        }

        function start() {
            setInterval(function () {
                if (!running && state !== "signed-out" && !(typeof document !== "undefined" && document.hidden)) {
                    sync();
                }
            }, PERIODIC_MS);
            if (typeof window !== "undefined") {
                window.addEventListener("online", function () { schedule(0); });
                window.addEventListener("offline", function () {
                    setState("offline", { message: "Offline, saves stay in this browser and sync later" });
                });
                document.addEventListener("visibilitychange", function () {
                    if (!document.hidden) {
                        schedule(0);
                    }
                });
            }
            return sync();
        }

        // The local files were deleted or replaced by the player: forget what was known to be in sync
        function forget() {
            generation++;
            hashCache = {};
        }

        return {
            forget: forget,
            start: start,
            sync: sync,
            schedule: schedule,
            get state() { return state; }
        };
    }

    return {
        BASE_FILE: BASE_FILE,
        create: create,
        decide: decide,
        conflictName: conflictName,
        isSaveName: isSaveName
    };
});
