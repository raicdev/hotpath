const workers = Number(process.env.WASM_WORKERS ?? 6);
const port = Number(process.env.PORT ?? 3030);
const children: Array<ReturnType<typeof Bun.spawn>> = [];

for (let i = 0; i < workers; i += 1) {
  children.push(
    Bun.spawn(["bun", "bench/wasm.ts"], {
      env: {
        ...process.env,
        PORT: String(port),
        REUSE_PORT: "1"
      },
      stdout: "inherit",
      stderr: "inherit"
    })
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of children) child.kill();
    process.exit(0);
  });
}

await new Promise(() => {});

export {};
