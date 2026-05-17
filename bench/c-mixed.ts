import { availableParallelism } from "node:os";
import {
  CServer,
  cors,
  header,
  headers,
  html,
  json,
  native,
  requireHeader,
  template,
  text
} from "../src/c";

const port = Number(process.env.PORT ?? 3000);
const workerCount = resolveWorkerCount();
const isWorker = process.env.C_MIXED_WORKER === "1";

if (workerCount > 1 && !isWorker) {
  console.log(`c-mixed using ${workerCount} workers`);
  const workers = Array.from({ length: workerCount }, () =>
    Bun.spawn(["bun", "bench/c-mixed.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        C_MIXED_WORKERS: "1",
        C_MIXED_WORKER: "1",
        FAST_SERVER_C_THREADS: process.env.FAST_SERVER_C_THREADS ?? "1"
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
  const override = process.env.C_MIXED_WORKERS;
  if (override !== undefined && override !== "" && override !== "auto") {
    const parsed = Number(override);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    throw new TypeError(`C_MIXED_WORKERS must be a positive integer or "auto": ${override}`);
  }

  return Math.max(1, Math.min(10, availableParallelism() - 2));
}

const slowDelayMs = Number(process.env.SLOW_DELAY_MS ?? 0);
const fallbackTransport = process.env.C_MIXED_TRANSPORT === "unix" ? "unix" : "tcp";
const app = new CServer({ fallbackJit: true, fallbackTransport });

app.use(cors());
app.use(header("x-powered-by", "hotpath"));
app.use(headers({ "x-content-type-options": "nosniff" }));

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/html", html("<!doctype html><html><head><title>Hotpath</title></head><body><main><h1>Hotpath</h1><p>native html response</p></main></body></html>"));
app.get("/json", json({ ok: true }));
app.get("/private", text("secret"), {
  middleware: [requireHeader("authorization", "Bearer bench-token")]
});
const tsOk = text("ok from typescript");
app.get("/ts-ok", () => tsOk);
app.get("/ts-text/:id", (ctx) => ctx.text(`typescript ${ctx.params.id}`));
app.get("/slow-c/:id", native((c) => c.json({ id: c.req.param("id"), runtime: "typescript" })));
if (slowDelayMs > 0) {
  app.get("/slow/:id", async (ctx) => {
    await Bun.sleep(slowDelayMs);
    return ctx.json({ id: ctx.params.id, runtime: "typescript" });
  });
} else {
  app.get("/slow/:id", (ctx) => ctx.json({ id: ctx.params.id, runtime: "typescript" }));
}

const server = await app.listen(port);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}

await new Promise(() => {});
