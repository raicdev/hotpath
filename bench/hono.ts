import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.text("ok"));
app.get("/hello/:name", (c) => c.text(`hello ${c.req.param("name")}`));
app.get("/json", (c) => c.json({ ok: true }));

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch
});

console.log(`hono listening on http://0.0.0.0:${process.env.PORT ?? 3000}`);
