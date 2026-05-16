import { describe, expect, test } from "bun:test";
import { createWasmFetch, type WasmExports } from "../src/wasm";

function createMockWasm(): WasmExports {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let cursor = 1024;
  let lastResponsePtr = 0;
  let lastResponseLen = 0;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return {
    memory,
    alloc(size) {
      const ptr = cursor;
      cursor += size + 8;
      return ptr;
    },
    handle(ptr, len) {
      const request = decoder.decode(new Uint8Array(memory.buffer, ptr, len));
      const [, target] = request.split(/\s+/, 2);
      const name = target?.startsWith("/hello/") ? target.slice("/hello/".length).trim() : "";
      const response = encoder.encode(
        name
          ? `200\ncontent-type: text/plain; charset=utf-8\n\nhello ${name}`
          : "404\ncontent-type: text/plain; charset=utf-8\n\nNot Found"
      );

      lastResponsePtr = this.alloc(response.byteLength);
      lastResponseLen = response.byteLength;
      new Uint8Array(memory.buffer, lastResponsePtr, lastResponseLen).set(response);
      return 0;
    },
    response_ptr() {
      return lastResponsePtr;
    },
    response_len() {
      return lastResponseLen;
    }
  };
}

describe("Wasm adapter", () => {
  test("calls wasm exports from a fetch handler", async () => {
    const app = createWasmFetch({ instance: createMockWasm() });

    const res = await app.fetch(new Request("https://worker.test/hello/rai"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("hello rai");
  });

  test("returns wasm generated 404 responses", async () => {
    const app = createWasmFetch({ instance: createMockWasm() });

    const res = await app.fetch(new Request("https://worker.test/missing"));

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });
});
