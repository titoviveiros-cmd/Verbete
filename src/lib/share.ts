// Compartilhamento de convite: share sheet nativo no app (o WebView do
// Android não implementa navigator.share), Web Share no navegador e cópia
// para a área de transferência como último recurso.
import { Capacitor } from "@capacitor/core";

export type ShareOutcome = "shared" | "copied" | "dismissed" | "failed";

const isCancel = (e: unknown) =>
  (e instanceof DOMException && e.name === "AbortError") ||
  /cancel/i.test(e instanceof Error ? e.message : String(e));

export async function shareInvite(opts: {
  title: string;
  text: string;
  url: string;
}): Promise<ShareOutcome> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { Share } = await import("@capacitor/share");
      await Share.share({
        title: opts.title,
        text: opts.text,
        url: opts.url,
        dialogTitle: "Convidar para o Verbete",
      });
      return "shared";
    } catch (e) {
      if (isCancel(e)) return "dismissed";
    }
  } else if (typeof navigator !== "undefined" && navigator.share) {
    try {
      await navigator.share(opts);
      return "shared";
    } catch (e) {
      if (isCancel(e)) return "dismissed";
    }
  }
  try {
    await navigator.clipboard.writeText(opts.url);
    return "copied";
  } catch {
    return "failed";
  }
}
