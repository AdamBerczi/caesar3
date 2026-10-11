# Augustus on Cloudflare (hosted web build)

A hosted, embeddable build of Augustus. The game itself (html, js, wasm, packed Augustus assets) is public static
content. The original Caesar III files are **never** part of this repository or of the build: they sit in a private R2
bucket and are only handed out to a signed-in owner (Cloudflare Access).

```
browser ──► Worker "augustus" ──► static build (web/dist)            public
                              └─► /c3data/*  ──► R2 bucket c3/...    only with a valid Access login
```

* `gen/shell.html.in` is the page around the game. In the hosted build (`-DEMSCRIPTEN_HOSTED=ON`) it downloads the
  game files from `/c3data/` into the browser's IndexedDB the first time, then reuses them. If that is unavailable the
  player can still pick the Caesar III folder or a zip by hand, exactly as in the upstream build.
* `web/worker.js` serves the static build and the game data, `web/access.js` checks the Access login token.
* **Cloud saves**: `web/saves.js` (the `/cloud/saves` API) and `web/cloud-sync.js` (the page side), see below.
* The canvas fills the page and follows every resize, so a host page can resize the frame freely.

## One-time setup

1. **Enable Actions** on the fork: GitHub > Actions tab > "I understand my workflows, go ahead and enable them".
2. **R2 bucket**: Cloudflare dashboard > R2 > create the bucket `augustus-c3-data` (private, the default).
3. **API token**: My Profile > API Tokens > Create Token > template "Edit Cloudflare Workers", plus the permission
   Account > Workers R2 Storage > Edit. Add two repository secrets (Settings > Secrets and variables > Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. **First deploy**: run the "Web build (Cloudflare)" workflow (Actions > Run workflow). The site appears at
   `https://augustus.<your-subdomain>.workers.dev`.
5. **Cloudflare Access**: Zero Trust > Access > Applications > add a self-hosted application for that hostname, with a
   policy that allows only you. Copy the application's *Audience (AUD) tag* and your team domain
   (`yourteam.cloudflareaccess.com`) into `[vars]` of `web/wrangler.toml` and push. Until both are set, the game data
   route answers 503 on purpose, so the data can never be served unprotected by mistake.
6. **Upload the game data** (the installed folder, without videos, from your own PC):

   ```powershell
   .\web\upload-game-data.ps1 -Source "C:\GOG Games\Caesar 3"
   ```

   or `web/upload-game-data.sh "/path/to/Caesar 3"` on macOS/Linux. It uploads everything except the `SMK` videos,
   executables and installer leftovers, into `c3/` in the bucket. Re-run it any time; files are overwritten.

Open the site: the first start downloads the files (a few minutes at most, shown with a progress bar), every later
start is local. "Re-download game data" on the start screen repairs a damaged copy; saves are never touched by it.

## Cloud saves

Saved games (`.sav`, `.svx`, `.map` in the game folder) follow the player across browsers and devices. Settings
(`augustus.ini`, `c3.inf`) stay per browser, since they hold things like the window layout.

* The game only ever reads and writes the browser's own copy, so saving is instant and works offline. The page syncs
  in the background: a moment after every save, every minute, when the network comes back and when the tab is shown.
* Each player's saves live in the same private bucket under `saves/<access email>/files/`. The folder comes from
  the verified Access login, so nobody can reach another player's saves.
* Sync compares content hashes with the version both sides had last time (kept in `.augustus-cloud.json` next to
  the saves). A change on one side is copied to the other. If a save was changed in two places, **both are kept**:
  the newer one under the original name, the other as `<name> (conflict <date>).sav`, and the page shows a notice.
* A deleted save is deleted on the other devices too, but the cloud copy moves to `saves/<email>/trash/`, from where
  it can be restored in the R2 dashboard. "Delete all files" on the start screen only clears this browser: the cloud
  saves come back on the next sync.
* An expired login pauses syncing (the start screen says so) until the page is reloaded. Nothing local is touched.
* "Download Saves" / "Import Saves" work as before; imported saves are uploaded like any other.

API (all behind Access): `GET /cloud/saves` lists, `GET|PUT|DELETE /cloud/saves/<name>` with `X-Save-Base: <hash of
the version last seen | none>`; a mismatch answers 409, so an outdated browser can never overwrite a newer save.

## Embedding

Put the site in an `<iframe allow="fullscreen" src="https://augustus.<subdomain>.workers.dev/">` and resize the
iframe element freely (do not CSS-scale it). The page only talks to hosts under `*.adam-berczi.workers.dev` and
localhost (see `HostBridge.trusted` in `gen/shell.html.in`; the same list is in the `frame-ancestors` rule in
`web/_headers`). Messages, all with `type` prefixed by `augustus:`:

| Direction | Message | Meaning |
| --- | --- | --- |
| host → game | `pause` / `resume` | stop or restart the game clock, audio and frame loop (minimize/restore) |
| host → game | `focus` | give the game keyboard focus |
| host → game | `flush` | write saves to browser storage now; answered by `flushed` `{ ok }` before closing |
| game → host | `hello` `{ version }` | the bridge is ready |
| game → host | `state` `{ state }` | `ready`, `running`, `quit`, `needs-data` or `busy` (open in another tab) |
| game → host | `cloud` `{ state, message }` | cloud save sync: `syncing`, `synced`, `offline`, `signed-out` or `error` |

Cloudflare Access's sign-in page refuses to be framed (`X-Frame-Options: DENY`), so the frame only works once the
browser holds a login for this hostname. A host page should treat a missing `hello` as "not signed in" and offer to
open the game in a new tab to sign in, then reload the frame (the homepage window does this).

## Local development

```sh
source emsdk/emsdk_env.sh && export EMSDK=$PWD/emsdk
./.ci_scripts/pack_assets.sh
mkdir build && cd build && cmake -DCMAKE_BUILD_TYPE=Release -DTARGET_PLATFORM=emscripten -DEMSCRIPTEN_HOSTED=ON ..
make -j4
node --test web/worker.test.mjs web/cloud-sync.test.mjs     # Worker, Access token and cloud save sync checks
```

The stock single-file build (`-DEMSCRIPTEN_HOSTED=OFF`, the default) is unchanged apart from the resizing and
save-safety improvements in the shell.
