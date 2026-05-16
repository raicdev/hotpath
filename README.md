# Hotpath

TypeScript DXでルートを定義し、用途に応じてBun native / C core / Wasm adapterを使い分ける実験的な高速HTTPサーバーです。

## Variants

| variant | runtime | target |
| --- | --- | --- |
| `HotpathServer` / `FastServer` | Bun `Bun.serve()` | Bun上の軽量router |
| `CServer` | native C core | 固定text/json/templateをサーバー側で完結 |
| `RustServer` | Rust core | 検証用native core |
| Wasm adapter | Workers/Bun | `fetch(request)`環境でWasm routerを呼ぶ |

C coreはHonoより大幅に速い条件があります。Workers handler内部処理も100k calls/secを超えます。ただし、`wrangler dev`のローカルHTTPサーバーや本番edgeのHTTP込み性能は別に測る必要があります。

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

C coreはデフォルトでLinuxの物理コア数を検知して`--threads`に使います。上書きする場合:

```bash
FAST_SERVER_C_THREADS=8 bun run dev:c
```

または:

```ts
await app.listen(3000, { threads: 8 });
```

## Workers / Wasm

WorkersではC core、`pthread`、`epoll`、`SO_REUSEPORT`は使えません。代わりに`fetch(request)`からWasm routerを呼びます。

```ts
import wasmModule from "./router.wasm";
import { createFastWasmFetch } from "@hotpath/server/wasm";

const instance = await WebAssembly.instantiate(wasmModule, {});
const app = createFastWasmFetch({ instance, cache: { maxEntries: 4096 } });

export default {
  fetch: app.fetch
};
```

高速Wasm ABI:

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

互換ABIもあります:

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

The `wrangler dev` number is not an edge benchmark. It measures the local dev server path.

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
