import { describe, expect, it } from "vitest";
import { checkNativeBundle } from "../../../scripts/verify-native-artifact.mjs";

// Auditoria do bundle web dentro do AAB/APK (scripts/verify-native-artifact.mjs):
// o vc8 saiu com rodapé "Teste interno"; o AAB da loja (vc9) tem de sair com o
// canal production, a versão do build.gradle e o retorno do login nativo.
const env = (channel: string, name = "2.1.5", code = "9") =>
  `const e={VITE_RELEASE_CHANNEL:"${channel}",VITE_APP_VERSION_NAME:"${name}",VITE_NATIVE_VERSION_CODE:"${code}"};`;
const auth =
  'const s="app.verbete.game",cb=`${s}://auth/callback`;createClient(u,k,{auth:{flowType:"pkce"}});';

describe("checkNativeBundle", () => {
  it("aprova o bundle de loja: production, versão do gradle, login nativo", () => {
    const r = checkNativeBundle({
      texts: [env("production"), auth],
      channel: "production",
      versionName: "2.1.5",
      versionCode: 9,
    });
    expect(r.problems).toEqual([]);
    expect(r.facts).toMatchObject({ canal: "production", versionCode: "9" });
  });

  it("reprova o bundle de teste interno pedido como production (caso do vc8)", () => {
    const r = checkNativeBundle({
      texts: [
        env("internal", "2.1.4", "8"),
        'return["Teste interno",v].join(" · ")',
        auth,
      ],
      channel: "production",
      versionName: "2.1.5",
      versionCode: 9,
    });
    expect(r.problems.join("\n")).toMatch(/canal do bundle = "internal"/);
    expect(r.problems.join("\n")).toMatch(/"Teste interno" está no bundle/);
    expect(r.problems.join("\n")).toMatch(/versionName do bundle \(2\.1\.4\)/);
    expect(r.problems.join("\n")).toMatch(/versionCode do bundle \(8\)/);
  });

  it("falha fechado sem o marcador do canal ou sem o retorno do login", () => {
    const r = checkNativeBundle({
      texts: ["console.log(1)"],
      channel: "production",
    });
    expect(r.problems.join("\n")).toMatch(/canal do rodapé não identificado/);
    expect(r.problems.join("\n")).toMatch(/retorno do login nativo/);
    expect(r.problems.join("\n")).toMatch(/pkce/);
  });

  it("aceita o canal internal quando é o pedido (APK de debug da CI)", () => {
    const r = checkNativeBundle({
      texts: [env("internal"), 'return["Teste interno",v]', auth],
      channel: "internal",
      versionName: "2.1.5",
      versionCode: 9,
    });
    expect(r.problems).toEqual([]);
  });
});
