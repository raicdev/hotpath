export type WasmAdapterOptions = {
  instance: WebAssembly.Instance | WasmExports;
  includeHeaders?: boolean;
  includeBody?: boolean;
  maxBodyBytes?: number;
  cache?: boolean | { maxEntries?: number };
};

export type WasmModuleOptions = Omit<WasmAdapterOptions, "instance"> & {
  module: WebAssembly.Module | BufferSource;
  imports?: WebAssembly.Imports;
};

export type WasmExports = {
  memory: WebAssembly.Memory;
  alloc: (size: number) => number;
  dealloc?: (ptr: number, len: number) => void;
  handle: (ptr: number, len: number) => number | bigint;
  handle_path?: (ptr: number, len: number) => number | bigint;
  response_ptr?: () => number;
  response_len?: () => number;
  response_status?: () => number;
};

export type WasmAdapter = {
  fetch: (request: Request) => Response | Promise<Response>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TEXT_RESPONSE_INIT = {
  headers: {
    "content-type": "text/plain; charset=utf-8"
  }
} satisfies ResponseInit;

export async function createWasmAdapter(options: WasmModuleOptions): Promise<WasmAdapter> {
  const module =
    options.module instanceof WebAssembly.Module
      ? options.module
      : await WebAssembly.compile(options.module);
  const instance = await WebAssembly.instantiate(module, options.imports ?? {});

  return createWasmFetch({
    ...options,
    instance
  });
}

export function createWasmFetch(options: WasmAdapterOptions): WasmAdapter {
  const exports = normalizeExports(options.instance);

  return {
    fetch: async (request) => {
      const payload = await encodeRequest(request, options);
      const requestPtr = exports.alloc(payload.byteLength);
      new Uint8Array(exports.memory.buffer, requestPtr, payload.byteLength).set(payload);

      let responsePtr = 0;
      let responseLen = 0;

      try {
        const result = exports.handle(requestPtr, payload.byteLength);
        const response = unpackHandleResult(result, exports);
        responsePtr = response.ptr;
        responseLen = response.len;

        const bytes = new Uint8Array(exports.memory.buffer, responsePtr, responseLen);
        return decodeResponse(bytes);
      } finally {
        exports.dealloc?.(requestPtr, payload.byteLength);
        if (responsePtr !== 0 && responseLen !== 0) {
          exports.dealloc?.(responsePtr, responseLen);
        }
      }
    }
  };
}

export function createFastWasmFetch(options: WasmAdapterOptions): WasmAdapter {
  const exports = normalizeExports(options.instance);
  const handlePath = exports.handle_path ?? exports.handle;
  const requestPtr = exports.alloc(2048);
  const cacheMax =
    options.cache === true ? 1024 : typeof options.cache === "object" ? (options.cache.maxEntries ?? 1024) : 0;
  const cache = cacheMax > 0 ? new Map<string, { status: number; body: Uint8Array }>() : undefined;

  return {
    fetch: (request) => {
      const cacheKey = cache ? request.method + " " + request.url : "";
      const cached = cache?.get(cacheKey);
      if (cached) {
        return responseFromBytes(cached.body, cached.status);
      }

      const len = writePathToMemory(request.url, exports.memory, requestPtr, 2048);
      const result = handlePath(requestPtr, len);
      const response = unpackHandleResult(result, exports);
      const status = exports.response_status?.() ?? 200;
      const body = new Uint8Array(exports.memory.buffer, response.ptr, response.len).slice();

      if (cache && request.method === "GET" && status === 200) {
        if (cache.size >= cacheMax) {
          const first = cache.keys().next().value;
          if (first !== undefined) cache.delete(first);
        }
        cache.set(cacheKey, { status, body });
      }

      return responseFromBytes(body, status);
    }
  };
}

function responseFromBytes(body: Uint8Array, status: number): Response {
  if (status === 200) {
    return new Response(body as BodyInit, TEXT_RESPONSE_INIT);
  }

  return new Response(body as BodyInit, {
    status,
    headers: TEXT_RESPONSE_INIT.headers
  });
}

async function encodeRequest(request: Request, options: WasmAdapterOptions): Promise<Uint8Array> {
  const url = new URL(request.url);
  let payload = `${request.method} ${url.pathname}${url.search}\n`;

  if (options.includeHeaders) {
    for (const [name, value] of request.headers) {
      payload += `${name}: ${value}\n`;
    }
    payload += "\n";
  }

  if (options.includeBody) {
    const body = new Uint8Array(await request.arrayBuffer());
    const max = options.maxBodyBytes ?? 64 * 1024;
    if (body.byteLength > max) {
      return encoder.encode(`${payload}\n`);
    }

    const head = encoder.encode(payload);
    const next = new Uint8Array(head.byteLength + body.byteLength);
    next.set(head);
    next.set(body, head.byteLength);
    return next;
  }

  return encoder.encode(payload);
}

function decodeResponse(bytes: Uint8Array): Response {
  const text = decoder.decode(bytes);
  const headerEnd = findHeaderEnd(text);
  const head = headerEnd.index === -1 ? text : text.slice(0, headerEnd.index);
  const body = headerEnd.index === -1 ? "" : text.slice(headerEnd.bodyStart);
  const lines = head.split(/\r?\n/);
  const status = parseStatus(lines[0]);
  const headers = new Headers();

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  return new Response(body, { status, headers });
}

function findHeaderEnd(text: string): { index: number; bodyStart: number } {
  const crlf = text.indexOf("\r\n\r\n");
  if (crlf !== -1) return { index: crlf, bodyStart: crlf + 4 };

  const lf = text.indexOf("\n\n");
  if (lf !== -1) return { index: lf, bodyStart: lf + 2 };

  return { index: -1, bodyStart: text.length };
}

function parseStatus(line: string | undefined): number {
  if (!line) return 500;
  if (line.startsWith("HTTP/")) {
    return Number(line.split(/\s+/, 3)[1]) || 500;
  }
  return Number(line.trim()) || 500;
}

function normalizeExports(instance: WebAssembly.Instance | WasmExports): WasmExports {
  const exports = instance instanceof WebAssembly.Instance ? instance.exports : instance;

  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new TypeError("Wasm adapter requires an exported WebAssembly.Memory named memory");
  }
  if (typeof exports.alloc !== "function") {
    throw new TypeError("Wasm adapter requires an exported alloc(size) function");
  }
  if (typeof exports.handle !== "function") {
    throw new TypeError("Wasm adapter requires an exported handle(ptr, len) function");
  }

  return exports as WasmExports;
}

function writePathToMemory(
  url: string,
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number
): number {
  const bytes = new Uint8Array(memory.buffer, ptr, cap);
  let start = 0;

  const scheme = url.indexOf("://");
  if (scheme !== -1) {
    start = url.indexOf("/", scheme + 3);
    if (start === -1) {
      bytes[0] = 47;
      return 1;
    }
  }

  let end = start;
  while (end < url.length) {
    const code = url.charCodeAt(end);
    if (code === 63 || code === 35) break;
    end += 1;
  }

  const len = Math.min(end - start, cap);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = url.charCodeAt(start + i) & 0xff;
  }

  return len;
}

function unpackHandleResult(
  result: number | bigint,
  exports: WasmExports
): { ptr: number; len: number } {
  if (typeof result === "bigint") {
    if (result === 0n && exports.response_ptr && exports.response_len) {
      return {
        ptr: exports.response_ptr(),
        len: exports.response_len()
      };
    }

    return {
      ptr: Number(result >> 32n),
      len: Number(result & 0xffffffffn)
    };
  }

  if (exports.response_ptr && exports.response_len) {
    return {
      ptr: exports.response_ptr(),
      len: exports.response_len()
    };
  }

  throw new TypeError(
    "Wasm handle() must return packed i64(ptr << 32 | len), or export response_ptr() and response_len()"
  );
}
