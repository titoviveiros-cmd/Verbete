// Versão do build embarcada no bundle (VITE_BUILD_ID = git sha no deploy).
// Playtest 2026-07-20 20:15: o iOS mantém a aba viva por horas com código
// VELHO — correções nunca chegam a quem não recarrega. Ao retomar a aba,
// comparamos nosso build com o publicado (meta verbete-build no HTML do
// servidor) e recarregamos sozinhos quando há versão nova.
export const BUILD_ID: string =
  (import.meta.env.VITE_BUILD_ID as string | undefined) ?? "dev";

let checking = false;

export async function reloadIfOutdated(): Promise<void> {
  if (BUILD_ID === "dev") return; // dev server — HMR cuida
  if (checking) return;
  checking = true;
  try {
    const r = await fetch("/", {
      cache: "no-store",
      headers: { accept: "text/html" },
    });
    const html = await r.text();
    const tag = html.match(/<meta[^>]*verbete-build[^>]*>/)?.[0] ?? "";
    const remote = tag.match(/content="([^"]+)"/)?.[1];
    if (remote && remote !== "dev" && remote !== BUILD_ID) {
      window.location.reload();
    }
  } catch {
    // offline — segue com o bundle atual
  } finally {
    checking = false;
  }
}
