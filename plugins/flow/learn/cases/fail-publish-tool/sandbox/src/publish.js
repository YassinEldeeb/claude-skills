// Publishes an HTML page to the pages service and returns its public URL.
export async function publishPage(html) {
  const res = await fetch("https://pages.example.com/api/publish", { method: "POST", headers: { "content-type": "text/html" }, body: html });
  if (!res.ok) throw new Error(`pages service answered ${res.status}`);
  return (await res.json()).url;
}
