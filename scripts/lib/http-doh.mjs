// GET/HEAD com fallback de DNS: o DNS da máquina do dono não resolve
// *.workers.dev — quando o DNS do sistema falha, resolve por DNS-over-HTTPS
// (Cloudflare) e conecta no IP, mantendo o nome no TLS (SNI/certificado).
import https from "node:https";

async function dohLookup(host) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${host}&type=A`, {
    headers: { accept: "application/dns-json" },
  });
  const ip = (await r.json()).Answer?.find((a) => a.type === 1)?.data;
  if (!ip) throw new Error(`DoH sem resposta para ${host}`);
  return ip;
}

/** @returns {Promise<{status: number, type: string, body: string, viaDoh: boolean}>} */
export function httpGet(url, method = "GET", viaDoh = false) {
  return new Promise((resolve, reject) => {
    const lookup = viaDoh
      ? (host, opts, cb) =>
          dohLookup(host).then(
            (ip) => (opts?.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)),
            (e) => cb(e),
          )
      : undefined;
    const req = https.request(url, { method, lookup, timeout: 20_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, type: res.headers["content-type"] ?? "", body, viaDoh }),
      );
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) =>
      !viaDoh && /ENOTFOUND|EAI_AGAIN/.test(e.code ?? e.message)
        ? httpGet(url, method, true).then(resolve, reject)
        : reject(e),
    );
    req.end();
  });
}
