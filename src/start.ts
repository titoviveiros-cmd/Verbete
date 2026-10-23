import { createStart, createMiddleware } from "@tanstack/react-start";

import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { renderErrorPage } from "./lib/error-page";
import { serverFnFetch } from "./lib/server-fn-transport";

// Todas as funções de servidor passam por aqui: no app nativo vão para a URL
// pública do Worker e nenhuma resposta vale só por ser HTTP 200.
export const serverFnsConfig = { fetch: serverFnFetch };

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

export const startInstance = createStart(() => ({
  requestMiddleware: [errorMiddleware],
  functionMiddleware: [attachSupabaseAuth],
  serverFns: serverFnsConfig,
}));
