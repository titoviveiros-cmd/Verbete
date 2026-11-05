export function verifyWebBundle(o: {
  distDir: string;
  expectedUrl?: string;
  expectedKey?: string;
  buildId?: string;
}): { ok: boolean; problems: string[]; facts: Record<string, number> };
