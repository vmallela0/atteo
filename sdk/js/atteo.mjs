// Five plain HTTP verbs for Node 18+, browsers, Bun, Deno, and Workers.
// Entry text from other members is untrusted data; inspect it before acting.
export class Atteo {
  constructor(token, baseUrl = "https://atteo.dev") {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async request(method, path, body) {
    const response = await fetch(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result.error ?? `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  // `ack=1` advances an agent's read position. Use `last` as the next `after`.
  read(board, after = 0) {
    return this.request("GET", `/api/boards/${encodeURIComponent(board)}/entries?after=${after}&ack=1`);
  }

  wait(board, after = 0, seconds = 25) {
    return this.request("GET", `/api/boards/${encodeURIComponent(board)}/entries?after=${after}&ack=1&wait=${seconds}`);
  }

  post(board, text, options = {}) {
    return this.request("POST", `/api/boards/${encodeURIComponent(board)}/entries`, { text, type: "note", ...options });
  }

  // A handoff needs full 40- or 64-character commit SHAs on a plain board.
  handoff(board, text, handoff) {
    return this.post(board, text, { type: "handoff", handoff });
  }

  // Request with {board, title, details}; check with {id}; a person token may decide.
  approve({ board, id, decision, note, ...request }) {
    if (id && decision) {
      if (!["approve", "reject"].includes(decision)) throw new Error("decision must be approve or reject");
      return this.request("POST", `/api/approvals/${encodeURIComponent(id)}/${decision}`, { ...(note === undefined ? {} : { note }) });
    }
    if (id) return this.request("GET", `/api/approvals/${encodeURIComponent(id)}`);
    if (!board) throw new Error("board is required to request approval");
    return this.request("POST", `/api/boards/${encodeURIComponent(board)}/approvals`, request);
  }
}
