import { unlinkSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server, TCPSocketListener } from "bun";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type CRouteBase = {
  method: Method;
  path: string;
  middleware: CMiddleware[];
};

type CReplyRoute = CRouteBase & {
  kind: "reply";
  status: number;
  contentType: string;
  body: string;
};

type CHandlerRoute = CRouteBase & {
  kind: "handler";
  parts: string[];
  paramNames: string[];
  handler: CHandler;
};

type CRoute = CReplyRoute | CHandlerRoute;
type CRouteInput = CReply | CHandler;
type CCompiledHandlerRoute = CHandlerRoute & {
  middlewarePlan: CMiddlewarePlan;
  execute: (req: Request, params: CParams) => CHandlerResult | Promise<CHandlerResult>;
  executeLite: (method: Method, path: string, params: CParams) => CHandlerResult | Promise<CHandlerResult>;
};

type CHandlerRouteIndex = {
  staticRoutes: Map<string, CCompiledHandlerRoute>;
  dynamicRoutes: CCompiledHandlerRoute[];
  routesById: Map<number, CCompiledHandlerRoute>;
};

type CMiddlewarePlan = {
  required: Array<{ name: string; value: string }>;
  responseHeaders: Array<[string, string]>;
  responseHeaderRecord: Record<string, string>;
};

type CFallbackServer = {
  server: Server<undefined> | TCPSocketListener<{ buffer: string }>;
  port?: number;
  unix?: string;
  stop: () => void;
};

const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export type CReply = {
  status?: number;
  headers?: Record<string, string>;
  body: string;
};

export type CParams = Record<string, string>;
export type CHandlerResult = Response | CReply;
export type CHandler = (ctx: CContext) => CHandlerResult | Promise<CHandlerResult>;
export type CNativeValue =
  | string
  | number
  | boolean
  | null
  | CNativeParam
  | CNativeValue[]
  | { [key: string]: CNativeValue };
export type CNativeContext = {
  req: {
    param: (name: string) => CNativeParam;
  };
  param: (name: string) => CNativeParam;
  text: (body: string | CNativeParam, status?: number, headers?: Record<string, string>) => CReply;
  html: (body: string | CNativeParam, status?: number, headers?: Record<string, string>) => CReply;
  json: (body: CNativeValue, status?: number, headers?: Record<string, string>) => CReply;
};

export type CorsOptions = {
  origin?: string;
  methods?: string | string[];
  headers?: string | string[];
  credentials?: boolean;
  maxAge?: number;
};

export type CMiddleware =
  | {
      kind: "header";
      name: string;
      value: string;
    }
  | {
      kind: "cors";
      origin: string;
      methods: string;
      headers: string;
      credentials: boolean;
      maxAge?: number;
    }
  | {
      kind: "require-header";
      name: string;
      value: string;
    };

export type CRouteOptions = {
  middleware?: CMiddleware[];
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

export type CServerOptions = {
  fallbackJit?: boolean;
  fallbackTransport?: "http" | "tcp" | "unix";
};

export class CContext {
  readonly params: CParams;
  readonly method: string;
  readonly path: string;
  #req?: Request;

  constructor(req: Request | undefined, params: CParams, method = "GET", path = "/") {
    this.#req = req;
    this.params = params;
    this.method = req?.method ?? method;
    this.path = req ? new URL(req.url).pathname : path;
  }

  get req(): Request {
    return (this.#req ??= new Request(`http://hotpath.local${this.path}`, { method: this.method }));
  }

  text(body: string, status = 200, headers?: Record<string, string>): CReply {
    return {
      status,
      headers: withContentTypeRecord(headers, TEXT_CONTENT_TYPE),
      body
    };
  }

  json(body: unknown, status = 200, headers?: Record<string, string>): CReply {
    return {
      status,
      headers: withContentTypeRecord(headers, JSON_CONTENT_TYPE),
      body: JSON.stringify(body)
    };
  }

  html(body: string, status = 200, headers?: Record<string, string>): CReply {
    return {
      status,
      headers: withContentTypeRecord(headers, HTML_CONTENT_TYPE),
      body
    };
  }
}

export class CNativeParam {
  readonly name: string;

  constructor(name: string) {
    assertTemplateParamName(name);
    this.name = name;
  }

  toString(): string {
    return `{${this.name}}`;
  }

  toJSON(): string {
    return this.toString();
  }
}

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
      "content-type": TEXT_CONTENT_TYPE,
      ...init.headers
    },
    body
  };
}

export function template(body: string, init: Omit<CReply, "body"> = {}): CReply {
  return text(body, init);
}

export function html(body: string, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    headers: {
      "content-type": HTML_CONTENT_TYPE,
      ...init.headers
    },
    body
  };
}

export function json(body: unknown, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      ...init.headers
    },
    body: JSON.stringify(body)
  };
}

export function jsonTemplate(body: unknown, init: Omit<CReply, "body"> = {}): CReply {
  return {
    ...init,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      ...init.headers
    },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

export function native(handler: (ctx: CNativeContext) => CReply): CReply {
  const ctx = createNativeContext();
  return handler(ctx);
}

export const compiled = native;

function createNativeContext(): CNativeContext {
  const param = (name: string) => new CNativeParam(name);

  return {
    req: { param },
    param,
    text: (body, status = 200, headers) =>
      text(String(body), {
        status,
        headers
      }),
    html: (body, status = 200, headers) =>
      html(String(body), {
        status,
        headers
      }),
    json: (body, status = 200, headers) =>
      jsonTemplate(body, {
        status,
        headers
      })
  };
}

export function header(name: string, value: string): CMiddleware {
  assertHeaderName(name);
  assertTsvField("header value", value);
  return { kind: "header", name: name.toLowerCase(), value };
}

export function headers(record: Record<string, string>): CMiddleware[] {
  return Object.entries(record).map(([name, value]) => header(name, value));
}

export function requireHeader(name: string, value: string): CMiddleware {
  assertHeaderName(name);
  assertTsvField("required header value", value);
  return { kind: "require-header", name: name.toLowerCase(), value };
}

export function cors(options: CorsOptions = {}): CMiddleware {
  const methods = normalizeList(
    options.methods ?? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  );
  const allowedHeaders = normalizeList(options.headers ?? "");
  const origin = options.origin ?? "*";

  assertTsvField("CORS origin", origin);
  assertTsvField("CORS methods", methods);
  assertTsvField("CORS headers", allowedHeaders);

  if (options.maxAge !== undefined && (!Number.isInteger(options.maxAge) || options.maxAge < 0)) {
    throw new TypeError("CORS maxAge must be a non-negative integer");
  }

  return {
    kind: "cors",
    origin,
    methods,
    headers: allowedHeaders,
    credentials: options.credentials ?? false,
    maxAge: options.maxAge
  };
}

export class CServer {
  #routes: CRoute[] = [];
  #middleware: CMiddleware[] = [];
  #fallbackJit: boolean;
  #fallbackTransport: "http" | "tcp" | "unix";
  #handlerIndex: CHandlerRouteIndex = {
    staticRoutes: new Map(),
    dynamicRoutes: [],
    routesById: new Map()
  };

  constructor(options: CServerOptions = {}) {
    this.#fallbackJit = options.fallbackJit ?? false;
    this.#fallbackTransport = options.fallbackTransport ?? "http";
  }

  use(...middleware: Array<CMiddleware | CMiddleware[]>): this {
    for (const item of middleware.flat()) {
      this.#middleware.push(item);
    }
    return this;
  }

  get(path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    this.route("GET", path, reply, options);
    this.route("HEAD", path, typeof reply === "function" ? reply : { ...reply, body: "" }, options);
    return this;
  }

  post(path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    return this.route("POST", path, reply, options);
  }

  put(path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    return this.route("PUT", path, reply, options);
  }

  patch(path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    return this.route("PATCH", path, reply, options);
  }

  delete(path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    return this.route("DELETE", path, reply, options);
  }

  route(method: Method, path: string, reply: CRouteInput, options: CRouteOptions = {}): this {
    if (!path.startsWith("/")) {
      throw new TypeError(`Route path must start with "/": ${path}`);
    }
    assertTsvField("route path", path);

    if (typeof reply === "function") {
      this.#routes.push({
        kind: "handler",
        method,
        path,
        middleware: [...(options.middleware ?? [])],
        ...compileHandlerRoute(path, reply)
      });
      return this;
    }

    assertTsvField("route body", reply.body);

    this.#routes.push({
      kind: "reply",
      method,
      path,
      status: reply.status ?? 200,
      contentType: reply.headers?.["content-type"] ?? "text/plain; charset=utf-8",
      body: reply.body,
      middleware: [...(options.middleware ?? [])]
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

    this.#handlerIndex = compileHandlerRouteIndex(this.#routes, this.#middleware, this.#fallbackJit);
    const hasHandlerRoutes =
      this.#handlerIndex.staticRoutes.size > 0 || this.#handlerIndex.dynamicRoutes.length > 0;
    const fallbackServer = hasHandlerRoutes ? this.#listenFallback() : undefined;

    await Bun.write(
      configPath,
      serializeConfig(this.#middleware, this.#routes, fallbackServer, this.#fallbackTransport)
    );

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
      stop: () => {
        processHandle.kill();
        fallbackServer?.stop();
      }
    };
  }

  #listenFallback(): CFallbackServer {
    if (this.#fallbackTransport === "tcp" || this.#fallbackTransport === "unix") {
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const unix =
        this.#fallbackTransport === "unix"
          ? resolve(process.cwd(), ".fast-server", `fallback-${process.pid}-${Date.now()}.sock`)
          : undefined;

      if (unix) {
        try {
          unlinkSync(unix);
        } catch {
          // Socket does not exist yet.
        }
      }

      const server = Bun.listen<{ buffer: string }>({
        hostname: "127.0.0.1",
        ...(unix ? { unix } : {}),
        port: 0,
        socket: {
          open(socket) {
            socket.data = { buffer: "" };
          },
          data: (socket, chunk) => {
            socket.data.buffer += decoder.decode(chunk);

            for (;;) {
              const lineEnd = socket.data.buffer.indexOf("\n");
              if (lineEnd < 0) return;

              const line = socket.data.buffer.slice(0, lineEnd);
              socket.data.buffer = socket.data.buffer.slice(lineEnd + 1);
              const frame = this.#handleTcpFallbackLine(line);
              if (frame instanceof Promise) {
                void frame.then((value) => {
                  socket.write(encoder.encode(value));
                });
              } else {
                socket.write(encoder.encode(frame));
              }
            }
          }
        }
      });

      return {
        server,
        port: unix ? undefined : server.port,
        unix,
        stop: () => {
          server.stop();
          if (unix) void unlink(unix).catch(() => undefined);
        }
      };
    }

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => this.#fetchFallback(req)
    });
    return { server, port: server.port, stop: () => server.stop() };
  }

  #handleTcpFallbackLine(line: string): string | Promise<string> {
    const direct = matchTcpFallbackRoute(this.#handlerIndex, line);
    if (direct) {
      return encodeTcpFallbackResult(direct.route.executeLite(direct.method, direct.pathname, direct.params));
    }

    const separator = line.indexOf(" ");
    const method = (separator < 0 ? "GET" : line.slice(0, separator)) as Method;
    const pathname = separator < 0 ? line : line.slice(separator + 1);
    const match = matchHandlerRoute(this.#handlerIndex, method, pathname);

    if (!match) return encodeTcpFallbackResponse(404, "text/plain; charset=utf-8", "Not Found");

    return encodeTcpFallbackResult(match.route.executeLite(method, pathname, match.params));
  }

  async #fetchFallback(req: Request): Promise<Response> {
    const method = req.method as Method;
    const url = new URL(req.url);
    const pathname = url.pathname;
    const match = matchHandlerRoute(this.#handlerIndex, method, pathname);

    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const result = await match.route.execute(req, match.params);
    return toResponse(result);
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

function serializeConfig(
  middleware: CMiddleware[],
  routes: CRoute[],
  fallback?: Pick<CFallbackServer, "port" | "unix">,
  fallbackTransport: "http" | "tcp" | "unix" = "http"
): string {
  const lines: string[] = [];

  lines.push("# hotpath-c config v2: records are tab-separated and fields cannot contain tabs/newlines");
  lines.push("# MIDDLEWARE HEADER name value");
  lines.push("# MIDDLEWARE CORS origin methods headers credentials maxAge");
  lines.push("# ROUTE method path status contentType body");
  lines.push("# PROXY method path fallbackPort");
  lines.push("# PROXY_TCP method path fallbackPort handlerRouteIndex");
  lines.push("# PROXY_UNIX method path fallbackSocket handlerRouteIndex");
  lines.push("# ROUTE_MIDDLEWARE routeIndex REQUIRE_HEADER name value");

  for (const item of middleware) {
    lines.push(serializeMiddleware("MIDDLEWARE", item));
  }

  routes.forEach((route, index) => {
    lines.push(serializeRoute(route, index, fallback, fallbackTransport));
    for (const item of route.middleware) {
      lines.push(serializeMiddleware("ROUTE_MIDDLEWARE", item, index));
    }
  });

  return `${lines.join("\n")}\n`;
}

function serializeRoute(
  route: CRoute,
  routeIndex: number,
  fallback?: Pick<CFallbackServer, "port" | "unix">,
  fallbackTransport: "http" | "tcp" | "unix" = "http"
): string {
  if (route.kind === "handler") {
    if (fallback === undefined) {
      throw new Error("C handler routes require a fallback server port");
    }

    if (fallbackTransport === "unix") {
      if (fallback.unix === undefined) throw new Error("Unix fallback transport requires a socket path");
      assertTsvField("fallback socket", fallback.unix);
      return ["PROXY_UNIX", route.method, route.path, fallback.unix, String(routeIndex)].join("\t");
    }

    if (fallback.port === undefined) {
      throw new Error("TCP/HTTP fallback transport requires a fallback server port");
    }

    return [
      fallbackTransport === "tcp" ? "PROXY_TCP" : "PROXY",
      route.method,
      route.path,
      String(fallback.port),
      String(routeIndex)
    ].join("\t");
  }

  return [
    "ROUTE",
    route.method,
    route.path,
    String(route.status),
    route.contentType,
    route.body
  ].join("\t");
}

function compileHandlerRoute(path: string, handler: CHandler): Pick<CHandlerRoute, "parts" | "paramNames" | "handler"> {
  const parts = splitPath(path);
  return {
    parts,
    paramNames: parts.filter((part) => part.startsWith(":")).map((part) => part.slice(1)),
    handler
  };
}

function encodeTcpFallbackResponse(status: number, contentType: string, body: string): string {
  if (status === 200) {
    if (contentType === JSON_CONTENT_TYPE) return `J${Buffer.byteLength(body)}\n${body}`;
    if (contentType === TEXT_CONTENT_TYPE) return `T${Buffer.byteLength(body)}\n${body}`;
    if (contentType === HTML_CONTENT_TYPE) return `H${Buffer.byteLength(body)}\n${body}`;
  }

  return `${status}\t${contentType}\t${Buffer.byteLength(body)}\n${body}`;
}

function encodeTcpFallbackResult(result: CHandlerResult | Promise<CHandlerResult>): string | Promise<string> {
  if (isPromiseLike(result)) {
    return result.then((value) => encodeTcpFallbackResult(value));
  }

  if (result instanceof Response) {
    return result
      .text()
      .then((body) =>
        encodeTcpFallbackResponse(
          result.status,
      result.headers.get("content-type") ?? TEXT_CONTENT_TYPE,
          body
        )
      );
  }

  return encodeTcpFallbackResponse(
    result.status ?? 200,
    result.headers?.["content-type"] ?? TEXT_CONTENT_TYPE,
    result.body
  );
}

function splitPath(path: string): string[] {
  if (path === "/") return [];
  return path.slice(1).split("/");
}

function compileHandlerRouteIndex(
  routes: CRoute[],
  globalMiddleware: CMiddleware[],
  jit: boolean
): CHandlerRouteIndex {
  const index: CHandlerRouteIndex = {
    staticRoutes: new Map(),
    dynamicRoutes: [],
    routesById: new Map()
  };

  routes.forEach((route, routeIndex) => {
    if (route.kind !== "handler") return;
    const middlewarePlan = compileMiddlewarePlan(globalMiddleware, route.middleware);
    const compiled: CCompiledHandlerRoute = {
      ...route,
      middlewarePlan,
      ...compileFallbackExecutors(route.handler, middlewarePlan, jit)
    };

    index.routesById.set(routeIndex, compiled);

    if (route.path.includes(":")) {
      index.dynamicRoutes.push(compiled);
    } else {
      index.staticRoutes.set(routeKey(route.method, route.path), compiled);
    }
  });

  return index;
}

function matchTcpFallbackRoute(
  index: CHandlerRouteIndex,
  line: string
): { route: CCompiledHandlerRoute; method: Method; pathname: string; params: CParams } | undefined {
  let fieldStart = 0;
  let fieldEnd = line.indexOf("\t");
  if (fieldEnd < 0) return undefined;

  const routeId = Number(line.slice(fieldStart, fieldEnd));
  const route = Number.isInteger(routeId) ? index.routesById.get(routeId) : undefined;
  if (!route) return undefined;

  fieldStart = fieldEnd + 1;
  fieldEnd = line.indexOf("\t", fieldStart);
  if (fieldEnd < 0) return undefined;
  const method = line.slice(fieldStart, fieldEnd) as Method;

  fieldStart = fieldEnd + 1;
  fieldEnd = line.indexOf("\t", fieldStart);
  if (fieldEnd < 0) return undefined;
  const pathname = line.slice(fieldStart, fieldEnd);

  fieldStart = fieldEnd + 1;
  fieldEnd = line.indexOf("\t", fieldStart);
  const paramCountText = fieldEnd < 0 ? line.slice(fieldStart) : line.slice(fieldStart, fieldEnd);
  const paramCount = Number(paramCountText);
  const params: CParams = Object.create(null);

  if (Number.isInteger(paramCount) && paramCount > 0) {
    for (let i = 0; i < paramCount && i < route.paramNames.length; i += 1) {
      if (fieldEnd < 0) {
        params[route.paramNames[i]] = "";
        continue;
      }

      fieldStart = fieldEnd + 1;
      fieldEnd = line.indexOf("\t", fieldStart);
      const value = fieldEnd < 0 ? line.slice(fieldStart) : line.slice(fieldStart, fieldEnd);
      params[route.paramNames[i]] = value.includes("%") ? decodeURIComponent(value) : value;
    }
  }

  return { route, method, pathname, params };
}

function compileFallbackExecutors(
  handler: CHandler,
  plan: CMiddlewarePlan,
  jit: boolean
): Pick<CCompiledHandlerRoute, "execute" | "executeLite"> {
  if (!jit) {
    return {
      execute: async (req, params) => {
        if (!middlewareAllows(req, plan)) return unauthorized();
        const result = await handler(new CContext(req, params));
        return applyResponseMiddlewareToResult(result, plan);
      },
      executeLite: (method, path, params) => {
        return applyMaybeAsync(
          handler(new CContext(undefined, params, method, path)),
          (result) => applyResponseMiddlewareToResult(result, plan)
        );
      }
    };
  }

  const checks = plan.required
    .map(
      (item) =>
        `if (req.headers.get(${JSON.stringify(item.name)}) !== ${JSON.stringify(item.value)}) return unauthorized();`
    )
    .join("\n");

  const execute = new Function(
    "CContext",
    "handler",
    "apply",
    "plan",
    "hasResponseHeaders",
    "unauthorized",
    `
      return async function hotpathCJitFallback(req, params) {
        ${checks}
        const result = await handler(new CContext(req, params));
        return hasResponseHeaders ? apply(result, plan) : result;
      }
    `
  )(CContext, handler, applyResponseMiddlewareToResult, plan, plan.responseHeaders.length > 0, unauthorized) as (
    req: Request,
    params: CParams
  ) => CHandlerResult | Promise<CHandlerResult>;

  const executeLite = new Function(
    "CContext",
    "handler",
    "apply",
    "plan",
    "hasResponseHeaders",
    "applyMaybeAsync",
    `
      return function hotpathCJitFallbackLite(method, path, params) {
        const result = handler(new CContext(undefined, params, method, path));
        return hasResponseHeaders ? applyMaybeAsync(result, (value) => apply(value, plan)) : result;
      }
    `
  )(CContext, handler, applyResponseMiddlewareToResult, plan, plan.responseHeaders.length > 0, applyMaybeAsync) as (
    method: Method,
    path: string,
    params: CParams
  ) => CHandlerResult | Promise<CHandlerResult>;

  return { execute, executeLite };
}

function matchHandlerRoute(
  index: CHandlerRouteIndex,
  method: Method,
  pathname: string
): { route: CCompiledHandlerRoute; params: CParams } | undefined {
  const staticRoute = index.staticRoutes.get(routeKey(method, pathname));
  if (staticRoute) return { route: staticRoute, params: Object.create(null) };

  const parts = splitPath(pathname);

  for (const route of index.dynamicRoutes) {
    if (route.method !== method || route.parts.length !== parts.length) {
      continue;
    }

    const params: CParams = Object.create(null);
    let paramIndex = 0;
    let matched = true;

    for (let i = 0; i < route.parts.length; i += 1) {
      const expected = route.parts[i];
      const actual = parts[i];

      if (expected.startsWith(":")) {
        params[route.paramNames[paramIndex++]] = decodeURIComponent(actual);
      } else if (expected !== actual) {
        matched = false;
        break;
      }
    }

    if (matched) return { route, params };
  }

  return undefined;
}

function compileMiddlewarePlan(global: CMiddleware[], route: CMiddleware[]): CMiddlewarePlan {
  const required: CMiddlewarePlan["required"] = [];
  const responseHeaders: CMiddlewarePlan["responseHeaders"] = [];

  for (const item of [...global, ...route]) {
    switch (item.kind) {
      case "header":
        responseHeaders.push([item.name, item.value]);
        break;
      case "cors":
        responseHeaders.push(["access-control-allow-origin", item.origin]);
        responseHeaders.push(["access-control-allow-methods", item.methods]);
        if (item.headers) responseHeaders.push(["access-control-allow-headers", item.headers]);
        if (item.credentials) responseHeaders.push(["access-control-allow-credentials", "true"]);
        if (item.maxAge !== undefined) responseHeaders.push(["access-control-max-age", String(item.maxAge)]);
        break;
      case "require-header":
        required.push({ name: item.name, value: item.value });
        break;
    }
  }

  return { required, responseHeaders, responseHeaderRecord: Object.fromEntries(responseHeaders) };
}

function routeKey(method: Method, path: string): string {
  return `${method} ${path}`;
}

function middlewareAllows(req: Request, plan: CMiddlewarePlan): boolean {
  for (const item of plan.required) {
    if (req.headers.get(item.name) !== item.value) return false;
  }
  return true;
}

function unauthorized(): CReply {
  return {
    status: 401,
    headers: { "content-type": TEXT_CONTENT_TYPE },
    body: "Unauthorized"
  };
}

function toResponse(result: CHandlerResult): Response {
  if (result instanceof Response) return result;
  return new Response(result.body, {
    status: result.status ?? 200,
    headers: result.headers
  });
}

function applyResponseMiddlewareToResult(result: CHandlerResult, plan: CMiddlewarePlan): CHandlerResult {
  if (result instanceof Response) return applyResponseMiddleware(result, plan);
  if (plan.responseHeaders.length === 0) return result;

  return {
    ...result,
    headers: {
      ...result.headers,
      ...plan.responseHeaderRecord
    }
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}

function applyMaybeAsync<T, U>(value: T | PromiseLike<T>, apply: (value: T) => U): U | Promise<U> {
  return isPromiseLike(value) ? Promise.resolve(value).then(apply) : apply(value);
}

function applyResponseMiddleware(response: Response, plan: CMiddlewarePlan): Response {
  if (plan.responseHeaders.length === 0) return response;
  const headers = new Headers(response.headers);

  for (const [name, value] of plan.responseHeaders) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function serializeMiddleware(prefix: "MIDDLEWARE", middleware: CMiddleware): string;
function serializeMiddleware(
  prefix: "ROUTE_MIDDLEWARE",
  middleware: CMiddleware,
  routeIndex: number
): string;
function serializeMiddleware(
  prefix: "MIDDLEWARE" | "ROUTE_MIDDLEWARE",
  middleware: CMiddleware,
  routeIndex?: number
): string {
  const fields: string[] = prefix === "ROUTE_MIDDLEWARE" ? [prefix, String(routeIndex)] : [prefix];

  switch (middleware.kind) {
    case "header":
      fields.push("HEADER", middleware.name, middleware.value);
      break;
    case "cors":
      if (prefix === "ROUTE_MIDDLEWARE") {
        throw new TypeError("CORS middleware is only supported globally in the C core");
      }
      fields.push(
        "CORS",
        middleware.origin,
        middleware.methods,
        middleware.headers,
        middleware.credentials ? "1" : "0",
        middleware.maxAge === undefined ? "" : String(middleware.maxAge)
      );
      break;
    case "require-header":
      fields.push("REQUIRE_HEADER", middleware.name, middleware.value);
      break;
  }

  return fields.join("\t");
}

function normalizeList(value: string | string[]): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

function assertHeaderName(name: string): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
    throw new TypeError(`Invalid HTTP header name: ${name}`);
  }
}

function assertTemplateParamName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) {
    throw new TypeError(`Invalid C template param name: ${name}`);
  }
}

function assertTsvField(label: string, value: string): void {
  if (value.includes("\n") || value.includes("\r") || value.includes("\t")) {
    throw new TypeError(`C core ${label} cannot contain tabs or newlines yet`);
  }
}

function withContentType(headers: HeadersInit | undefined, contentType: string): Headers {
  const next = new Headers(headers);
  if (!next.has("content-type")) next.set("content-type", contentType);
  return next;
}

function withContentTypeRecord(
  headers: Record<string, string> | undefined,
  contentType: string
): Record<string, string> {
  return {
    "content-type": contentType,
    ...headers
  };
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
