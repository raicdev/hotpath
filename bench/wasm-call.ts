import { createFastWasmFetch } from "../src/wasm";

const wasmPath = "wasm-router/target/wasm32-unknown-unknown/release/fast_server_wasm_router.wasm";
const module = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
const instance = await WebAssembly.instantiate(module, {});
const app = createFastWasmFetch({ instance });
const req = new Request("https://worker.test/hello/rai");
const iterations = Number(process.env.ITERATIONS ?? 100_000);

for (let i = 0; i < 1_000; i += 1) {
  await app.fetch(req);
}

const started = performance.now();
for (let i = 0; i < iterations; i += 1) {
  const res = await app.fetch(req);
  await res.text();
}
const elapsed = performance.now() - started;

console.log(`${iterations} calls in ${elapsed.toFixed(2)} ms`);
console.log(`${Math.round((iterations / elapsed) * 1000).toLocaleString()} calls/sec`);
