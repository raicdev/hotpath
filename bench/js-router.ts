Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/hello/")) {
      return new Response(`hello ${url.pathname.slice("/hello/".length)}`, {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }
    if (url.pathname === "/") {
      return new Response("ok", {
        headers: {
          "content-type": "text/plain; charset=utf-8"
        }
      });
    }
    return new Response("Not Found", { status: 404 });
  }
});

console.log(`js-router listening on http://0.0.0.0:${process.env.PORT ?? 3000}`);
