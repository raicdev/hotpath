import { describe, expect, test } from "bun:test";
import { FastServer, Hotpath, cors, header, requireHeader, template, text } from "../src/index";
import { native, nativeAdapter } from "../src/native";

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe("FastServer", () => {
  test("handles static routes", async () => {
    const app = new FastServer();
    app.get("/", (c) => c.text("ok"));

    const res = await app.fetch(request("/") as never);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("handles params", async () => {
    const app = new FastServer();
    app.get("/users/:id", (c) => c.json({ id: c.params.id }));

    const res = await app.fetch(request("/users/42") as never);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "42" });
  });

  test("handles repeated query params", async () => {
    const app = new FastServer();
    app.get("/search", (c) => c.json(c.query));

    const res = await app.fetch(request("/search?tag=a&tag=b&q=x") as never);

    expect(await res.json()).toEqual({ tag: ["a", "b"], q: "x" });
  });

  test("returns 404", async () => {
    const app = new FastServer();

    const res = await app.fetch(request("/missing") as never);

    expect(res.status).toBe(404);
  });

  test("returns 405 for an existing path with a different method", async () => {
    const app = new FastServer();
    app.get("/users/:id", (c) => c.text(c.params.id));

    const res = await app.fetch(request("/users/42", { method: "POST" }) as never);

    expect(res.status).toBe(405);
  });

  test("Hotpath bun adapter handles declarative replies and middleware", async () => {
    const app = Hotpath({ adapter: "bun", jit: true });

    app.use(cors());
    app.use(header("x-powered-by", "hotpath"));
    app.get("/hello/:name", template("hello {name}"));
    app.get("/private", text("secret"), {
      middleware: [requireHeader("authorization", "Bearer bench-token")]
    });

    const hello = await app.fetch(request("/hello/rai") as never);
    expect(await hello.text()).toBe("hello rai");
    expect(hello.headers.get("x-powered-by")).toBe("hotpath");
    expect(hello.headers.get("access-control-allow-origin")).toBe("*");

    const denied = await app.fetch(request("/private") as never);
    expect(denied.status).toBe(401);

    const allowed = await app.fetch(
      request("/private", { headers: { authorization: "Bearer bench-token" } }) as never
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toBe("secret");
  });

  test("Hotpath accepts imported native adapter objects", async () => {
    const app = Hotpath({ adapter: nativeAdapter({ fallbackJit: true }) });

    app.get("/users/:id", native((c) => c.json({ id: c.req.param("id"), source: "native" })));

    const server = await app.listen(31_236, { hostname: "127.0.0.1", threads: 1 });
    try {
      await waitForServer("http://127.0.0.1:31236/users/42");
      const res = await fetch("http://127.0.0.1:31236/users/42");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "42", source: "native" });
    } finally {
      server.stop();
    }
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
