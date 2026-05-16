# Hotpath

Hotpath is an experimental high-throughput HTTP toolkit with TypeScript DX and native/Wasm hot paths.

It lets you define routes from TypeScript, then choose the execution path that fits the deployment target: Bun native routing, a native C HTTP core, or a Wasm adapter for `fetch(request)` runtimes such as Cloudflare Workers.

## Variants

| variant | runtime | target |
| --- | --- | --- |
| `HotpathServer` / `FastServer` | Bun `Bun.serve()` | Lightweight Bun router |
| `CServer` | native C core | Fixed text/json/template routes handled outside JS |
| `RustServer` | Rust core | Experimental native core |
| Wasm adapter | Workers/Bun | Wasm router behind a `fetch(request)` handler |

The C core can be much faster than Hono for routes that complete inside the native core. The Workers handler path can exceed 100k in-process calls/sec. These numbers are not interchangeable: `wrangler dev` local HTTP throughput and real Cloudflare edge throughput must be measured separately.

## Bun Native

```ts
import { HotpathServer } from "@hotpath/server";

const app = new HotpathServer();

app.get("/", (c) => c.text("ok"));
app.get("/users/:id", (c) => c.json({ id: c.params.id }));

app.listen(3000);
```

```bash
bun run dev
```

## C Core

```ts
import { CServer, json, template, text } from "@hotpath/server/c";

const app = new CServer();

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true }));

await app.listen(3000);
await new Promise(() => {});
```

On Linux, the C core detects the physical core count and uses it as the default thread count. Override it with:

```bash
FAST_SERVER_C_THREADS=8 bun run dev:c
```

or from code:

```ts
await app.listen(3000, { threads: 8 });
```

## Workers / Wasm

Cloudflare Workers cannot run the C core, `pthread`, `epoll`, or `SO_REUSEPORT`. Use the Wasm adapter instead:

```ts
import wasmModule from "./router.wasm";
import { createFastWasmFetch } from "@hotpath/server/wasm";

const instance = await WebAssembly.instantiate(wasmModule, {});
const app = createFastWasmFetch({ instance, cache: { maxEntries: 4096 } });

export default {
  fetch: app.fetch
};
```

Fast Wasm ABI:

```text
exports:
  memory
  alloc(size: i32) -> i32
  handle_path(ptr: i32, len: i32) -> i64
  response_ptr() -> i32
  response_len() -> i32
  response_status() -> i32

request bytes:
  "/hello/rai"

response:
  body bytes + response_status()
```

Compatibility ABI:

```text
handle(ptr, len) receives:
  "GET /hello/rai?x=1\n"

returns response bytes:
  "200\ncontent-type: text/plain; charset=utf-8\n\nhello rai"
```

## Benchmarks

Representative local numbers from this WSL2 machine:

```text
C core, 6 threads, /hello/rai:
~178k req/s, timeout 0

C core, 8 threads, peak /hello/rai:
~206k req/s, with occasional timeout under high load

Hono, same wrk shape:
~14k req/s

Workers handler direct call:
~557k calls/sec

wrangler dev local HTTP:
~1.3k req/s
```

The `wrangler dev` number is not an edge benchmark. It measures the local development server path.

Run a structured benchmark:

```bash
bun run bench:run
```

Useful variants:

```bash
TARGETS=c-core,hono WRK_DURATION=10s bun run bench:run
TARGETS=wasm-cluster,hono WASM_WORKERS=6 bun run bench:run
bun run bench:workers-call
```

Manual C core test:

```bash
./core-c/fast-server-c --host 0.0.0.0 --port 3030 --threads 6 --config bench/c-core.tsv
wrk -t8 -c256 -d10s --latency http://127.0.0.1:3030/hello/rai
```

Local Workers runtime:

```bash
wrangler dev --local --ip 127.0.0.1 --port 8787 --log-level error --show-interactive-dev-session false
```

## Scripts

```bash
bun run typecheck
bun test
bun run bench:fast
bun run bench:c
bun run bench:wasm
bun run bench:wasm-cluster
bun run bench:workers-call
bun run bench:hono
```
