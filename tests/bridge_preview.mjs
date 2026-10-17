export async function runBridgePreview(bytes, assert, report) {
    const module = await WebAssembly.compile(bytes);
    let instance;
    let sprites = [];
    let blockedTiles = [];
    // Only presentation and unrelated game services are mocked. Construction
    // selection, ghost dispatch, bridge measurement, sprites, grid and terrain are C.
    const services = {
        scroll_in_progress: () => 0,
        config_get: () => 0,
        city_view_get_scale: () => 100,
        city_view_get_selected_tile_pixels: () => {},
        city_view_orientation: () => 0,
        building_rotation_remove_rotation: () => {},
        building_rotation_type_has_rotations: () => 0,
        city_finance_out_of_money: () => 0,
        image_blend_footprint_color: () => {},
        city_draw_bridge_tile: (x, y, scale, sprite) => sprites.push(sprite),
        city_view_foreach_tile_in_range: offset => blockedTiles.push(offset),
    };
    const imports = {};
    for (const { module: namespace, name } of WebAssembly.Module.imports(module)) {
        (imports[namespace] ??= {})[name] = (...args) => {
            assert.ok(instance.exports.__stack_pointer.value >= 1024,
                `${name}: preview exceeded the 64 KiB WASM stack`);
            assert.ok(Object.hasOwn(services, name), `unexpected service: ${name}`);
            return services[name](...args);
        };
    }
    instance = await WebAssembly.instantiate(module, imports);
    const api = instance.exports;
    for (const ship of [0, 1]) {
        const label = ship ? 'Ship Bridge' : 'Low Bridge';
        api.test_terrain(0, 0);
        api.test_select_bridge(ship); // no map click, no hovered tile yet
        api.test_hover_bridge(40, 19); // first hover on dry land
        assert.equal(api.map_bridge_building_length(), 0);
        assert.equal(api.building_construction_cost(), 0);
        assert.deepEqual(sprites, []);
        api.test_terrain(1, 1);
        api.test_hover_bridge(40, 20);
        assert.equal(api.map_bridge_building_length(), 6);
        assert.equal(sprites.length, 6);
        assert.equal(blockedTiles.length, 1);
        sprites = [];
        blockedTiles = [];
        api.test_terrain(1, 0);
        api.test_hover_bridge(40, 20); // scratch blockers must reset each frame
        assert.equal(api.map_bridge_building_length(), 6);
        assert.equal(api.building_construction_cost(), (ship ? 100 : 40) * 6);
        assert.equal(sprites.length, 6);
        assert.deepEqual(blockedTiles, []);
        sprites = [];
        api.test_hover_bridge(40, 19); // valid preview followed by invalid hover
        assert.equal(api.map_bridge_building_length(), 0);
        assert.equal(api.building_construction_cost(), 0);
        assert.deepEqual(sprites, []);
        report(`PASS: ${label} selection, land, shore, blocker reset, invalid hover`);
    }
}

if (typeof process !== 'undefined' && process.argv[2]) {
    const { default: assert } = await import('node:assert/strict');
    const { readFileSync } = await import('node:fs');
    await runBridgePreview(readFileSync(process.argv[2]), assert, console.log);
}
