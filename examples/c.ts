import {
  Hotpath,
} from "../src/index";
import { cors, header, headers, json, native, nativeAdapter, requireHeader, template, text } from "../src/native";

const app = Hotpath({
  adapter: nativeAdapter({ fallbackJit: true, fallbackTransport: "tcp" })
});

app.use(cors());
app.use(header("x-powered-by", "hotpath"));
app.use(headers({ "x-content-type-options": "nosniff" }));

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true, runtime: "c" }));
app.get("/private", text("secret"), {
  middleware: [requireHeader("authorization", "Bearer bench-token")],
});
app.get("/native/:id", native((c) => c.json({ id: c.req.param("id"), runtime: "native" })));
app.get("/slow/:id", async (ctx) => {
  return ctx.json({ id: ctx.params.id, runtime: "typescript" });
});

const server = await app.listen(Number(process.env.PORT ?? 3000));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}

await new Promise(() => {});
