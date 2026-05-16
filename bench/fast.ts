import { FastServer } from "../src/index";

const app = new FastServer();

app.get("/", (c) => c.text("ok"));
app.get("/hello/:name", (c) => c.text(`hello ${c.params.name}`));
app.get("/json", (c) => c.json({ ok: true }));

app.listen(Number(process.env.PORT ?? 3000));
