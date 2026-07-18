// Geração e compartilhamento de "card de replay" da rodada do Verbete.
// Renderiza um PNG quadrado (1080x1350, formato story) com a palavra,
// a verdade, e quem caiu em qual blefe. Usa Web Share API com File quando
import { APP_HOST } from "@/lib/app-url";
// disponível (mobile, ideal para Stories/WhatsApp/TikTok); fallback faz download.

export interface ReplayCardData {
  word: string;
  truth: string;
  fooled: { author: string; emoji: string; voters: { name: string; emoji: string }[]; text: string }[];
  truthHits: { name: string; emoji: string }[];
  roomCode: string;
}

const W = 1080;
const H = 1350;

function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number): number {
  const words = text.split(" ");
  let line = "";
  let cy = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      line = w;
      cy += lineH;
    } else {
      line = test;
    }
  }
  if (line) { ctx.fillText(line, x, cy); cy += lineH; }
  return cy;
}

export async function generateReplayCard(data: ReplayCardData): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // Fundo
  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#2b0b4a");
  grad.addColorStop(1, "#0a0220");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Confetes decorativos
  const confetti = ["🎉", "✨", "🎊", "💫", "🤥", "🎯"];
  for (let i = 0; i < 14; i++) {
    ctx.font = `${48 + (i % 3) * 12}px sans-serif`;
    ctx.globalAlpha = 0.18;
    ctx.fillText(confetti[i % confetti.length], (i * 137) % W, 40 + ((i * 211) % H));
  }
  ctx.globalAlpha = 1;

  // Header "VERBETE"
  ctx.fillStyle = "#FFD93D";
  ctx.font = "bold 56px system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText("VERBETE", 60, 60);
  ctx.fillStyle = "#ffffffaa";
  ctx.font = "28px system-ui, sans-serif";
  ctx.fillText("sala #" + data.roomCode, 60, 130);

  // Palavra (grande)
  ctx.fillStyle = "#ffffffcc";
  ctx.font = "26px system-ui, sans-serif";
  ctx.fillText("A palavra era…", 60, 210);
  ctx.fillStyle = "#FF4FA3";
  ctx.font = "bold 110px Georgia, serif";
  ctx.fillText(data.word ? data.word.charAt(0).toUpperCase() + data.word.slice(1) : "", 60, 250);

  // Verdade
  ctx.fillStyle = "#7CF0BD";
  ctx.font = "bold 30px system-ui, sans-serif";
  ctx.fillText("✅ Significado real:", 60, 400);
  ctx.fillStyle = "#ffffffee";
  ctx.font = "30px system-ui, sans-serif";
  let y = wrap(ctx, `"${data.truth}"`, 60, 450, W - 120, 42);

  y += 40;
  ctx.fillStyle = "#FFD93D";
  ctx.font = "bold 32px system-ui, sans-serif";
  ctx.fillText("🤥 Quem enganou quem", 60, y);
  y += 60;

  ctx.font = "26px system-ui, sans-serif";
  if (data.fooled.length === 0) {
    ctx.fillStyle = "#ffffffaa";
    ctx.fillText("Ninguém caiu em nenhum blefe nesta rodada 😅", 60, y);
    y += 50;
  } else {
    for (const f of data.fooled.slice(0, 5)) {
      if (y > H - 220) break;
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 28px system-ui, sans-serif";
      const victims = f.voters.map((v) => v.emoji + " " + v.name).join(", ");
      ctx.fillText(`${f.emoji} ${f.author} enganou:`, 60, y);
      y += 38;
      ctx.fillStyle = "#FF4FA3";
      ctx.font = "26px system-ui, sans-serif";
      y = wrap(ctx, victims, 80, y, W - 140, 34);
      y += 18;
    }
  }

  // Acertaram a verdade
  if (data.truthHits.length > 0 && y < H - 160) {
    y += 10;
    ctx.fillStyle = "#7CF0BD";
    ctx.font = "bold 28px system-ui, sans-serif";
    ctx.fillText("🎯 Acertaram a verdade:", 60, y);
    y += 38;
    ctx.fillStyle = "#ffffffdd";
    ctx.font = "26px system-ui, sans-serif";
    wrap(ctx, data.truthHits.map((h) => h.emoji + " " + h.name).join(", "), 60, y, W - 120, 34);
  }

  // Footer
  ctx.fillStyle = "#ffffff88";
  ctx.font = "24px system-ui, sans-serif";
  ctx.fillText(`jogue em ${APP_HOST}`, 60, H - 60);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png", 0.95);
  });
}

export async function shareReplayCard(data: ReplayCardData): Promise<"shared" | "downloaded" | "error"> {
  try {
    const blob = await generateReplayCard(data);
    const file = new File([blob], `verbete-replay-${data.roomCode}.png`, { type: "image/png" });
    const text = `Olha esse blefe no Verbete 🤥 a palavra era "${data.word}". Joga comigo: ${APP_HOST}`;
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare && nav.canShare({ files: [file] })) {
      await navigator.share({ files: [file], text, title: "Verbete" });
      return "shared";
    }
    // Fallback: força download
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return "downloaded";
  } catch (e) {
    console.error("shareReplayCard failed", e);
    return "error";
  }
}


