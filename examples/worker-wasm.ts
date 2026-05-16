import { createWasmAdapter } from "../src/wasm";

export async function createWorker(
  wasmModule: WebAssembly.Module
): Promise<{ fetch: (request: Request) => Response | Promise<Response> }> {
  const app = await createWasmAdapter({ module: wasmModule });

  return {
    fetch: app.fetch
  };
}
