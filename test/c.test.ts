import { afterAll, describe, expect, test } from "bun:test";
import { CServer, cors, header, jsonTemplate, native, requireHeader, text } from "../src/c";

const servers: Array<{ stop: () => void }> = [];

afterAll(() => {
  for (const server of servers) server.stop();
});

describe("CServer middleware", () => {
  test("applies global headers, CORS, and per-route header checks", async () => {
    const port = 31_230;
    const app = new CServer();

    app.use(cors());
    app.use(header("x-powered-by", "hotpath"));
    app.get("/", text("ok"));
    app.get("/private", text("secret"), {
      middleware: [requireHeader("authorization", "Bearer bench-token")]
    });

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/`);

    const root = await fetch(`http://127.0.0.1:${port}/`);
    expect(root.headers.get("x-powered-by")).toBe("hotpath");
    expect(root.headers.get("access-control-allow-origin")).toBe("*");
    expect(await root.text()).toBe("ok");

    const denied = await fetch(`http://127.0.0.1:${port}/private`);
    expect(denied.status).toBe(401);

    const allowed = await fetch(`http://127.0.0.1:${port}/private`, {
      headers: { authorization: "Bearer bench-token" }
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("secret");

    const preflight = await fetch(`http://127.0.0.1:${port}/private`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("OPTIONS");
  });

  test("proxies handler routes to the TypeScript fallback path", async () => {
    const port = 31_231;
    const app = new CServer({ fallbackJit: true });

    app.use(header("x-powered-by", "hotpath"));
    app.get("/health", text("ok"));
    app.get("/users/:id", async (ctx) => {
      await Bun.sleep(1);
      return ctx.json({ id: ctx.params.id, source: "typescript" });
    });

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/health`);

    const hot = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await hot.text()).toBe("ok");

    const fallback = await fetch(`http://127.0.0.1:${port}/users/42`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("x-powered-by")).toBe("hotpath");
    expect(await fallback.json()).toEqual({ id: "42", source: "typescript" });
  });

  test("uses the TCP fallback transport for handler routes", async () => {
    const port = 31_232;
    const app = new CServer({ fallbackJit: true, fallbackTransport: "tcp" });

    app.get("/health", text("ok"));
    app.get("/slow/:id", (ctx) => ctx.json({ id: ctx.params.id, transport: "tcp" }));

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/health`);

    const fallback = await fetch(`http://127.0.0.1:${port}/slow/7`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("application/json");
    expect(await fallback.json()).toEqual({ id: "7", transport: "tcp" });
  });

  test.skipIf(process.platform === "win32")("uses the Unix fallback transport for handler routes", async () => {
    const port = 31_233;
    const app = new CServer({ fallbackJit: true, fallbackTransport: "unix" });

    app.get("/health", text("ok"));
    app.get("/slow/:id", (ctx) => ctx.json({ id: ctx.params.id, transport: "unix" }));

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/health`);

    const fallback = await fetch(`http://127.0.0.1:${port}/slow/7`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("application/json");
    expect(await fallback.json()).toEqual({ id: "7", transport: "unix" });
  });

  test("renders JSON templates in the C core", async () => {
    const port = 31_234;
    const app = new CServer();

    app.get("/users/:id", jsonTemplate({ id: "{id}", source: "c-template" }));

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/users/42`);

    const res = await fetch(`http://127.0.0.1:${port}/users/42`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ id: "42", source: "c-template" });
  });

  test("supports Hono-like native compiled handlers", async () => {
    const port = 31_235;
    const app = new CServer();

    app.get("/users/:id", native((c) => c.json({ id: c.req.param("id"), source: "native" })));
    app.get("/hello/:name", native((c) => c.text(`hello ${c.req.param("name")}`)));

    const server = await app.listen(port, { hostname: "127.0.0.1", threads: 1 });
    servers.push(server);
    await waitForServer(`http://127.0.0.1:${port}/users/42`);

    const jsonRes = await fetch(`http://127.0.0.1:${port}/users/42`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
    expect(await jsonRes.json()).toEqual({ id: "42", source: "native" });

    const textRes = await fetch(`http://127.0.0.1:${port}/hello/rai`);
    expect(textRes.status).toBe(200);
    expect(await textRes.text()).toBe("hello rai");
  });
});

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      return;
    } catch {
      await Bun.sleep(50);
    }
  }

  throw new Error(`Server did not start: ${url}`);
}
