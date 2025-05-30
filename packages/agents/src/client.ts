import {
  PartySocket,
  type PartySocketOptions,
  type PartyFetchOptions,
} from "partysocket";
import type { RPCRequest, RPCResponse } from "./";

/**
 * Options for creating an AgentClient
 */
export type AgentClientOptions<State = unknown> = Omit<
  PartySocketOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
  /** Called when the Agent's state is updated */
  onStateUpdate?: (state: State, source: "server" | "client") => void;
};

/**
 * Options for streaming RPC calls
 */
export type StreamOptions = {
  /** Called when a chunk of data is received */
  onChunk?: (chunk: unknown) => void;
  /** Called when the stream ends */
  onDone?: (finalChunk: unknown) => void;
  /** Called when an error occurs */
  onError?: (error: string) => void;
};

/**
 * Options for the agentFetch function
 */
export type AgentClientFetchOptions = Omit<
  PartyFetchOptions,
  "party" | "room"
> & {
  /** Name of the agent to connect to */
  agent: string;
  /** Name of the specific Agent instance */
  name?: string;
};

/**
 * WebSocket client for connecting to an Agent
 */
export class AgentClient<State = unknown> extends PartySocket {
  /**
   * @deprecated Use agentFetch instead
   */
  static fetch(_opts: PartyFetchOptions): Promise<Response> {
    throw new Error(
      "AgentClient.fetch is not implemented, use agentFetch instead"
    );
  }
  agent: string;
  name: string;
  #options: AgentClientOptions<State>;
  #pendingCalls = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      stream?: StreamOptions;
      type?: unknown;
    }
  >();

  constructor(options: AgentClientOptions<State>) {
    super({
      prefix: "agents",
      party: options.agent,
      room: options.name || "default",
      ...options,
    });
    this.agent = options.agent;
    this.name = options.name || "default";
    this.#options = options;

    // warn if agent or name isn't in lowercase
    if (this.agent !== this.agent.toLowerCase()) {
      console.warn(
        `Agent name: ${this.agent} should probably be in lowercase. Received: ${this.agent}`
      );
    }
    if (this.name !== this.name.toLowerCase()) {
      console.warn(
        `Agent instance name: ${this.name} should probably be in lowercase. Received: ${this.name}`
      );
    }

    this.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        let parsedMessage: Record<string, unknown>;
        try {
          parsedMessage = JSON.parse(event.data);
        } catch (error) {
          // silently ignore invalid messages for now
          // TODO: log errors with log levels
          return;
        }
        if (parsedMessage.type === "cf_agent_state") {
          this.#options.onStateUpdate?.(parsedMessage.state as State, "server");
          return;
        }
        if (parsedMessage.type === "rpc") {
          const response = parsedMessage as RPCResponse;
          const pending = this.#pendingCalls.get(response.id);
          if (!pending) return;

          if (!response.success) {
            pending.reject(new Error(response.error));
            this.#pendingCalls.delete(response.id);
            pending.stream?.onError?.(response.error);
            return;
          }

          // Handle streaming responses
          if ("done" in response) {
            if (response.done) {
              pending.resolve(response.result);
              this.#pendingCalls.delete(response.id);
              pending.stream?.onDone?.(response.result);
            } else {
              pending.stream?.onChunk?.(response.result);
            }
          } else {
            // Non-streaming response
            pending.resolve(response.result);
            this.#pendingCalls.delete(response.id);
          }
        }
      }
    });
  }

  setState(state: State) {
    this.send(JSON.stringify({ type: "cf_agent_state", state }));
    this.#options.onStateUpdate?.(state, "client");
  }

  /**
   * Call a method on the Agent
   * @param method Name of the method to call
   * @param args Arguments to pass to the method
   * @param streamOptions Options for handling streaming responses
   * @returns Promise that resolves with the method's return value
   */
  async call<T = unknown>(
    method: string,
    args: unknown[] = [],
    streamOptions?: StreamOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      this.#pendingCalls.set(id, {
        resolve: (value: unknown) => resolve(value as T),
        reject,
        stream: streamOptions,
        type: null as T,
      });

      const request: RPCRequest = {
        type: "rpc",
        id,
        method,
        args,
      };

      this.send(JSON.stringify(request));
    });
  }
}

/**
 * Make an HTTP request to an Agent
 * @param opts Connection options
 * @param init Request initialization options
 * @returns Promise resolving to a Response
 */
export function agentFetch(opts: AgentClientFetchOptions, init?: RequestInit) {
  // warn if agent or name isn't in lowercase
  if (opts.agent !== opts.agent.toLowerCase()) {
    console.warn(
      `Agent name: ${opts.agent} should probably be in lowercase. Received: ${opts.agent}`
    );
  }
  if (opts.name && opts.name !== opts.name.toLowerCase()) {
    console.warn(
      `Agent instance name: ${opts.name} should probably be in lowercase. Received: ${opts.name}`
    );
  }

  return PartySocket.fetch(
    {
      prefix: "agents",
      party: opts.agent,
      room: opts.name || "default",
      ...opts,
    },
    init
  );
}
