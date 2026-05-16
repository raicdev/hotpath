import { mkdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type CRoute = {
  method: Method;
  path: string;
  status: number;
  contentType: string;
  body: string;
};

export type CReply = {
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

export type CServerProcess = {
  process: ReturnType<typeof Bun.spawn>;
  processes: Array<ReturnType<typeof Bun.spawn>>;
  configPath: string;
  port: number;
  stop: () => void;
};

export type CListenOptions = {
  hostname?: string;
  threads?: number;
};

export function reply(body: string, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    body
  };
}

export function text(body: string, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...init.headers
    },
    body
  };
}

export function template(body: string, init: Omit<CReply, "body"> = {}): CReply {
  return text(body, init);
}

export function json(body: unknown, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    },
    body: JSON.stringify(body)
  };
}

export class CServer {
  #routes: CRoute[] = [];

  get(path: string, reply: CReply): this {
    this.route("GET", path, reply);
    this.route("HEAD", path, { ...reply, body: "" });
    return this;
  }

  post(path: string, reply: CReply): this {
    return this.route("POST", path, reply);
  }

  put(path: string, reply: CReply): this {
    return this.route("PUT", path, reply);
  }

  patch(path: string, reply: CReply): this {
    return this.route("PATCH", path, reply);
  }

  delete(path: string, reply: CReply): this {
    return this.route("DELETE", path, reply);
  }

  route(method: Method, path: string, reply: CReply): this {
    if (!path.startsWith("/")) {
      throw new TypeError(`Route path must start with "/": ${path}`);
    }
    if (reply.body.includes("\n") || reply.body.includes("\t")) {
      throw new TypeError("C core route bodies cannot contain tabs or newlines yet");
    }

    this.#routes.push({
      method,
      path,
      status: reply.status ?? 200,
      contentType: reply.headers?.["content-type"] ?? "text/plain; charset=utf-8",
      body: reply.body
    });
    return this;
  }

  async listen(port: number, hostnameOrOptions: string | CListenOptions = "0.0.0.0"): Promise<CServerProcess> {
    const binaryPath = await ensureCCore();
    const options =
      typeof hostnameOrOptions === "string" ? { hostname: hostnameOrOptions } : hostnameOrOptions;
    const hostname = options.hostname ?? "0.0.0.0";
    const threads = options.threads ?? (await resolveThreadCount());
    const configPath = resolve(
      process.cwd(),
      ".fast-server",
      `c-${process.pid}-${Date.now()}.tsv`
    );
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, this.#routes.map(serializeRoute).join("\n"));

    const processHandle = Bun.spawn(
      [
        binaryPath,
        "--host",
        hostname,
        "--port",
        String(port),
        "--threads",
        String(Math.max(1, threads)),
        "--config",
        configPath
      ],
      {
        stdout: "inherit",
        stderr: "inherit"
      }
    );

    return {
      process: processHandle,
      processes: [processHandle],
      configPath,
      port,
      stop: () => processHandle.kill()
    };
  }
}

async function resolveThreadCount(): Promise<number> {
  const override = Number(process.env.FAST_SERVER_C_THREADS);
  if (Number.isInteger(override) && override > 0) {
    return override;
  }

  return (await detectPhysicalCoreCount()) ?? availableParallelism();
}

async function detectPhysicalCoreCount(): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;

  try {
    const cpuinfo = await readFile("/proc/cpuinfo", "utf8");
    const cores = new Set<string>();

    for (const block of cpuinfo.split(/\n\s*\n/)) {
      const physicalId = block.match(/^physical id\s*:\s*(.+)$/m)?.[1];
      const coreId = block.match(/^core id\s*:\s*(.+)$/m)?.[1];

      if (physicalId !== undefined && coreId !== undefined) {
        cores.add(`${physicalId}:${coreId}`);
      }
    }

    if (cores.size > 0) return cores.size;

    const cpuCores = cpuinfo.match(/^cpu cores\s*:\s*(\d+)$/m)?.[1];
    if (cpuCores !== undefined) return Number(cpuCores);
  } catch {
    return undefined;
  }

  return undefined;
}

function serializeRoute(route: CRoute): string {
  return [
    route.method,
    route.path,
    String(route.status),
    route.contentType,
    route.body
  ].join("\t");
}

async function ensureCCore(): Promise<string> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const binaryPath = resolve(
    process.cwd(),
    ".fast-server",
    "native",
    process.platform === "win32" ? "hotpath-c.exe" : "hotpath-c"
  );
  const sourcePath = resolve(packageRoot, "core-c", "fast_server_core.c");

  const binary = Bun.file(binaryPath);
  const source = Bun.file(sourcePath);
  const shouldBuild =
    !(await binary.exists()) ||
    (await source.lastModified) > (await binary.lastModified);

  if (!shouldBuild) return binaryPath;
  await mkdir(dirname(binaryPath), { recursive: true });

  const build = Bun.spawnSync([
    "cc",
    "-O3",
    "-march=native",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-pthread",
    sourcePath,
    "-o",
    binaryPath
  ]);

  if (!build.success) {
    const stderr = new TextDecoder().decode(build.stderr);
    throw new Error(`Failed to build C core:\n${stderr}`);
  }

  return binaryPath;
}
