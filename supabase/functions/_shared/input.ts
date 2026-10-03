// Validação da entrada das edges públicas (sem JWT). Pedido malformado é
// erro de quem chamou: responde 400 sem registrar "erro de IA" — senão
// qualquer um dispararia o alerta ai_errors mandando lixo.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Corpo do pedido como objeto JSON, ou null se não for um. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
