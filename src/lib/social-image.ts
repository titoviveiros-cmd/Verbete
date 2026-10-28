// Imagem da prévia de link (og:image / twitter:image), servida de public/.
// A VERSÃO no nome é proposital: o WhatsApp guarda a prévia por endereço, e
// trocar a arte com o mesmo nome deixa a imagem velha nos celulares. Arte
// nova = arquivo novo (scripts/gen-store-assets.mjs) + troca aqui.
// Módulo sem import.meta: o teste e2e/og-image.spec.ts também o importa.
// v3 (28/10/2026): tema claro, mesma identidade da ficha da Play —
// scripts/store/gen-social-v3.mjs. A v2 escura segue em public/ (caches).
export const SOCIAL_IMAGE = "verbete-social-v3-1200x630.jpg";
