const port = process.env.PORT ?? "8787";
const n = Number(process.argv[2] ?? 10);
const res = await fetch(`http://localhost:${port}/api/warmup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ n }),
});
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
