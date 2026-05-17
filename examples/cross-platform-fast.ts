import { availableParallelism } from "node:os";
import { Hotpath, header, json, template, text } from "../src/index";

const port = Number(process.env.PORT ?? 3000);
const workerCount = Number(process.env.HOTPATH_WORKERS ?? Math.min(4, availableParallelism()));
const isWorker = process.env.HOTPATH_WORKER === "1";

if (workerCount > 1 && !isWorker) {
  const workers = Array.from({ length: workerCount }, () =>
    Bun.spawn(["bun", "examples/cross-platform-fast.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        HOTPATH_WORKERS: String(workerCount),
        HOTPATH_WORKER: "1"
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

  console.log(`hotpath cross-platform demo spawning ${workerCount} Bun workers`);
  await Promise.all(workers.map((worker) => worker.exited));
  process.exit(0);
}

const app = Hotpath({ adapter: "bun", jit: true });

app.use(header("x-powered-by", "hotpath"));

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true }));
app.get("/ts/:id", (ctx) => ctx.text(`typescript ${ctx.params.id}`));

app.listen(port, { reusePort: workerCount > 1 || isWorker });
await new Promise(() => {});
