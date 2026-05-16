import autocannon from "autocannon";

type Target = {
  name: string;
  script: string;
};

const targets: Target[] = [
  { name: "c-core", script: "bench/c.ts" },
  { name: "rust-core", script: "bench/rust.ts" },
  { name: "bun-hotpath", script: "bench/fast.ts" },
  { name: "hono", script: "bench/hono.ts" }
];

const port = Number(process.env.PORT ?? 3030);
const path = process.env.BENCH_PATH ?? "/hello/rai";
const url = `http://127.0.0.1:${port}${path}`;

for (const target of targets) {
  const proc = Bun.spawn(["bun", target.script], {
    env: {
      ...process.env,
      PORT: String(port)
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  try {
    await waitForServer(url);
    const result = await autocannon({
      url,
      connections: Number(process.env.CONNECTIONS ?? 128),
      duration: Number(process.env.DURATION ?? 5),
      pipelining: Number(process.env.PIPELINING ?? 1)
    });

    console.log(
      `${target.name}: ${Math.round(result.requests.average).toLocaleString()} req/s avg, ` +
        `${result.latency.average.toFixed(2)} ms avg latency`
    );
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function waitForServer(endpoint: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(endpoint);
      await res.text();
      return;
    } catch {
      await Bun.sleep(50);
    }
  }

  throw new Error(`Server did not start: ${endpoint}`);
}
