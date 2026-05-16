import { createFastWasmFetch } from "../src/wasm";

const wasmPath = "wasm-router/target/wasm32-unknown-unknown/release/fast_server_wasm_router.wasm";

if (!(await Bun.file(wasmPath).exists())) {
  const build = Bun.spawnSync([
    "cargo",
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    "wasm-router/Cargo.toml"
  ]);

  if (!build.success) {
    throw new Error(new TextDecoder().decode(build.stderr));
  }
}

const module = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
const instance = await WebAssembly.instantiate(module, {});
const app = createFastWasmFetch({ instance });

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  reusePort: process.env.REUSE_PORT === "1",
  fetch: app.fetch
});

console.log(`wasm-adapter listening on http://0.0.0.0:${process.env.PORT ?? 3000}`);
