import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type RustRoute = {
  method: Method;
  path: string;
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

export type RustReply = {
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

export type RustServerProcess = {
  process: ReturnType<typeof Bun.spawn>;
  configPath: string;
  port: number;
  stop: () => void;
};

export function text(body: string, init: Omit<RustReply, "body"> = {}): RustReply {
  return {
    ...init,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...init.headers
    },
    body
  };
}

export function json(body: unknown, init: Omit<RustReply, "body"> = {}): RustReply {
  return {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers
    },
    body: JSON.stringify(body)
  };
}

export class RustServer {
  #routes: RustRoute[] = [];

  get(path: string, reply: RustReply): this {
    this.route("GET", path, reply);
    this.route("HEAD", path, { ...reply, body: "" });
    return this;
  }

  post(path: string, reply: RustReply): this {
    return this.route("POST", path, reply);
  }

  put(path: string, reply: RustReply): this {
    return this.route("PUT", path, reply);
  }

  patch(path: string, reply: RustReply): this {
    return this.route("PATCH", path, reply);
  }

  delete(path: string, reply: RustReply): this {
    return this.route("DELETE", path, reply);
  }

  route(method: Method, path: string, reply: RustReply): this {
    if (!path.startsWith("/")) {
      throw new TypeError(`Route path must start with "/": ${path}`);
    }

    this.#routes.push({
      method,
      path,
      status: reply.status,
      headers: reply.headers,
      body: reply.body
    });
    return this;
  }

  async listen(port: number, hostname = "0.0.0.0"): Promise<RustServerProcess> {
    const binaryPath = await ensureRustCore();
    const configPath = resolve(
      process.cwd(),
      ".fast-server",
      `rust-${process.pid}-${Date.now()}.json`
    );
    await mkdir(dirname(configPath), { recursive: true });
    await Bun.write(configPath, JSON.stringify({ routes: this.#routes }));

    const processHandle = Bun.spawn(
      [
        binaryPath,
        "--host",
        hostname,
        "--port",
        String(port),
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
      configPath,
      port,
      stop: () => processHandle.kill()
    };
  }
}

async function ensureRustCore(): Promise<string> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const binaryPath = resolve(
    packageRoot,
    "core",
    "target",
    "release",
    process.platform === "win32" ? "fast-server-core.exe" : "fast-server-core"
  );

  if (await Bun.file(binaryPath).exists()) {
    return binaryPath;
  }

  const build = Bun.spawnSync([
    "cargo",
    "build",
    "--release",
    "--manifest-path",
    resolve(packageRoot, "core", "Cargo.toml")
  ]);

  if (!build.success) {
    const stderr = new TextDecoder().decode(build.stderr);
    throw new Error(`Failed to build Rust core:\n${stderr}`);
  }

  return binaryPath;
}
