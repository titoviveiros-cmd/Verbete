import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// App Links dos convites (https://jogo.verbete.workers.dev/?join=…): o app
// instalado pela Google Play é assinado pela chave da Play App Signing, não
// pela chave de upload — sem a impressão digital dela no assetlinks.json o
// Android não verifica o domínio e o convite abre no navegador. A de upload
// fica (builds assinados localmente/CI).
const UPLOAD_KEY =
  "FA:CC:D8:6C:68:B9:66:9D:A7:DB:59:67:5F:8E:17:4F:A1:15:BF:F2:5A:3A:C8:A4:ED:E5:C8:CD:58:39:54:65";
const PLAY_APP_SIGNING_KEY =
  "71:6A:56:2C:D6:64:2F:CA:DA:13:33:0B:D8:27:76:98:F3:2D:43:D3:C3:5D:48:31:69:1C:0C:C4:6F:9A:60:97";

type Statement = {
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
};

const raw = readFileSync(
  join(__dirname, "..", "..", "..", "public", ".well-known", "assetlinks.json"),
  "utf8",
);

describe("assetlinks.json (App Links do Android)", () => {
  it("é JSON válido: uma declaração para o app", () => {
    const statements = JSON.parse(raw) as Statement[];
    expect(Array.isArray(statements)).toBe(true);
    expect(statements).toHaveLength(1);
  });

  const [s] = JSON.parse(raw) as Statement[];
  const prints = s!.target.sha256_cert_fingerprints;

  it("delega todos os links ao pacote app.verbete.game", () => {
    expect(s!.relation).toEqual(["delegate_permission/common.handle_all_urls"]);
    expect(s!.target.namespace).toBe("android_app");
    expect(s!.target.package_name).toBe("app.verbete.game");
  });

  it("aceita a chave de upload E a chave da Play App Signing", () => {
    expect(prints).toContain(UPLOAD_KEY);
    expect(prints).toContain(PLAY_APP_SIGNING_KEY);
  });

  it("sem duplicadas, todas no formato SHA-256 (32 bytes em hex maiúsculo)", () => {
    expect(new Set(prints).size).toBe(prints.length);
    for (const p of prints)
      expect(p).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });
});
