import { beforeEach, describe, expect, it, vi } from "vitest";

const share = vi.fn();
let native = false;

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
}));
vi.mock("@capacitor/share", () => ({ Share: { share } }));

const { shareInvite } = await import("../share");
const invite = {
  title: "Verbete",
  text: "Bora jogar?",
  url: "https://jogo.verbete.workers.dev/?join=1234",
};
const writeText = vi.fn();

beforeEach(() => {
  native = false;
  share.mockReset();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  Object.defineProperty(navigator, "share", {
    value: undefined,
    configurable: true,
  });
});

describe("shareInvite", () => {
  it("no app nativo abre o share sheet do sistema com o link público", async () => {
    native = true;
    share.mockResolvedValue({});
    expect(await shareInvite(invite)).toBe("shared");
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ url: invite.url, text: invite.text }),
    );
  });

  it("no app nativo, cancelar o share sheet não vira erro nem cópia", async () => {
    native = true;
    share.mockRejectedValue(new Error("Share canceled"));
    expect(await shareInvite(invite)).toBe("dismissed");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("no navegador usa a Web Share API quando existe", async () => {
    const webShare = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", {
      value: webShare,
      configurable: true,
    });
    expect(await shareInvite(invite)).toBe("shared");
    expect(webShare).toHaveBeenCalledWith(invite);
  });

  it("sem Web Share, copia o link", async () => {
    writeText.mockResolvedValue(undefined);
    expect(await shareInvite(invite)).toBe("copied");
    expect(writeText).toHaveBeenCalledWith(invite.url);
  });

  it("se nada funciona, devolve failed (a UI mostra o link)", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    expect(await shareInvite(invite)).toBe("failed");
  });
});
