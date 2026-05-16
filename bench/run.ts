import { mkdir } from "node:fs/promises";

type Target = {
  name: string;
  command: string[];
  env?: Record<string, string>;
};

type Result = {
  target: string;
  url: string;
  threads: number;
  connections: number;
  duration: string;
  requestsPerSecond: number;
  transferPerSecond: string;
  latencyAvg: string;
  latencyStdev: string;
  latencyMax: string;
  timeoutErrors: number;
  raw: string;
};

const port = Number(process.env.PORT ?? 3030);
const path = process.env.BENCH_PATH ?? "/hello/rai";
const url = `http://127.0.0.1:${port}${path}`;
const threads = Number(process.env.WRK_THREADS ?? 8);
const connections = Number(process.env.WRK_CONNECTIONS ?? 256);
const duration = process.env.WRK_DURATION ?? "10s";
const selected = new Set((process.env.TARGETS ?? "c-core,hono,wasm-cluster").split(","));

const allTargets: Target[] = [
  {
    name: "c-core",
    command: [
      "./core-c/fast-server-c",
      "--host",
      "0.0.0.0",
      "--port",
      String(port),
      "--threads",
      process.env.FAST_SERVER_C_THREADS ?? "6",
      "--config",
      "bench/c-core.tsv"
    ]
  },
  {
    name: "hono",
    command: ["bun", "bench/hono.ts"],
    env: { PORT: String(port) }
  },
  {
    name: "wasm-cluster",
    command: ["bun", "bench/wasm-cluster.ts"],
    env: {
      PORT: String(port),
      WASM_WORKERS: process.env.WASM_WORKERS ?? "6"
    }
  },
  {
    name: "bun-fast",
    command: ["bun", "bench/fast.ts"],
    env: { PORT: String(port) }
  }
];
const targets = allTargets.filter((target) => selected.has(target.name));

await ensureArtifacts();
const results: Result[] = [];

for (const target of targets) {
  const server = Bun.spawn(target.command, {
    env: {
      ...process.env,
      ...target.env
    },
    stdout: "pipe",
    stderr: "pipe"
  });

  try {
    await waitForServer(url);
    const wrk = Bun.spawnSync([
      "wrk",
      "-t",
      String(threads),
      "-c",
      String(connections),
      "-d",
      duration,
      "--latency",
      url
    ]);
    const raw = new TextDecoder().decode(wrk.stdout);
    if (!wrk.success) {
      throw new Error(new TextDecoder().decode(wrk.stderr));
    }

    const result = parseWrk(target.name, raw);
    results.push(result);
    console.log(
      `${target.name}: ${result.requestsPerSecond.toLocaleString()} req/s, avg ${result.latencyAvg}, timeouts ${result.timeoutErrors}`
    );
  } finally {
    server.kill();
    await server.exited;
  }
}

await mkdir("bench/results", { recursive: true });
const outputPath = `bench/results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(outputPath, JSON.stringify(results, null, 2));
console.log(`wrote ${outputPath}`);

function parseWrk(target: string, raw: string): Result {
  const latency = raw.match(/Latency\s+(\S+)\s+(\S+)\s+(\S+)/);
  const requests = raw.match(/Requests\/sec:\s+([\d.]+)/);
  const transfer = raw.match(/Transfer\/sec:\s+(.+)/);
  const socketErrors = raw.match(/Socket errors:.*timeout\s+(\d+)/);

  return {
    target,
    url,
    threads,
    connections,
    duration,
    requestsPerSecond: Number(requests?.[1] ?? 0),
    transferPerSecond: transfer?.[1]?.trim() ?? "",
    latencyAvg: latency?.[1] ?? "",
    latencyStdev: latency?.[2] ?? "",
    latencyMax: latency?.[3] ?? "",
    timeoutErrors: Number(socketErrors?.[1] ?? 0),
    raw
  };
}

async function waitForServer(endpoint: string): Promise<void> {
  const deadline = Date.now() + 10_000;
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

async function ensureArtifacts(): Promise<void> {
  if (!(await Bun.file("core-c/fast-server-c").exists())) {
    const build = Bun.spawnSync([
      "cc",
      "-O3",
      "-march=native",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-pthread",
      "core-c/fast_server_core.c",
      "-o",
      "core-c/fast-server-c"
    ]);
    if (!build.success) throw new Error(new TextDecoder().decode(build.stderr));
  }

  if (
    !(await Bun.file(
      "wasm-router/target/wasm32-unknown-unknown/release/fast_server_wasm_router.wasm"
    ).exists())
  ) {
    const build = Bun.spawnSync([
      "cargo",
      "build",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      "wasm-router/Cargo.toml"
    ]);
    if (!build.success) throw new Error(new TextDecoder().decode(build.stderr));
  }
}
