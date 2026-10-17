/* Exercise the production preview without SDL or the original game assets. */
#include "widget/city/building_ghost.c"

static building_properties test_properties = { .size = 1 };
static model_building test_model = { .cost = 40 };

const building_properties *building_properties_for_type(building_type type)
{
    return &test_properties;
}

model_building *model_get_building(building_type type)
{
    test_model.cost = type == BUILDING_SHIP_BRIDGE ? 100 : 40;
    return &test_model;
}

static building_type test_bridge_type(int ship)
{
    return ship ? BUILDING_SHIP_BRIDGE : BUILDING_LOW_BRIDGE;
}

void test_select_bridge(int ship)
{
    building_construction_set_type(test_bridge_type(ship), 0);
    /* button_menu_item clears the cursor before returning to WINDOW_CITY. */
    map_tile tile = { 0 };
    city_building_ghost_draw(&tile);
}

void test_hover_bridge(int x, int y)
{
    map_tile tile = { x, y, map_grid_offset(x, y) };
    city_building_ghost_draw(&tile);
}

void test_terrain(int water, int blocked)
{
    map_grid_init(160, 160, GRID_SIZE + 1, 2);
    map_terrain_clear();
    if (water) {
        for (int y = 20; y < 26; y++) {
            for (int x = 0; x < 160; x++) {
                map_terrain_set(map_grid_offset(x, y), TERRAIN_WATER);
            }
        }
    }
    if (blocked) {
        map_terrain_add(map_grid_offset(40, 19), TERRAIN_TREE);
    }
}
