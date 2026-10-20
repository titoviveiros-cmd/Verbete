// Intent-filters do APK: o retorno do login (app.verbete.game://auth/callback)
// precisa abrir o Verbete, e os App Links verificados dos convites
// (https://jogo.verbete.workers.dev/?join=) continuam no lugar.
// O esquema vem de @string/custom_url_scheme: no APK compilado ele é uma
// REFERÊNCIA de recurso (=@0x7f...), resolvida aqui pelo dump de recursos.
// Uso: node scripts/check-android-intents.mjs <apk> <aapt2>
import { spawnSync } from "node:child_process";

const [apk, aapt2] = process.argv.slice(2);
if (!apk || !aapt2) {
  console.error("uso: node scripts/check-android-intents.mjs <apk> <aapt2>");
  process.exit(2);
}
const dump = (args) => spawnSync(aapt2, args, { encoding: "utf8" }).stdout ?? "";
const manifest = dump(["dump", "xmltree", "--file", "AndroidManifest.xml", apk]);
const resources = dump(["dump", "resources", apk]);

let fails = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails++;
};
const flat = (s) => (s ?? "").replace(/\s+/g, " ").slice(0, 220);

const res = resources.match(/resource (0x[0-9a-f]+) string\/custom_url_scheme\s*\n\s*\(\)\s*"([^"]+)"/);
check(
  "string custom_url_scheme = app.verbete.game",
  res?.[2] === "app.verbete.game",
  res ? `${res[1]} = "${res[2]}"` : "recurso não encontrado",
);
const filters = manifest.split(/E: intent-filter/).slice(1).map((f) => f.split(/E: (?:activity|provider|service|receiver)\b/)[0]);
const schemeOf = (f) => f.match(/:scheme\([^)]*\)=(?:"([^"]+)"|@(0x[0-9a-f]+))/);
const view = (f) => /android\.intent\.action\.VIEW/.test(f) && /android\.intent\.category\.BROWSABLE/.test(f);

const own = filters.find((f) => {
  const s = schemeOf(f);
  return view(f) && (s?.[1] === "app.verbete.game" || (res && s?.[2] === res[1]));
});
check("esquema app.verbete.game abre o app (VIEW + BROWSABLE)", !!own, flat(own) || "nenhum filtro com o esquema");

const links = filters.find((f) => view(f) && /:host\([^)]*\)="jogo\.verbete\.workers\.dev"/.test(f));
check(
  "App Links dos convites preservados (https + host + autoVerify)",
  !!links && schemeOf(links)?.[1] === "https" && /:autoVerify\([^)]*\)=(?:true|"true"|\(type 0x12\)0xffffffff)/.test(links),
  flat(links) || "nenhum",
);
console.log(fails ? `\n${fails} FALHA(S) nos intent-filters` : "\nINTENT-FILTERS OK");
process.exit(fails ? 1 : 0);
