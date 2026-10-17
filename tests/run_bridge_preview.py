"""Build the production bridge preview with a 64 KiB WASM stack and run it.

Requires a WASI SDK clang and Node.js. No SDL, game assets or Python packages.
"""
import argparse
from pathlib import Path
import shutil
import subprocess


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--cc", default="clang", help="WASI SDK clang executable")
parser.add_argument("--node", default="node", help="Node.js executable")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
build = root / "build-bridge-tests"
build.mkdir(exist_ok=True)
sources = ["src/building/construction.c", "src/map/bridge.c",
           "src/map/grid.c", "src/map/terrain.c"]
exports = ["test_select_bridge", "test_hover_bridge", "test_terrain",
           "building_construction_cost", "map_bridge_building_length", "__stack_pointer"]
for optimization in ("-O0", "-O2", "-O3"):
    output = build / "bridge-preview.wasm"
    preview = build / "preview.o"
    subprocess.run([args.cc, optimization, "-Isrc", "-ffunction-sections", "-fdata-sections",
                    "-Wframe-larger-than=16384", "-Werror=frame-larger-than",
                    "-c", "tests/bridge_preview.c", "-o", str(preview)],
                   cwd=root, check=True, timeout=60)
    subprocess.run([args.cc, optimization, "-Isrc", "-ffunction-sections", "-fdata-sections",
                    "-nostartfiles", str(preview), *sources, "-Wl,--no-entry", "-Wl,--allow-undefined",
                    "-Wl,--stack-first", "-Wl,-z,stack-size=65536",
                    *(f"-Wl,--export={name}" for name in exports), "-o", str(output)],
                   cwd=root, check=True, timeout=60)
    print(optimization, flush=True)
    subprocess.run([args.node, str(root / "tests/bridge_preview.mjs"), str(output)],
                   cwd=root, check=True, timeout=10)
shutil.copyfile(root / "tests/bridge_preview.mjs", build / "bridge_preview.mjs")
(build / "index.html").write_text('''<!doctype html>
<meta charset="utf-8"><title>Bridge preview regression</title>
<h1>Bridge preview regression — 64 KiB WASM stack</h1>
<button id="run">Run both bridge tools</button><pre id="output"></pre>
<script type="module">
import { runBridgePreview } from './bridge_preview.mjs';
const output = document.querySelector('#output');
const assert = {
  ok(value, message) { if (!value) throw Error(message); },
  equal(a, b) { this.ok(a === b, `${a} !== ${b}`); },
  deepEqual(a, b) { this.equal(JSON.stringify(a), JSON.stringify(b)); }
};
document.querySelector('#run').onclick = async () => {
  output.textContent = '';
  try {
    const bytes = await (await fetch('./bridge-preview.wasm')).arrayBuffer();
    await runBridgePreview(bytes, assert, line => output.textContent += line + '\\n');
  } catch (error) { output.textContent += error.stack; console.error(error); }
};
</script>''', encoding="utf-8")
