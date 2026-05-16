import type { BunRequest, Server } from "bun";

export type Params = Record<string, string>;
export type Query = Record<string, string | string[]>;
export type Handler = (ctx: Context) => Response | Promise<Response>;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";

type Route = {
  method: Method;
  path: string;
  parts: string[];
  paramNames: string[];
  handler: Handler;
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
  #staticRoutes = new Map<string, Handler>();
  #dynamicRoutes: Route[] = [];

  get(path: string, handler: Handler): this {
    return this.route("GET", path, handler);
  }

  post(path: string, handler: Handler): this {
    return this.route("POST", path, handler);
  }

  put(path: string, handler: Handler): this {
    return this.route("PUT", path, handler);
  }

  patch(path: string, handler: Handler): this {
    return this.route("PATCH", path, handler);
  }

  delete(path: string, handler: Handler): this {
    return this.route("DELETE", path, handler);
  }

  options(path: string, handler: Handler): this {
    return this.route("OPTIONS", path, handler);
  }

  head(path: string, handler: Handler): this {
    return this.route("HEAD", path, handler);
  }

  route(method: Method, path: string, handler: Handler): this {
    assertPath(path);

    if (path.includes(":")) {
      this.#dynamicRoutes.push(compileRoute(method, path, handler));
      if (method === "GET") {
        this.#dynamicRoutes.push(compileRoute("HEAD", path, handler));
      }
      return this;
    }

    this.#staticRoutes.set(routeKey(method, path), handler);
    if (method === "GET") {
      this.#staticRoutes.set(routeKey("HEAD", path), handler);
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

    const staticHandler = this.#staticRoutes.get(routeKey(method, pathname));
    if (staticHandler) return staticHandler(new Context(req, Object.create(null)));

    const dynamic = this.#matchDynamic(method, pathname);
    if (dynamic) return dynamic.handler(new Context(req, dynamic.params));

    if (this.#hasPath(pathname)) {
      return METHOD_NOT_ALLOWED;
    }

    return NOT_FOUND;
  }

  listen(port: number, hostname = "0.0.0.0"): Server<undefined> {
    const routes = this.#bunRoutes();

    const server = Bun.serve({
      hostname,
      port,
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
      bucket[method] = (req) => handler(new Context(req, Object.create(null)));
    }

    for (const route of this.#dynamicRoutes) {
      const bucket = (routes[route.path] ??= Object.create(null));
      bucket[route.method] = (req) => handlerWithParams(req, route.handler);
      if (route.method === "GET") {
        bucket.HEAD = (req) => handlerWithParams(req, route.handler);
      }
    }

    return routes;
  }

  #matchDynamic(method: Method, pathname: string): { handler: Handler; params: Params } | undefined {
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
    for (const key of this.#staticRoutes.keys()) {
      const [, path] = splitRouteKey(key);
      if (path === pathname) return true;
    }

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

function compileRoute(method: Method, path: string, handler: Handler): Route {
  const parts = splitPath(path);
  const paramNames = parts
    .filter((part) => part.charCodeAt(0) === 58)
    .map((part) => part.slice(1));

  return { method, path, parts, paramNames, handler };
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

function handlerWithParams(req: BunRequest<string>, handler: Handler): Response | Promise<Response> {
  return handler(new Context(req, req.params as Params));
}

function withContentType(headers: HeadersInit | undefined, contentType: string): Headers {
  const next = new Headers(headers);
  if (!next.has("content-type")) next.set("content-type", contentType);
  return next;
}
