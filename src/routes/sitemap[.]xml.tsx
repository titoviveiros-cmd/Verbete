import { APP_URL } from "@/lib/app-url";
import { createFileRoute } from "@tanstack/react-router";

const URLS = [
  { loc: `${APP_URL}/`, priority: "1.0", changefreq: "weekly" },
  { loc: `${APP_URL}/daily`, priority: "0.9", changefreq: "daily" },
  { loc: `${APP_URL}/ranking`, priority: "0.7", changefreq: "daily" },
];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async () => {
        const today = new Date().toISOString().slice(0, 10);
        const body =
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
          `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
          URLS.map(
            (u) =>
              `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`,
          ).join("\n") +
          `\n</urlset>\n`;
        return new Response(body, {
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        });
      },
    },
  },
});
