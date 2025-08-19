import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpAgent } from "../mcp/index.ts";
import { Agent, type AgentEmail } from "../index.ts";

export type Env = {
  MCP_OBJECT: DurableObjectNamespace<McpAgent>;
  EmailAgent: DurableObjectNamespace<TestEmailAgent>;
  CaseSensitiveAgent: DurableObjectNamespace<TestCaseSensitiveAgent>;
  UserNotificationAgent: DurableObjectNamespace<TestUserNotificationAgent>;
};

type State = unknown;

type Props = {
  testValue: string;
};

export class TestMcpAgent extends McpAgent<Env, State, Props> {
  private tempToolHandle?: { remove: () => void };

  server = new McpServer(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { logging: {}, tools: { listChanged: true } } }
  );

  async init() {
    this.server.tool(
      "greet",
      "A simple greeting tool",
      { name: z.string().describe("Name to greet") },
      async ({ name }): Promise<CallToolResult> => {
        return { content: [{ text: `Hello, ${name}!`, type: "text" }] };
      }
    );

    this.server.tool(
      "getPropsTestValue",
      {},
      async (): Promise<CallToolResult> => {
        return {
          content: [{ text: this.props.testValue, type: "text" }]
        };
      }
    );

    this.server.tool(
      "emitLog",
      "Emit a logging/message notification",
      {
        level: z.enum(["debug", "info", "warning", "error"]),
        message: z.string()
      },
      async ({ level, message }): Promise<CallToolResult> => {
        // Force a logging message to be sent when the tool is called
        await this.server.server.sendLoggingMessage({
          level,
          data: message
        });
        return {
          content: [{ type: "text", text: `logged:${level}` }]
        };
      }
    );

    // Use `registerTool` so we can later remove it.
    // Triggers notifications/tools/list_changed
    this.server.tool(
      "installTempTool",
      "Register a temporary tool that echoes input",
      {},
      async (): Promise<CallToolResult> => {
        if (!this.tempToolHandle) {
          // Prefer modern registerTool(name, description, schema, handler)
          this.tempToolHandle = this.server.registerTool(
            "temp-echo",
            {
              description: "Echo text (temporary tool)",
              inputSchema: { what: z.string().describe("Text to echo") }
            },
            async ({ what }: { what: string }): Promise<CallToolResult> => {
              return { content: [{ type: "text", text: `echo:${what}` }] };
            }
          );
        }
        // Most SDKs auto-send notifications/tools/list_changed here.
        return { content: [{ type: "text", text: "temp tool installed" }] };
      }
    );

    // Remove the dynamically added tool.
    // Triggers notifications/tools/list_changed
    this.server.tool(
      "uninstallTempTool",
      "Remove the temporary tool if present",
      {},
      async (): Promise<CallToolResult> => {
        if (this.tempToolHandle?.remove) {
          this.tempToolHandle.remove();
          this.tempToolHandle = undefined;
          return { content: [{ type: "text", text: "temp tool removed" }] };
        }
        return { content: [{ type: "text", text: "nothing to remove" }] };
      }
    );
  }
}

// Test email agents
export class TestEmailAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  // Override onError to avoid console.error which triggers queueMicrotask issues
  override onError(error: unknown): void {
    // Silently handle errors in tests
    throw error;
  }
}

export class TestCaseSensitiveAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export class TestUserNotificationAgent extends Agent<Env> {
  emailsReceived: AgentEmail[] = [];

  async onEmail(email: AgentEmail) {
    this.emailsReceived.push(email);
  }

  override onError(error: unknown): void {
    throw error;
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // set some props that should be passed init
    ctx.props = {
      testValue: "123"
    };

    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return TestMcpAgent.serveSSE("/sse").fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      return TestMcpAgent.serve("/mcp").fetch(request, env, ctx);
    }

    if (url.pathname === "/500") {
      return new Response("Internal Server Error", { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  },

  async email(
    _message: ForwardableEmailMessage,
    _env: Env,
    _ctx: ExecutionContext
  ) {
    // Bring this in when we write tests for the complete email handler flow
  }
};
