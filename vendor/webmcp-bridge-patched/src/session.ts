import type { ServerWebSocket } from "bun";
import type { BridgeClientMessage, BridgeServerMessage, BridgeToolSummary } from "./protocol";

type WsData = { authenticated: boolean };

export class PageSession {
  #ws: ServerWebSocket<WsData> | null = null;
  #tools: BridgeToolSummary[] = [];
  #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  #onToolsChanged?: () => void;

  constructor(onToolsChanged?: () => void) {
    this.#onToolsChanged = onToolsChanged;
  }

  setSocket(ws: ServerWebSocket<WsData>) {
    this.#ws = ws;
  }

  clearSocket(from?: ServerWebSocket<WsData>) {
    if (from && from !== this.#ws) return; // a stale or unauthenticated socket closing must not wipe the live session
    this.#ws = null;
    this.#setTools([]);
    for (const [, pending] of this.#pending) {
      pending.reject(new Error("Page disconnected"));
    }
    this.#pending.clear();
  }

  isConnected(): boolean {
    return this.#ws != null && this.#ws.readyState === WebSocket.OPEN;
  }

  getTools(): BridgeToolSummary[] {
    return this.#tools;
  }

  handleMessage(raw: string, token: string, ws: ServerWebSocket<WsData> | null = this.#ws): void {
    if (!ws) return;
    let msg: BridgeClientMessage;
    try {
      msg = JSON.parse(raw) as BridgeClientMessage;
    } catch {
      return; // drop a malformed frame instead of crashing the bridge (or tearing down a live session)
    }

    if (msg.type === "auth") {
      if (msg.token !== token) {
        ws.send(JSON.stringify({ type: "error", message: "Invalid token" } satisfies BridgeServerMessage));
        ws.close(4401, "Unauthorized");
        return;
      }
      ws.data.authenticated = true;
      if (this.#ws && this.#ws !== ws) this.#ws.close(4000, "Replaced by a newer tab");
      this.#ws = ws; // newest *authenticated* tab becomes the session
      ws.send(JSON.stringify({ type: "auth_ok" } satisfies BridgeServerMessage));
      return;
    }

    if (!ws.data.authenticated) {
      ws.send(JSON.stringify({ type: "error", message: "Unauthorized" } satisfies BridgeServerMessage));
      ws.close(4401, "Unauthorized");
      return;
    }

    if (ws !== this.#ws) return; // ignore frames from replaced sockets

    if (msg.type === "sync_tools") {
      this.#setTools(msg.tools);
      return;
    }

    if (msg.type === "tool_result") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if ("error" in msg.result && typeof msg.result.error === "string") {
        pending.reject(new Error(msg.result.error));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || !ws.data.authenticated) {
      throw new Error("No page connected");
    }

    const id = crypto.randomUUID();
    const msg: BridgeServerMessage = { type: "execute_tool", id, name, args };
    ws.send(JSON.stringify(msg));

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
  }

  #setTools(tools: BridgeToolSummary[]): void {
    if (JSON.stringify(this.#tools) === JSON.stringify(tools)) return;
    this.#tools = tools;
    this.#onToolsChanged?.();
  }
}
