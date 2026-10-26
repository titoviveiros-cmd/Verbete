// Rodapé de versão da Home (decisão do Tito, 26/10). Pura: o app, o build
// (vite.config via build/native-env) e os testes usam a mesma função.
// O canal é decidido no BUILD (VITE_RELEASE_CHANNEL), nunca em runtime: o
// mesmo AAB pode subir de trilha na Play Store e o app não sabe em qual está.
//   internal   → "Teste interno · v2.1.2 (6) · 62fb060" (padrão do nativo)
//   preview    → "Preview · v2.1.2 · 62fb060"
//   production → "v2.1.2" (padrão do web; nada de infra no rodapé público)

export const RELEASE_CHANNELS = ["internal", "preview", "production"] as const;
export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

export function isReleaseChannel(v: unknown): v is ReleaseChannel {
  return (RELEASE_CHANNELS as readonly unknown[]).includes(v);
}

/** SHA curto (7) do build, ou null quando o build não tem SHA ("dev"). */
export function shortSha(buildId: string | null | undefined): string | null {
  return buildId && /^[0-9a-f]{7,40}$/i.test(buildId)
    ? buildId.slice(0, 7).toLowerCase()
    : null;
}

/** Texto do rodapé; null sem versionName (não inventa versão). */
export function versionLabel(info: {
  channel: ReleaseChannel;
  versionName: string | null | undefined;
  versionCode?: number | null;
  buildId?: string | null;
}): string | null {
  if (!info.versionName) return null;
  const v = `v${info.versionName}`;
  const sha = shortSha(info.buildId);
  if (info.channel === "internal")
    return [
      "Teste interno",
      info.versionCode ? `${v} (${info.versionCode})` : v,
      sha,
    ]
      .filter(Boolean)
      .join(" · ");
  if (info.channel === "preview")
    return ["Preview", v, sha].filter(Boolean).join(" · ");
  return v;
}
