# Hotpath

Hotpath is an experimental high-throughput HTTP toolkit with TypeScript DX and native/Wasm hot paths.

It lets you define routes from TypeScript, then choose the execution path that fits the deployment target: Bun native routing, a native C HTTP core, or a Wasm adapter for `fetch(request)` runtimes such as Cloudflare Workers.

## Variants

| variant | runtime | target |
| --- | --- | --- |
| `Hotpath({ adapter: "bun" })` / `FastServer` | Bun `Bun.serve()` | Lightweight Bun router |
| `Hotpath({ adapter: "c" })` / `CServer` | native C core | Fixed text/json/template routes handled outside JS |
| Wasm adapter | Workers/Bun | Wasm router behind a `fetch(request)` handler |

The C core can be much faster than Hono for routes that complete inside the native core. The Workers handler path can exceed 100k in-process calls/sec. These numbers are not interchangeable: `wrangler dev` local HTTP throughput and real Cloudflare edge throughput must be measured separately.

## Bun Native

```ts
import { Hotpath, json, template, text } from "@hotpath/server";

const app = Hotpath({ adapter: "bun", jit: true });

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true, runtime: "bun" }));
app.get("/slow/:id", async (ctx) => {
  await Bun.sleep(5);
  return ctx.json({ id: ctx.params.id, runtime: "typescript" });
});

await app.listen(3000);
```

```bash
bun run dev
```

## C Core

```ts
import { Hotpath, cors, header, headers, json, requireHeader, template, text } from "@hotpath/server";

const app = Hotpath({ adapter: "c", fallback: { jit: true, transport: "tcp" } });

app.use(cors());
app.use(header("x-powered-by", "hotpath"));
app.use(headers({ "x-content-type-options": "nosniff" }));

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true }));
app.get("/private", text("secret"), {
  middleware: [requireHeader("authorization", "Bearer bench-token")]
});
app.get("/slow/:id", async (ctx) => {
  await Bun.sleep(5);
  return ctx.json({ id: ctx.params.id, runtime: "typescript" });
});

await app.listen(3000);
await new Promise(() => {});
```

The `Hotpath()` facade keeps the common fixed-response style the same across adapters. Use `adapter: "bun"` for normal JavaScript handlers or declarative fixed replies, and `adapter: "c"` when routes must be representable as C-core metadata.

`jit: true` enables an Elysia-style route compiler for JavaScript paths. Hotpath uses `new Function(...)` to generate route-specific handlers for declarative Bun routes and TypeScript fallback wrappers. It is opt-in because it uses eval-like code generation.

`fallback.transport: "tcp"` uses a small localhost TCP protocol instead of HTTP proxying for C-to-TypeScript fallback routes. This is the cross-platform demo transport; it avoids the extra HTTP parse/serialize step while staying simpler than Unix sockets or shared memory.

With the C adapter, callback routes are supported as a slow path. Hotpath starts a local Bun fallback server and writes those routes as `PROXY` records in the C config. The C core still accepts the public HTTP request and routes it first; fixed `text/json/template` routes stay in C, while callback routes are proxied to TypeScript.

```ts
const app = Hotpath({ adapter: "c", fallback: { jit: true, transport: "tcp" } });

app.get("/health", text("ok")); // C hot path
app.get("/users/:id", async (ctx) => {
  const user = await db.user.find(ctx.params.id);
  return ctx.json(user);
}); // TypeScript fallback path
```

This is intentionally slower than C-native routes. It exists for mixed workloads where most requests are boring hot-path responses and a smaller share needs TypeScript, DB clients, or external services.

On Linux, the C core detects the physical core count and uses it as the default thread count. Override it with:

```bash
FAST_SERVER_C_THREADS=8 bun run dev:c
```

or from code:

```ts
await app.listen(3000, { threads: 8 });
```

The C core middleware API is declarative. `app.use()` and per-route `middleware` records are serialized into the native config, then evaluated in C per request. The first supported middleware set is intentionally narrow:

- `header(name, value)` and `headers(record)` for static response headers
- `cors(options?)` for static CORS response headers and native `OPTIONS` responses
- `requireHeader(name, value)` for simple token/header checks

The config format accepts both the original route TSV and the newer record-prefixed TSV. New files look like:

```text
MIDDLEWARE	HEADER	x-powered-by	hotpath
MIDDLEWARE	CORS	*	GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS		0	
ROUTE	GET	/hello/:name	200	text/plain; charset=utf-8	hello {name}
ROUTE_MIDDLEWARE	0	REQUIRE_HEADER	authorization	Bearer bench-token
```

Fields are tab-separated. Route bodies and middleware values cannot contain tabs or newlines yet.

The first fallback bridge is intentionally simple: C performs a blocking localhost HTTP proxy to the Bun fallback server for callback routes. That keeps the implementation small and makes mixed workloads possible, but it is not the final high-performance bridge design.

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

### Benchmark Philosophy

The goal is not to make every request native.
The goal is to avoid paying the JavaScript framework cost for requests that never needed JavaScript.

Hotpath does not make slow work magically fast.

It reduces overhead around that work: routing, simple middleware, fixed responses, template responses, and dispatching to the slower path only when needed.

Hono is an excellent general-purpose web framework. Hotpath explores a narrower idea: keeping TypeScript DX while moving selected hot routes out of the normal JavaScript request path.

Benchmark output should not mix incompatible measurement modes into one headline number. The supported benchmark runner reports `wrk` HTTP req/s for `c-mixed`, `hono-mixed`, and `wasm-cluster`.

Run the structured mixed benchmark:

```bash
bun run bench:mixed
```

Available benchmark targets are intentionally narrow:

```bash
bun run bench:list
```

```text
c-mixed       Hotpath native C server, C hot routes, native compiled routes, TS fallback
hono-mixed    Hono equivalent routes and middleware
wasm-cluster  Wasm adapter served by multiple Bun worker processes
```

Useful variants:

```bash
TARGETS=c-mixed,hono-mixed,wasm-cluster BENCH_PATH=/hello/rai WRK_DURATION=10s bun run bench:run
TARGETS=c-mixed,hono-mixed,wasm-cluster BENCH_PATH=/html WRK_DURATION=10s bun run bench:run
TARGETS=c-mixed BENCH_PATH=/slow-c/rai C_MIXED_WORKERS=1 FAST_SERVER_C_THREADS=4 bun run bench:run
TARGETS=c-mixed BENCH_PATH=/slow/rai C_MIXED_WORKERS=1 FAST_SERVER_C_THREADS=4 bun run bench:run
TARGETS=wasm-cluster WASM_WORKERS=6 bun run bench:run
```

Manual `wrk` shape:

```bash
wrk -t8 -c256 -d10s --latency http://127.0.0.1:3030/hello/rai
```

## Scripts

```bash
bun run typecheck
bun test
bun run bench:list
bun run bench:mixed
```

## Publishing

Canary releases are manual GitHub Actions runs:

```bash
gh workflow run publish.yml
```

Versioned releases publish from tags. The tag must match `package.json` exactly:

```bash
git tag v0.1.0
git push origin v0.1.0
```

Publishing uses npm Trusted Publishing through GitHub OIDC. Configure npm with the `Publish` workflow from `.github/workflows/publish.yml`; no `NPM_TOKEN` secret is required for the publish step.
