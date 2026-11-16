export function checkNativeBundle(o: {
  texts: string[];
  channel?: string;
  versionName?: string;
  versionCode?: number;
}): { problems: string[]; facts: Record<string, string | number> };
