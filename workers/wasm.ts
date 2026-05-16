import { createFastWasmFetch } from "../src/wasm";
import wasmModule from "../wasm-router/target/wasm32-unknown-unknown/release/fast_server_wasm_router.wasm";

const wasmInput = wasmModule as unknown;
const module =
  typeof wasmInput === "string"
    ? await WebAssembly.compile(await Bun.file(wasmInput).arrayBuffer())
    : (wasmInput as WebAssembly.Module);
const instance = await WebAssembly.instantiate(module, {});
const app = createFastWasmFetch({
  instance,
  cache: {
    maxEntries: 4096
  }
});

export default {
  fetch: app.fetch
};
