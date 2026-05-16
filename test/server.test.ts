import { describe, expect, test } from "bun:test";
import { FastServer } from "../src/index";

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
});
