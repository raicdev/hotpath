# Hotpath Benchmarks

All HTTP benchmark comparisons should go through `bench/run.ts`, which uses `wrk`
and writes JSON results to `bench/results/`.

List available targets:

```bash
TARGETS=list bun run bench:run
```

Targets:

```text
c-mixed       Hotpath native C server, C hot routes, native compiled routes, TS fallback
hono-mixed    Hono equivalent routes and middleware
wasm-cluster  Wasm adapter served by multiple Bun worker processes
```

Common runs:

```bash
# All supported mixed targets
bun run bench:mixed

# C hot route vs Hono equivalent vs Wasm
TARGETS=c-mixed,hono-mixed,wasm-cluster BENCH_PATH=/hello/rai bun run bench:run

# C native compiled JSON route vs TypeScript fallback route
TARGETS=c-mixed BENCH_PATH=/slow-c/rai C_MIXED_WORKERS=1 FAST_SERVER_C_THREADS=4 bun run bench:run
TARGETS=c-mixed BENCH_PATH=/slow/rai C_MIXED_WORKERS=1 FAST_SERVER_C_THREADS=4 bun run bench:run

# Mixed C server with clustered fallback workers
TARGETS=c-mixed BENCH_PATH=/slow/rai C_MIXED_WORKERS=10 FAST_SERVER_C_THREADS=1 BENCH_WARMUP_MS=3000 bun run bench:run

```

Important environment variables:

```text
TARGETS               comma-separated target names, or "list"
BENCH_PATH            request path, default /hello/rai
PORT                  base server port, default 3030
WRK_THREADS           wrk threads, default 8
WRK_CONNECTIONS       wrk connections, default 256
WRK_DURATION          wrk duration, default 10s
BENCH_WARMUP_MS       delay after server readiness before wrk
WRK_HEADER            newline-separated headers passed to wrk
C_MIXED_WORKERS       c-mixed process count, default auto
C_MIXED_TRANSPORT     tcp or unix for C->TS fallback transport
FAST_SERVER_C_THREADS C core worker threads per c-mixed process
HONO_MIXED_WORKERS    hono-mixed process count, default auto
WASM_WORKERS          wasm-cluster process count
SLOW_DELAY_MS         artificial delay for /slow/:id routes
```

Use separate headline numbers for separate measurement types:

```text
bench/run.ts      wrk HTTP req/s
```
