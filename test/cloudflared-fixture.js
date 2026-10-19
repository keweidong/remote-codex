// Stands in for cloudflared so tests can assert how the tunnel is launched
// without touching the network. Output paths are absolute: the child inherits
// an unspecified cwd, so nothing may depend on it.
export function cloudflaredFixture(outDir, options = {}) {
  return `
const fs = require("node:fs");
const path = require("node:path");
const o = ${JSON.stringify({ outDir, mode: "token", url: "https://probe-1234.trycloudflare.com", ...options })};
const at = (name) => path.join(o.outDir, name);
fs.writeFileSync(at("argv.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(at("env.json"), JSON.stringify({
  TUNNEL_TOKEN: process.env.TUNNEL_TOKEN || "",
  NO_COLOR: process.env.NO_COLOR || "",
}));
fs.appendFileSync(at("spawns.txt"), "spawn\\n");
if (o.exitCode !== null && o.exitCode !== undefined) process.exit(o.exitCode);
if (o.mode === "token") console.log("INF Registered tunnel connection connIndex=0 location=sjc04");
else console.log("Your quick Tunnel has been created! Visit it at " + o.url);
setInterval(() => {}, 1000);
`;
}
