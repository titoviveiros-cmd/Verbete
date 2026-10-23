// Tema antes da primeira pintura (decisão de produto 2026-10-21): sem
// preferência salva → CLARO; "dark" salvo → escuro. Mesma regra de
// hooks/use-theme.ts. Sem localStorage (aba privada bloqueada) → claro.
// Vai como o primeiro <script> síncrono do <head> (__root.tsx).
export const THEME_BOOT_SCRIPT = [
  "(function(){",
  "var d=false;",
  'try{d=localStorage.getItem("verbete:theme")==="dark"}catch(e){}',
  "var r=document.documentElement;",
  'if(d){r.classList.remove("light")}else{r.classList.add("light")}',
  'r.style.colorScheme=d?"dark":"light";',
  "var m=document.querySelector('meta[name=\"theme-color\"]');",
  'if(m){m.setAttribute("content",d?"#150a2c":"#fbf3e3")}',
  "})();",
].join("");
