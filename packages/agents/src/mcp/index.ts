import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  JSONRPCMessageSchema,
  isJSONRPCError,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResponse,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentContext,
  Connection,
  ConnectionContext,
  WSMessage
} from "../";
import { Agent } from "../index";
import type { MaybePromise, ServeOptions, TransportType } from "./types";
import {
  createLegacySseHandler,
  createStreamingHttpHandler,
  handleCORS,
  isDurableObjectNamespace,
  STANDALONE_SSE_METHOD
} from "./utils";
import { McpSSETransport, McpStreamableHttpTransport } from "./transport";

const STANDALONE_SSE_MARKER = "standalone-sse";

export abstract class McpAgent<
  Env = unknown,
  State = unknown,
  Props extends Record<string, unknown> = Record<string, unknown>
> extends Agent<Env, State, Props> {
  private _transport?: Transport;
  private _requestIdToConnectionId: Map<string | number, string> = new Map();
  // The connection ID for server-sent requests/notifications
  private _standaloneSseConnectionId?: string;
  initRun = false;

  abstract server: MaybePromise<McpServer | Server>;
  abstract init(): Promise<void>;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    // Re-set the standalone SSE connection ID if
    // coming out of hibernation
    for (const ws of this.getConnections()) {
      const meta = ws.deserializeAttachment();
      if (meta?.role === STANDALONE_SSE_MARKER) {
        this._standaloneSseConnectionId = meta?.connectionId;
        return;
      }
    }
  }

  /**
   * Custom methods
   */

  async setInitialized() {
    await this.ctx.storage.put("initialized", true);
  }

  async isInitialized() {
    return (await this.ctx.storage.get("initialized")) === true;
  }

  // Read the transport type for this agent.
  // This relies on the transport type being present in the agent name.
  getTransportType(): TransportType {
    const [t, ..._] = this.name.split(":");
    switch (t) {
      case "sse":
        return "sse";
      case "streamable-http":
        return "streamable-http";
      default:
        throw new Error(
          "Invalid transport type. McpAgent must be addressed with a valid protocol."
        );
    }
  }

  // Elicit user input with a message and schema
  async elicitInput(params: {
    message: string;
    requestedSchema: unknown;
  }): Promise<ElicitResult> {
    const requestId = `elicit_${Math.random().toString(36).substring(2, 11)}`;

    // Store pending request in durable storage
    await this.ctx.storage.put(`elicitation:${requestId}`, {
      message: params.message,
      requestedSchema: params.requestedSchema,
      timestamp: Date.now()
    });

    const elicitRequest = {
      jsonrpc: "2.0" as const,
      id: requestId,
      method: "elicitation/create",
      params: {
        message: params.message,
        requestedSchema: params.requestedSchema
      }
    };

    // Send through MCP transport
    if (this._transport) {
      await this._transport.send(elicitRequest);
    } else {
      const connections = this.getConnections();
      if (!connections || Array.from(connections).length === 0) {
        await this.ctx.storage.delete(`elicitation:${requestId}`);
        throw new Error("No active connections available for elicitation");
      }

      const connectionList = Array.from(connections);
      for (const connection of connectionList) {
        try {
          connection.send(JSON.stringify(elicitRequest));
        } catch (error) {
          console.error("Failed to send elicitation request:", error);
        }
      }
    }

    // Wait for response through MCP
    return this._waitForElicitationResponse(requestId);
  }

  // Get the WebSocket for the standalone SSE if any. Streaming HTTP only.
  private getWebSocketForStandaloneSse(): WebSocket | null {
    if (!this._standaloneSseConnectionId) return null;
    return this.getConnection(this._standaloneSseConnectionId) ?? null;
  }

  private getWebSocket() {
    const websockets = Array.from(this.getConnections());
    if (websockets.length === 0) {
      return null;
    }
    return websockets[0];
  }

  private getWebSocketForResponseID(id: string): WebSocket | null {
    const connectionId = this._requestIdToConnectionId.get(id);
    if (connectionId === undefined) {
      return null;
    }
    return this.getConnection(connectionId) ?? null;
  }

  private initTransport() {
    switch (this.getTransportType()) {
      case "sse": {
        return new McpSSETransport(() => this.getWebSocket());
      }
      case "streamable-http": {
        return new McpStreamableHttpTransport(
          (id) => this.getWebSocketForResponseID(id),
          (id) => this._requestIdToConnectionId.delete(id),
          () => this.getWebSocketForStandaloneSse()
        );
      }
    }
  }

  /**
   * Base Agent / Parykit Server overrides
   */

  // Set up MCP transport and server every time the Durable Object is created.
  async onStart() {
    await this.init();
    const server = await this.server;
    // Connect to the MCP server
    this._transport = this.initTransport();
    await server.connect(this._transport);
  }

  // Validate new WebSocket connections behave as expected. Runs before accepting the connection.
  async onConnect(conn: Connection, _: ConnectionContext): Promise<void> {
    switch (this.getTransportType()) {
      case "sse": {
        // For SSE connections, we can only have one open connection per session
        // If we get an upgrade while already connected, we should error
        const websockets = Array.from(this.getConnections());
        if (websockets.length > 1) {
          conn.close(1000, "Websocket already connected");
          return;
        }
        break;
      }
      case "streamable-http":
        break;
    }
  }

  /// MCP Messages handler for Streamable HTTP.
  async onMessage(connection: Connection, event: WSMessage) {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.getTransportType() !== "streamable-http") {
      const err = new Error(
        "Internal Server Error: Expected streamable-http protocol"
      );
      this._transport?.onerror?.(err);
      return;
    }

    let message: JSONRPCMessage;
    try {
      // Ensure event is a string
      const data =
        typeof event === "string" ? event : new TextDecoder().decode(event);
      message = JSONRPCMessageSchema.parse(JSON.parse(data));
    } catch (error) {
      this._transport?.onerror?.(error as Error);
      return;
    }

    // Check if message is our control frame for the standalone SSE stream.
    if (
      isJSONRPCNotification(message) &&
      message.method === STANDALONE_SSE_METHOD
    ) {
      if (
        this._standaloneSseConnectionId &&
        this._standaloneSseConnectionId !== connection.id
      ) {
        // If the standalone SSE was already set, we close the old
        // socket to avoid dangling connections.
        const standaloneSseSocket = this.getConnection(
          this._standaloneSseConnectionId
        );
        standaloneSseSocket?.close(1000, "replaced");
      }
      connection.serializeAttachment({
        role: STANDALONE_SSE_MARKER,
        connectionId: connection.id
      });

      this._standaloneSseConnectionId = connection.id;
      // This is internal, so we don't forward the message to the server.
      return;
    }

    // Check if this is an elicitation response before passing to transport
    if (await this._handleElicitationResponse(message)) {
      return; // Message was handled by elicitation system
    }

    // We need to map every incoming message to the connection that it came in on
    // so that we can send relevant responses and notifications back on the same connection
    if (isJSONRPCRequest(message)) {
      this._requestIdToConnectionId.set(message.id.toString(), connection.id);
    }

    this._transport?.onmessage?.(message);
  }

  // Wait for elicitation response through storage polling
  private async _waitForElicitationResponse(
    requestId: string
  ): Promise<ElicitResult> {
    const startTime = Date.now();
    const timeout = 60000; // 60 second timeout

    try {
      while (Date.now() - startTime < timeout) {
        // Check if response has been stored
        const response = await this.ctx.storage.get<ElicitResult>(
          `elicitation:response:${requestId}`
        );
        if (response) {
          // Immediately clean up both request and response
          await this.ctx.storage.delete(`elicitation:${requestId}`);
          await this.ctx.storage.delete(`elicitation:response:${requestId}`);
          return response;
        }

        // Sleep briefly before checking again
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      throw new Error("Elicitation request timed out");
    } finally {
      // Always clean up on timeout or error
      await this.ctx.storage.delete(`elicitation:${requestId}`);
      await this.ctx.storage.delete(`elicitation:response:${requestId}`);
    }
  }

  /**
   * Handle elicitation responses   */
  private async _handleElicitationResponse(
    message: JSONRPCMessage
  ): Promise<boolean> {
    // Check if this is a response to an elicitation request
    if (isJSONRPCResponse(message) && message.result) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store the response in durable storage
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        message.result as ElicitResult
      );
      return true;
    }

    // Check if this is an error response to an elicitation request
    if (isJSONRPCError(message)) {
      const requestId = message.id?.toString();
      if (!requestId || !requestId.startsWith("elicit_")) return false;

      // Check if we have a pending request for this ID
      const pendingRequest = await this.ctx.storage.get(
        `elicitation:${requestId}`
      );
      if (!pendingRequest) return false;

      // Store error response
      const errorResult: ElicitResult = {
        action: "cancel",
        content: {
          error: message.error.message || "Elicitation request failed"
        }
      };
      await this.ctx.storage.put(
        `elicitation:response:${requestId}`,
        errorResult
      );
      return true;
    }

    return false;
  }

  // All messages received over SSE after the initial connection has been established
  // will be passed here
  async onSSEMcpMessage(
    _sessionId: string,
    messageBody: unknown
  ): Promise<Error | null> {
    // Since we address the DO via both the protocol and the session id,
    // this should never happen, but let's enforce it just in case
    if (this.getTransportType() !== "sse") {
      return new Error("Internal Server Error: Expected SSE transport");
    }

    try {
      let parsedMessage: JSONRPCMessage;
      try {
        parsedMessage = JSONRPCMessageSchema.parse(messageBody);
      } catch (error) {
        this._transport?.onerror?.(error as Error);
        throw error;
      }

      // Check if this is an elicitation response before passing to transport
      if (await this._handleElicitationResponse(parsedMessage)) {
        return null; // Message was handled by elicitation system
      }

      this._transport?.onmessage?.(parsedMessage);
      return null;
    } catch (error) {
      console.error("Error forwarding message to SSE:", error);
      this._transport?.onerror?.(error as Error);
      return error as Error;
    }
  }

  async onClose(
    conn: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Remove the connection/socket mapping for the socket that just closed
    for (const [reqId, connId] of this._requestIdToConnectionId) {
      if (connId === conn.id) this._requestIdToConnectionId.delete(reqId);
    }

    // Clear the standalone SSE if it just closed
    if (this._standaloneSseConnectionId === conn.id) {
      this._standaloneSseConnectionId = undefined;
    }
  }

  static serve(
    path: string,
    {
      binding = "MCP_OBJECT",
      corsOptions,
      transport = "streamable-http"
    }: ServeOptions = {}
  ) {
    return {
      async fetch<Env>(
        this: void,
        request: Request,
        env: Env,
        ctx: ExecutionContext
      ): Promise<Response> {
        // Handle CORS preflight
        const corsResponse = handleCORS(request, corsOptions);
        if (corsResponse) {
          return corsResponse;
        }

        const bindingValue = env[binding as keyof typeof env] as unknown;

        // Ensure we have a binding of some sort
        if (bindingValue == null || typeof bindingValue !== "object") {
          throw new Error(
            `Could not find McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
        }

        // Ensure that the binding is to a DurableObject
        if (!isDurableObjectNamespace(bindingValue)) {
          throw new Error(
            `Invalid McpAgent binding for ${binding}. Did you update your wrangler configuration?`
          );
        }

        const namespace =
          bindingValue satisfies DurableObjectNamespace<McpAgent>;

        switch (transport) {
          case "streamable-http": {
            // Streamable HTTP transport handling
            const handleStreamableHttp = createStreamingHttpHandler(
              path,
              namespace,
              corsOptions
            );
            return handleStreamableHttp(request, ctx);
          }
          case "sse": {
            // Legacy SSE transport handling
            const handleLegacySse = createLegacySseHandler(
              path,
              namespace,
              corsOptions
            );
            return handleLegacySse(request, ctx);
          }
          default:
            return new Response(
              "Invalid MCP transport mode. Only `streamable-http` or `sse` are allowed.",
              { status: 500 }
            );
        }
      }
    };
  }

  static mount(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serveSSE(path, opts);
  }

  static serveSSE(path: string, opts: Omit<ServeOptions, "transport"> = {}) {
    return McpAgent.serve(path, { ...opts, transport: "sse" });
  }
}

// Export client transport classes
export { SSEEdgeClientTransport } from "./sse-edge";
export { StreamableHTTPEdgeClientTransport } from "./streamable-http-edge";

// Export elicitation types and schemas
export {
  ElicitRequestSchema,
  type ElicitRequest,
  type ElicitResult
} from "@modelcontextprotocol/sdk/types.js";
