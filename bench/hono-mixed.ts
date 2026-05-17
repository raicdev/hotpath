import { availableParallelism } from "node:os";
import { Hono } from "hono";
import { cors } from "hono/cors";

const port = Number(process.env.PORT ?? 3000);
const workerCount = resolveWorkerCount();
const isWorker = process.env.HONO_MIXED_WORKER === "1";

if (workerCount > 1 && !isWorker) {
  console.log(`hono-mixed using ${workerCount} workers`);
  const workers = Array.from({ length: workerCount }, () =>
    Bun.spawn(["bun", "bench/hono-mixed.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        HONO_MIXED_WORKERS: "1",
        HONO_MIXED_WORKER: "1"
      },
      stdout: "inherit",
      stderr: "inherit"
    })
  );

  const stop = () => {
    for (const worker of workers) worker.kill();
  };

  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  await Promise.all(workers.map((worker) => worker.exited));
  process.exit(0);
}

function resolveWorkerCount(): number {
  const override = process.env.HONO_MIXED_WORKERS;
  if (override !== undefined && override !== "" && override !== "auto") {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    throw new TypeError(`HONO_MIXED_WORKERS must be a positive integer or "auto": ${override}`);
  }

  return Math.max(1, Math.min(10, availableParallelism() - 2));
}

const slowDelayMs = Number(process.env.SLOW_DELAY_MS ?? 0);
const app = new Hono();

app.use("*", cors());
app.use("*", async (c, next) => {
  c.header("x-powered-by", "hono");
  c.header("x-content-type-options", "nosniff");
  await next();
});

app.get("/", (c) => c.text("ok"));
app.get("/hello/:name", (c) => c.text(`hello ${c.req.param("name")}`));
app.get("/html", (c) =>
  c.html("<!doctype html><html><head><title>Hotpath</title></head><body><main><h1>Hotpath</h1><p>native html response</p></main></body></html>")
);
app.get("/json", (c) => c.json({ ok: true }));
app.get("/private", (c) => {
  if (c.req.header("authorization") !== "Bearer bench-token") {
    return c.text("Unauthorized", 401);
  }
  return c.text("secret");
});

if (slowDelayMs > 0) {
  app.get("/slow/:id", async (c) => {
    await Bun.sleep(slowDelayMs);
    return c.json({ id: c.req.param("id"), runtime: "typescript" });
  });
} else {
  app.get("/slow/:id", (c) => c.json({ id: c.req.param("id"), runtime: "typescript" }));
}

Bun.serve({
  port,
  reusePort: workerCount > 1 || isWorker,
  fetch: app.fetch
});

await new Promise(() => {});
