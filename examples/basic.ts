import { Hotpath, cors, header, headers, json, requireHeader, template, text } from "../src/index";

const app = Hotpath({ adapter: "bun", jit: true });

app.use(cors());
app.use(header("x-powered-by", "hotpath"));
app.use(headers({ "x-content-type-options": "nosniff" }));

app.get("/", text("ok"));
app.get("/hello/:name", template("hello {name}"));
app.get("/json", json({ ok: true, runtime: "bun" }));
app.get("/private", text("secret"), {
  middleware: [requireHeader("authorization", "Bearer bench-token")]
});
app.get("/slow/:id", async (ctx) => {
  await Bun.sleep(5);
  return ctx.json({ id: ctx.params.id, runtime: "typescript" });
});

await app.listen(Number(process.env.PORT ?? 3000));
await new Promise(() => {});
