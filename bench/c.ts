import { CServer, json, text } from "../src/c";

const app = new CServer();

app.get("/", text("ok"));
app.get("/hello/:name", text("hello {name}"));
app.get("/json", json({ ok: true }));

const server = await app.listen(Number(process.env.PORT ?? 3000));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}

await new Promise(() => {});
