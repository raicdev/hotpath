import { mkdir } from "node:fs/promises";

type Target = {
  name: string;
  description: string;
  command: string[];
  env?: Record<string, string>;
  artifacts?: Array<"wasm-router">;
};

type Result = {
  target: string;
  measurement: "wrk-http";
  url: string;
  threads: number;
  connections: number;
  duration: string;
  warmupMs: number;
  requestsPerSecond: number;
  transferPerSecond: string;
  latencyAvg: string;
  latencyStdev: string;
  latencyMax: string;
  timeoutErrors: number;
  command: string[];
  raw: string;
};

const port = Number(process.env.PORT ?? 3030);
const path = process.env.BENCH_PATH ?? "/hello/rai";
const url = `http://127.0.0.1:${port}${path}`;
const threads = Number(process.env.WRK_THREADS ?? 8);
const connections = Number(process.env.WRK_CONNECTIONS ?? 256);
const duration = process.env.WRK_DURATION ?? "10s";
const warmupMs = Number(process.env.BENCH_WARMUP_MS ?? 0);
const wrkHeaders = (process.env.WRK_HEADER ?? "")
  .split("\n")
  .map((header) => header.trim())
  .filter(Boolean);

const allTargets: Target[] = [
  {
    name: "c-mixed",
    description: "CServer hot routes plus TypeScript fallback/native compiled routes",
    command: ["bun", "bench/c-mixed.ts"],
    env: {
      PORT: String(port),
      SLOW_DELAY_MS: process.env.SLOW_DELAY_MS ?? "0"
    }
  },
  {
    name: "hono-mixed",
    description: "Hono equivalent of c-mixed routes/middleware",
    command: ["bun", "bench/hono-mixed.ts"],
    env: {
      PORT: String(port),
      SLOW_DELAY_MS: process.env.SLOW_DELAY_MS ?? "0"
    }
  },
  {
    name: "wasm-cluster",
    description: "Wasm adapter served by multiple Bun workers",
    command: ["bun", "bench/wasm-cluster.ts"],
    env: {
      PORT: String(port),
      WASM_WORKERS: process.env.WASM_WORKERS ?? "6"
    },
    artifacts: ["wasm-router"]
  }
];

if (process.env.TARGETS === "list") {
  for (const target of allTargets) {
    console.log(`${target.name.padEnd(16)} ${target.description}`);
  }
  process.exit(0);
}

const selectedNames = (process.env.TARGETS ?? "c-mixed,hono-mixed,wasm-cluster").split(",").filter(Boolean);
const targetByName = new Map(allTargets.map((target) => [target.name, target]));
const unknownTargets = selectedNames.filter((name) => !targetByName.has(name));
if (unknownTargets.length > 0) {
  throw new Error(`Unknown benchmark target(s): ${unknownTargets.join(", ")}. Run TARGETS=list bun run bench:run`);
}
const targets = selectedNames.map((name) => targetByName.get(name)!);

await ensureArtifacts(targets);
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
    if (warmupMs > 0) await Bun.sleep(warmupMs);
    const wrkCommand = [
      "wrk",
      "-t",
      String(threads),
      "-c",
      String(connections),
      "-d",
      duration,
      "--latency",
      url
    ];
    for (const header of wrkHeaders) {
      wrkCommand.push("-H", header);
    }
    const wrk = Bun.spawnSync(wrkCommand);
    const raw = new TextDecoder().decode(wrk.stdout);
    if (!wrk.success) {
      throw new Error(new TextDecoder().decode(wrk.stderr));
    }

    const result = parseWrk(target.name, raw);
    result.command = wrkCommand;
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
    measurement: "wrk-http",
    url,
    threads,
    connections,
    duration,
    warmupMs,
    requestsPerSecond: Number(requests?.[1] ?? 0),
    transferPerSecond: transfer?.[1]?.trim() ?? "",
    latencyAvg: latency?.[1] ?? "",
    latencyStdev: latency?.[2] ?? "",
    latencyMax: latency?.[3] ?? "",
    timeoutErrors: Number(socketErrors?.[1] ?? 0),
    command: [],
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

async function ensureArtifacts(targets: Target[]): Promise<void> {
  const artifacts = new Set(targets.flatMap((target) => target.artifacts ?? []));

  if (artifacts.has("wasm-router")) {
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
}
