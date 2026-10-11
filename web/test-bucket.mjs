// In-memory stand-in for an R2 bucket binding, with the parts of the API the Worker uses.
export function memoryBucket() {
    const objects = new Map();
    let etagCounter = 0;
    const view = (key, entry) => ({
        key,
        size: entry.data.byteLength,
        etag: entry.etag,
        httpEtag: '"' + entry.etag + '"',
        uploaded: entry.uploaded,
        customMetadata: { ...entry.customMetadata }
    });
    return {
        objects,
        async list({ prefix, cursor, limit }) {
            const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
            const start = cursor ? Number(cursor) : 0;
            const slice = keys.slice(start, start + limit);
            return {
                objects: slice.map(key => view(key, objects.get(key))),
                truncated: start + limit < keys.length,
                cursor: String(start + limit)
            };
        },
        async head(key) {
            return objects.has(key) ? view(key, objects.get(key)) : null;
        },
        async get(key) {
            if (!objects.has(key)) {
                return null;
            }
            const entry = objects.get(key);
            const data = entry.data.slice(0);
            return {
                ...view(key, entry),
                body: new Blob([data]).stream(),
                arrayBuffer: async () => data
            };
        },
        async put(key, value, options = {}) {
            const current = objects.get(key);
            if (options.onlyIf && options.onlyIf.etagMatches && (!current || current.etag !== options.onlyIf.etagMatches)) {
                return null;
            }
            const data = value instanceof ArrayBuffer ? value.slice(0) : new Uint8Array(value).buffer.slice(0);
            const entry = { data, etag: "e" + (++etagCounter), uploaded: new Date(), customMetadata: options.customMetadata || {} };
            objects.set(key, entry);
            return view(key, entry);
        },
        async delete(key) {
            objects.delete(key);
        }
    };
}
