import worker from "../workers/wasm";

const req = new Request("https://worker.test/hello/rai");
const iterations = Number(process.env.ITERATIONS ?? 100_000);

for (let i = 0; i < 1_000; i += 1) {
  await worker.fetch(req);
}

const started = performance.now();
for (let i = 0; i < iterations; i += 1) {
  const res = await worker.fetch(req);
  await res.text();
}
const elapsed = performance.now() - started;

console.log(`${iterations} worker fetch calls in ${elapsed.toFixed(2)} ms`);
console.log(`${Math.round((iterations / elapsed) * 1000).toLocaleString()} calls/sec`);
