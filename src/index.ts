import type { BunRequest, Server } from "bun";
import {
  CServer,
  CContext,
  compiled,
  cors,
  header,
  headers,
  html,
  json,
  jsonTemplate,
  native,
  reply,
  requireHeader,
  template,
  text,
  type CMiddleware,
  type CHandler,
  type CNativeContext,
  type CNativeValue,
  type CReply,
  type CRouteOptions
} from "./c";

export type Params = Record<string, string>;
export type Query = Record<string, string | string[]>;
export type Handler = (ctx: Context) => Response | Promise<Response>;
export type HotpathAdapterObject<TServer = FastServer | CServer> = {
  kind: "hotpath-adapter";
  name: string;
  create: () => TServer;
};
export type HotpathAdapter = "bun" | "c" | HotpathAdapterObject;
export type HotpathOptions = {
  adapter?: HotpathAdapter;
  jit?: boolean;
  fallback?: {
    jit?: boolean;
    transport?: "http" | "tcp" | "unix";
  };
};
export type FastListenOptions = {
  hostname?: string;
  reusePort?: boolean;
};

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
type RouteInput = Handler | CReply;
type RouteHandler = (req: Request, params: Params) => Response | Promise<Response>;
type TemplatePart = string | { param: string };

type Route = {
  method: Method;
  path: string;
  parts: string[];
  paramNames: string[];
  handler: RouteHandler;
  bunHandler?: (req: BunRequest<string>) => Response | Promise<Response>;
};

type MiddlewarePlan = {
  required: Array<{ name: string; value: string }>;
  responseHeaders: Array<[string, string]>;
};

type CompiledTemplate =
  | {
      kind: "static";
      body: string;
    }
  | {
      kind: "simple";
      prefix: string;
      param: string;
      suffix: string;
    }
  | {
      kind: "parts";
      parts: TemplatePart[];
    };

const NOT_FOUND = new Response("Not Found", { status: 404 });
const METHOD_NOT_ALLOWED = new Response("Method Not Allowed", { status: 405 });
const EMPTY = new Response(null, { status: 204 });
const TEXT_INIT = {
  headers: {
    "content-type": "text/plain; charset=utf-8"
  }
} satisfies ResponseInit;

export class Context {
  readonly req: Request;
  readonly params: Params;
  #url?: URL;
  #query?: Query;

  constructor(req: Request, params: Params) {
    this.req = req;
    this.params = params;
  }

  get url(): URL {
    return (this.#url ??= new URL(this.req.url));
  }

  get query(): Query {
    if (this.#query) return this.#query;

    const query: Query = Object.create(null);
    for (const [key, value] of this.url.searchParams) {
      const current = query[key];
      if (current === undefined) {
        query[key] = value;
      } else if (Array.isArray(current)) {
        current.push(value);
      } else {
        query[key] = [current, value];
      }
    }
    this.#query = query;
    return query;
  }

  text(body: string, status = 200, headers?: HeadersInit): Response {
    if (status === 200 && headers === undefined) {
      return new Response(body, TEXT_INIT);
    }

    return new Response(body, {
      status,
      headers: withContentType(headers, "text/plain; charset=utf-8")
    });
  }

  json(body: unknown, status = 200, headers?: HeadersInit): Response {
    return Response.json(body, {
      status,
      headers
    });
  }

  empty(status = 204, headers?: HeadersInit): Response {
    if (status === 204 && headers === undefined) return EMPTY;
    return new Response(null, { status, headers });
  }

  redirect(location: string, status = 302): Response {
    return Response.redirect(location, status);
  }
}

export class FastServer {
  #staticRoutes = new Map<string, RouteHandler>();
  #staticPaths = new Set<string>();
  #dynamicRoutes: Route[] = [];
  #middleware: CMiddleware[] = [];
  #corsPreflightHeaders?: Array<[string, string]>;
  #jit: boolean;

  constructor(options: { jit?: boolean } = {}) {
    this.#jit = options.jit ?? false;
  }

  use(...middleware: Array<CMiddleware | CMiddleware[]>): this {
    for (const item of middleware.flat()) {
      this.#middleware.push(item);
      if (item.kind === "cors") {
        this.#corsPreflightHeaders = compileMiddlewarePlan([item]).responseHeaders;
      }
    }
    return this;
  }

  get(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("GET", path, handler, options);
  }

  post(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("POST", path, handler, options);
  }

  put(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("PUT", path, handler, options);
  }

  patch(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("PATCH", path, handler, options);
  }

  delete(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("DELETE", path, handler, options);
  }

  options(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("OPTIONS", path, handler, options);
  }

  head(path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    return this.route("HEAD", path, handler, options);
  }

  route(method: Method, path: string, handler: RouteInput, options: CRouteOptions = {}): this {
    assertPath(path);
    const plan = compileMiddlewarePlan(this.#middleware, options.middleware ?? []);
    const routeHandler = toHandler(handler, plan, this.#jit);
    const bunHandler = this.#jit ? toBunRouteHandler(handler, plan) : undefined;

    if (path.includes(":")) {
      this.#dynamicRoutes.push(compileRoute(method, path, routeHandler, bunHandler));
      if (method === "GET") {
        this.#dynamicRoutes.push(compileRoute("HEAD", path, routeHandler, bunHandler));
      }
      return this;
    }

    this.#staticRoutes.set(routeKey(method, path), routeHandler);
    this.#staticPaths.add(path);
    if (method === "GET") {
      this.#staticRoutes.set(routeKey("HEAD", path), routeHandler);
    }
    return this;
  }

  fetch(req: Request): Response | Promise<Response> {
    const method = req.method as Method;
    const pathname = req.url.includes("?")
      ? new URL(req.url).pathname
      : req.url.startsWith("http")
        ? new URL(req.url).pathname
        : req.url;

    if (method === "OPTIONS") {
      if (this.#corsPreflightHeaders) {
        return new Response(null, { status: 204, headers: this.#corsPreflightHeaders });
      }
    }

    const staticHandler = this.#staticRoutes.get(routeKey(method, pathname));
    if (staticHandler) return staticHandler(req, Object.create(null));

    const dynamic = this.#matchDynamic(method, pathname);
    if (dynamic) return dynamic.handler(req, dynamic.params);

    if (this.#hasPath(pathname)) {
      return METHOD_NOT_ALLOWED;
    }

    return NOT_FOUND;
  }

  listen(port: number, hostnameOrOptions: string | FastListenOptions = "0.0.0.0"): Server<undefined> {
    const options =
      typeof hostnameOrOptions === "string" ? { hostname: hostnameOrOptions } : hostnameOrOptions;
    const hostname = options.hostname ?? "0.0.0.0";
    const routes = this.#bunRoutes();

    const server = Bun.serve({
      hostname,
      port,
      reusePort: options.reusePort,
      routes,
      fetch: (req) => this.fetch(req)
    });

    console.log(`hotpath listening on http://${server.hostname}:${server.port}`);
    return server;
  }

  #bunRoutes(): Record<
    string,
    Partial<Record<Method, (req: BunRequest<string>) => Response | Promise<Response>>>
  > {
    const routes: Record<
      string,
      Partial<Record<Method, (req: BunRequest<string>) => Response | Promise<Response>>>
    > = Object.create(null);

    for (const [key, handler] of this.#staticRoutes) {
      const [method, path] = splitRouteKey(key);
      const bucket = (routes[path] ??= Object.create(null));
      bucket[method] = (req) => handler(req, Object.create(null));
    }

    for (const route of this.#dynamicRoutes) {
      const bucket = (routes[route.path] ??= Object.create(null));
      bucket[route.method] = route.bunHandler ?? ((req) => route.handler(req, req.params as Params));
      if (route.method === "GET") {
        bucket.HEAD = route.bunHandler ?? ((req) => route.handler(req, req.params as Params));
      }
    }

    return routes;
  }

  #matchDynamic(method: Method, pathname: string): { handler: RouteHandler; params: Params } | undefined {
    const parts = splitPath(pathname);

    for (const route of this.#dynamicRoutes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;

      let paramIndex = 0;
      const params: Params = Object.create(null);
      let matched = true;

      for (let i = 0; i < route.parts.length; i += 1) {
        const expected = route.parts[i];
        const actual = parts[i];

        if (expected.charCodeAt(0) === 58) {
          params[route.paramNames[paramIndex++]] = decodeURIComponent(actual);
        } else if (expected !== actual) {
          matched = false;
          break;
        }
      }

      if (matched) return { handler: route.handler, params };
    }

    return undefined;
  }

  #hasPath(pathname: string): boolean {
    if (this.#staticPaths.has(pathname)) return true;

    const parts = splitPath(pathname);
    return this.#dynamicRoutes.some((route) => {
      if (route.parts.length !== parts.length) return false;
      for (let i = 0; i < route.parts.length; i += 1) {
        const expected = route.parts[i];
        if (expected.charCodeAt(0) !== 58 && expected !== parts[i]) return false;
      }
      return true;
    });
  }
}

export { FastServer as HotpathServer };
export { CContext, CServer, compiled, cors, header, headers, html, json, jsonTemplate, native, reply, requireHeader, template, text };
export type { CHandler, CMiddleware, CNativeContext, CNativeValue, CReply, CRouteOptions };

export function Hotpath(options: { adapter: "c"; jit?: boolean; fallback?: { jit?: boolean; transport?: "http" | "tcp" | "unix" } }): CServer;
export function Hotpath<TServer>(options: { adapter: HotpathAdapterObject<TServer> }): TServer;
export function Hotpath(options?: { adapter?: "bun"; jit?: boolean }): FastServer;
export function Hotpath(options: HotpathOptions = {}): FastServer | CServer {
  if (typeof options.adapter === "object") {
    return options.adapter.create();
  }

  return options.adapter === "c"
    ? new CServer({
        fallbackJit: options.fallback?.jit ?? options.jit,
        fallbackTransport: options.fallback?.transport
      })
    : new FastServer({ jit: options.jit });
}

function compileRoute(
  method: Method,
  path: string,
  handler: RouteHandler,
  bunHandler?: (req: BunRequest<string>) => Response | Promise<Response>
): Route {
  const parts = splitPath(path);
  const paramNames = parts
    .filter((part) => part.charCodeAt(0) === 58)
    .map((part) => part.slice(1));

  return { method, path, parts, paramNames, handler, bunHandler };
}

function splitPath(path: string): string[] {
  if (path === "/") return [];
  return path.slice(1).split("/");
}

function routeKey(method: Method, path: string): string {
  return `${method} ${path}`;
}

function splitRouteKey(key: string): [Method, string] {
  const index = key.indexOf(" ");
  return [key.slice(0, index) as Method, key.slice(index + 1)];
}

function assertPath(path: string): void {
  if (!path.startsWith("/")) {
    throw new TypeError(`Route path must start with "/": ${path}`);
  }
}

function toHandler(input: RouteInput, plan: MiddlewarePlan, jit: boolean): RouteHandler {
  if (typeof input === "function") {
    if (jit) return compileJitCallbackHandler(input, plan);

    if (plan.required.length === 0 && plan.responseHeaders.length === 0) {
      return (req, params) => input(new Context(req, params));
    }

    return async (req, params) => {
      if (!middlewareAllows(req, plan)) return unauthorized();
      const response = await input(new Context(req, params));
      return plan.responseHeaders.length === 0 ? response : applyMiddlewareToResponse(response, plan);
    };
  }

  const status = input.status ?? 200;
  const headers = compileResponseHeaders(input.headers, plan);
  const compiled = compileTemplate(input.body);

  if (jit) return compileJitDeclarativeHandler(status, headers, compiled, plan);

  if (compiled.kind === "static") {
    return (req) => {
      if (!middlewareAllows(req, plan)) return unauthorized();
      return new Response(compiled.body, { status, headers });
    };
  }

  return (req, params) => {
    if (!middlewareAllows(req, plan)) return unauthorized();
    return new Response(renderCompiledTemplate(compiled, params), { status, headers });
  };
}

function toBunRouteHandler(
  input: RouteInput,
  plan: MiddlewarePlan
): ((req: BunRequest<string>) => Response | Promise<Response>) | undefined {
  if (typeof input === "function") {
    return compileJitBunCallbackHandler(input, plan);
  }

  return compileJitBunDeclarativeHandler(
    input.status ?? 200,
    compileResponseHeaders(input.headers, plan),
    compileTemplate(input.body),
    plan
  );
}

function compileJitBunCallbackHandler(
  input: Handler,
  plan: MiddlewarePlan
): (req: BunRequest<string>) => Response | Promise<Response> {
  const checks = compileRequiredHeaderChecks(plan);
  const source = `
    return async function hotpathJitBunCallback(req) {
      ${checks}
      const response = await input(new Context(req, req.params));
      return hasResponseHeaders ? apply(response, plan) : response;
    }
  `;

  return new Function(
    "Context",
    "input",
    "apply",
    "plan",
    "hasResponseHeaders",
    "unauthorized",
    source
  )(Context, input, applyMiddlewareToResponse, plan, plan.responseHeaders.length > 0, unauthorized) as (
    req: BunRequest<string>
  ) => Response | Promise<Response>;
}

function compileJitBunDeclarativeHandler(
  status: number,
  headers: Array<[string, string]>,
  template: CompiledTemplate,
  plan: MiddlewarePlan
): (req: BunRequest<string>) => Response {
  const checks = compileRequiredHeaderChecks(plan);
  const bodyExpression = compileBunTemplateExpression(template);
  const source = `
    return function hotpathJitBunDeclarative(req) {
      ${checks}
      return new Response(${bodyExpression}, { status, headers });
    }
  `;

  return new Function(
    "Response",
    "status",
    "headers",
    "unauthorized",
    source
  )(Response, status, headers, unauthorized) as (req: BunRequest<string>) => Response;
}

function compileJitCallbackHandler(input: Handler, plan: MiddlewarePlan): RouteHandler {
  const checks = compileRequiredHeaderChecks(plan);
  const source = `
    return async function hotpathJitCallback(req, params) {
      ${checks}
      const response = await input(new Context(req, params));
      return hasResponseHeaders ? apply(response, plan) : response;
    }
  `;

  return new Function(
    "Context",
    "input",
    "apply",
    "plan",
    "hasResponseHeaders",
    "unauthorized",
    source
  )(Context, input, applyMiddlewareToResponse, plan, plan.responseHeaders.length > 0, unauthorized) as RouteHandler;
}

function compileJitDeclarativeHandler(
  status: number,
  headers: Array<[string, string]>,
  template: CompiledTemplate,
  plan: MiddlewarePlan
): RouteHandler {
  const checks = compileRequiredHeaderChecks(plan);
  const bodyExpression = compileTemplateExpression(template);
  const source = `
    return function hotpathJitDeclarative(req, params) {
      ${checks}
      return new Response(${bodyExpression}, { status, headers });
    }
  `;

  return new Function(
    "Response",
    "status",
    "headers",
    "unauthorized",
    source
  )(Response, status, headers, unauthorized) as RouteHandler;
}

function compileRequiredHeaderChecks(plan: MiddlewarePlan): string {
  if (plan.required.length === 0) return "";
  return plan.required
    .map(
      (item) =>
        `if (req.headers.get(${JSON.stringify(item.name)}) !== ${JSON.stringify(item.value)}) return unauthorized();`
    )
    .join("\n");
}

function compileTemplateExpression(template: CompiledTemplate): string {
  switch (template.kind) {
    case "static":
      return JSON.stringify(template.body);
    case "simple":
      return `${JSON.stringify(template.prefix)} + (params[${JSON.stringify(template.param)}] ?? "") + ${JSON.stringify(template.suffix)}`;
    case "parts":
      return template.parts
        .map((part) =>
          typeof part === "string"
            ? JSON.stringify(part)
            : `(params[${JSON.stringify(part.param)}] ?? "")`
        )
        .join(" + ");
  }
}

function compileBunTemplateExpression(template: CompiledTemplate): string {
  switch (template.kind) {
    case "static":
      return JSON.stringify(template.body);
    case "simple":
      return `${JSON.stringify(template.prefix)} + (req.params[${JSON.stringify(template.param)}] ?? "") + ${JSON.stringify(template.suffix)}`;
    case "parts":
      return template.parts
        .map((part) =>
          typeof part === "string"
            ? JSON.stringify(part)
            : `(req.params[${JSON.stringify(part.param)}] ?? "")`
        )
        .join(" + ");
  }
}

function applyMiddlewareToResponse(
  response: Response,
  plan: MiddlewarePlan
): Response {
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

function compileMiddlewarePlan(globalMiddleware: CMiddleware[], routeMiddleware: CMiddleware[] = []): MiddlewarePlan {
  const required: MiddlewarePlan["required"] = [];
  const responseHeaders: MiddlewarePlan["responseHeaders"] = [];

  for (const middleware of [...globalMiddleware, ...routeMiddleware]) {
    switch (middleware.kind) {
      case "header":
        responseHeaders.push([middleware.name, middleware.value]);
        break;
      case "cors":
        responseHeaders.push(["access-control-allow-origin", middleware.origin]);
        responseHeaders.push(["access-control-allow-methods", middleware.methods]);
        if (middleware.headers) responseHeaders.push(["access-control-allow-headers", middleware.headers]);
        if (middleware.credentials) responseHeaders.push(["access-control-allow-credentials", "true"]);
        if (middleware.maxAge !== undefined) {
          responseHeaders.push(["access-control-max-age", String(middleware.maxAge)]);
        }
        break;
      case "require-header":
        required.push({ name: middleware.name, value: middleware.value });
        break;
    }
  }

  return { required, responseHeaders };
}

function compileResponseHeaders(
  base: Record<string, string> | undefined,
  plan: MiddlewarePlan
): Array<[string, string]> {
  const headers: Array<[string, string]> = base ? Object.entries(base) : [];
  headers.push(...plan.responseHeaders);
  return headers;
}

function middlewareAllows(req: Request, plan: MiddlewarePlan): boolean {
  for (const required of plan.required) {
    if (req.headers.get(required.name) !== required.value) return false;
  }
  return true;
}

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: [["content-type", "text/plain; charset=utf-8"]]
  });
}

function compileTemplate(body: string): CompiledTemplate {
  const open = body.indexOf("{");
  if (open < 0) return { kind: "static", body };

  const close = body.indexOf("}", open + 1);
  if (close > open && body.indexOf("{", close + 1) < 0) {
    return {
      kind: "simple",
      prefix: body.slice(0, open),
      param: body.slice(open + 1, close),
      suffix: body.slice(close + 1)
    };
  }

  const parts: TemplatePart[] = [];
  let cursor = 0;
  const pattern = /\{([^}]+)\}/g;
  for (;;) {
    const match = pattern.exec(body);
    if (!match) break;
    if (match.index > cursor) parts.push(body.slice(cursor, match.index));
    parts.push({ param: match[1] });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) parts.push(body.slice(cursor));
  return { kind: "parts", parts };
}

function renderCompiledTemplate(template: CompiledTemplate, params: Params): string {
  switch (template.kind) {
    case "static":
      return template.body;
    case "simple":
      return `${template.prefix}${params[template.param] ?? ""}${template.suffix}`;
    case "parts": {
      let out = "";
      for (const part of template.parts) {
        out += typeof part === "string" ? part : params[part.param] ?? "";
      }
      return out;
    }
  }
}

function withContentType(headers: HeadersInit | undefined, contentType: string): Headers {
  const next = new Headers(headers);
  if (!next.has("content-type")) next.set("content-type", contentType);
  return next;
}
