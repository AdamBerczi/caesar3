# Bridge preview regression

Run with a WASI SDK clang, Python 3 and Node.js:

```sh
python tests/run_bridge_preview.py --cc /path/to/wasi-sdk/bin/clang --node node
```

This compiles the actual construction selection, ghost renderer, bridge
measurement/sprite code, grid and terrain into WASM with a 64 KiB stack. Only
presentation and unrelated game services are mocked; unexpected service calls
fail. Both bridge tools are exercised at `-O0`, `-O2` and `-O3`. The preview
translation unit also rejects stack frames larger than 16 KiB. The tests cover
selection with no cursor tile, the first dry-land hover without a map click,
valid shore previews, a blocked bank, clearing blockers between frames, and
returning to invalid land after a valid preview. They do not place bridges.

For the same tests in a browser, after running the command:

```sh
python -m http.server 8766 --bind 127.0.0.1 --directory build-bridge-tests
```

Open `http://127.0.0.1:8766/` and click **Run both bridge tools**.
This is an isolated production-code WASM test, not the full SDL application.

## Freeze investigation

The deployed build identified itself as `v4.0.0-20261011-8d7ef7fbd`. In Edge,
load `Capua.svx`, pause, open Engineering, then select Low Bridge or Ship Bridge.
Both freeze before clicking the map; pressing P afterward does not resume the
city. No error/warning was emitted in the captured browser console.

The click path is:

1. `src/window/build_menu.c:button_menu_item()` clears the current cursor tile
   (`grid_offset = 0`), selects the type with
   `building_construction_set_type(type, 0)`, and closes the submenu.
2. `building_construction_set_type()` resets construction coordinates, cost and
   in-progress state, and checks rotation support. It does not measure/place a
   bridge or walk the map.
3. `window_city_show()` installs the city window using `window_show()`, which
   resets input and invalidates the view.
4. The city foreground calls `window_city_draw()` -> `widget_city_draw()` ->
   `city_draw()` -> `city_building_ghost_draw()`. A zero cursor offset skips the
   ghost. Once `handle_mouse()` -> `update_city_view_coords()` resolves the cursor
   to a city tile (including the tile underneath the closed menu), the ghost
   dispatches either bridge type to `draw_bridge()`. No map click is needed.
5. `draw_bridge()` allocated a `grid_slice` on the stack before calling
   `map_bridge_calculate_length_direction()`. The slice alone is
   `(162 * 162 + 1) * sizeof(int) = 104,980` bytes. WASI clang reports a
   104,992-byte frame at `-O2`/`-O3`, exceeding Emscripten's
   [default 64 KiB stack](https://emscripten.org/docs/tools_reference/settings_reference.html#stack-size);
   the project does not override that stack size. Even a dry-land preview
   allocates/initializes it before terrain rejection.

Compiling the original source into the regression module produces
`RuntimeError: memory access out of bounds` in `draw_bridge()` independently for
each tool. Moving the scratch slice to static storage and resetting only
`size` each invocation makes both tests pass in Node and Edge, with no browser
console errors. This also avoids zeroing the whole slice every frame.

The bridge measurement loop is capped at 64 iterations, ghost sprite loops are
bounded by the resulting length, and `map_terrain_is()` validates offsets before
indexing its grid. No unbounded loop is needed to explain this failure: the
first invalid memory access is stack exhaustion. Span limits, bank validation,
sprite selection, placement and routing are unchanged.

The isolated test does not replace the full hosted smoke test. After deploying
the SDL/Emscripten build, repeat the menu selection steps above for both tools
and check that P still resumes/pauses the game before clicking the map.
