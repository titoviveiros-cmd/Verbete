// Avatares cartoon (emoji-based para V1, leves e expressivos).
export const AVATARS = [
  "🦊", "🐻", "🐼", "🐯", "🦁", "🐸", "🐙", "🦄",
  "🐶", "🐱", "🐵", "🐨", "🐰", "🦉", "🐲", "👻",
];

export const COLORS = [
  "#FF5C8A", "#FFD166", "#06D6A0", "#118AB2",
  "#A155F0", "#F58A07", "#22D3EE", "#F472B6",
];

export function randomAvatar() {
  return AVATARS[Math.floor(Math.random() * AVATARS.length)];
}
export function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}


