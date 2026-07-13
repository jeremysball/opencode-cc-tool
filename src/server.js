#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode } from "@toon-format/toon";
import { z } from "zod";
import { defaultTaskManager as tasks } from "./tasks.js";

function toon(value) {
  return { content: [{ type: "text", text: encode(value) }] };
}

const server = new McpServer({
  name: "opencode-cc-tool",
  version: "0.1.0",
});

server.registerTool(
  "opencode_dispatch",
  {
    title: "Dispatch opencode task",
    description:
      "Start an `opencode run` in the background as a directly-spawned child process (no tmux, no shared visibility into the orchestration layer) and return a task_id immediately. Poll with opencode_status, then read opencode_result once done.",
    inputSchema: {
      prompt: z.string().describe("The message/prompt to send to opencode."),
      directory: z
        .string()
        .describe("Absolute path to the working directory opencode should run in (--dir)."),
      model: z
        .string()
        .optional()
        .describe(
          "provider/model string, e.g. 'opencode-go/minimax-m3' (economy) or 'openai/gpt-5.6-sol' (hard debugging/architecture). Defaults to 'openai/gpt-5.6-luna' --variant high."
        ),
      variant: z
        .string()
        .optional()
        .describe("Model variant/reasoning effort (e.g. high, max, minimal). Only applied when model is also given."),
      session_id: z
        .string()
        .optional()
        .describe("Resume an existing opencode session id instead of starting fresh (passes --continue --session)."),
    },
  },
  async ({ prompt, directory, model, variant, session_id }) => {
    const task = tasks.dispatch({ prompt, directory, model, variant, sessionId: session_id });
    return toon(task);
  }
);

server.registerTool(
  "opencode_cancel",
  {
    title: "Cancel a running opencode task",
    description:
      "Stop a running task: sends SIGTERM to the task's whole process group (opencode and any subprocess it spawned), escalating to SIGKILL after a grace period if it hasn't exited. A finished task's status is unaffected and returns a note instead of an error. Poll opencode_status afterward; the task moves to status 'cancelled' once its exit event lands.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
      grace_ms: z
        .number()
        .optional()
        .describe("Milliseconds to wait after SIGTERM before escalating to SIGKILL. Defaults to 5000."),
    },
  },
  async ({ task_id, grace_ms }) => {
    const c = tasks.cancel(task_id, grace_ms != null ? { graceMs: grace_ms } : undefined);
    return toon(c);
  }
);

server.registerTool(
  "opencode_wait",
  {
    title: "Block until an opencode task finishes",
    description:
      "Block on a running task's real exit event (or a timeout, whichever comes first) and return its status once settled. The closest analog to the built-in Agent tool's auto-resume behavior available over plain MCP request/response, without a poll loop. Capped internally at 45s so the call returns cleanly instead of hitting Claude Code's own MCP tool-call timeout; if status is still 'running' when it returns, call opencode_wait again.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
      timeout_ms: z
        .number()
        .optional()
        .describe("Max milliseconds to block. Capped at 45000 regardless of what's passed. Defaults to 45000."),
      tail_chars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("When the wait times out and the task is still running, return this many trailing narration characters."),
    },
  },
  async ({ task_id, timeout_ms, tail_chars }) => {
    const s = await tasks.wait(task_id, {
      ...(timeout_ms != null ? { timeoutMs: timeout_ms } : {}),
      ...(tail_chars != null ? { tailChars: tail_chars } : {}),
    });
    return toon(s);
  }
);

server.registerTool(
  "opencode_status",
  {
    title: "Check opencode task status",
    description:
      "Return structured status for a dispatched task: running | done | crashed | cancelled | unknown, plus exit code and log path once finished. Backed by the child process's real exit event, not log string-matching.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
    },
  },
  async ({ task_id }) => {
    const s = tasks.status(task_id);
    return toon(s);
  }
);

server.registerTool(
  "opencode_result",
  {
    title: "Fetch opencode task result",
    description:
      "Return the final assistant message and metadata (tokens, cost, session id) for a finished task, parsed from opencode's own --format json event stream. `message` is only the model's last turn (after all tool calls finish); `narration` includes intermediate step narration too, in order, truncated to 2000 chars by default. Errors politely if the task is still running.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by opencode_dispatch."),
      full: z
        .boolean()
        .optional()
        .describe("Return the complete, untruncated narration instead of the 2000-char preview. Defaults to false."),
    },
  },
  async ({ task_id, full }) => {
    const r = tasks.result(task_id, { full: !!full });
    return toon(r);
  }
);

server.registerTool(
  "opencode_list",
  {
    title: "List opencode tasks",
    description: "List all known tasks (this server process's lifetime) with their statuses, newest first.",
    inputSchema: {},
  },
  async () => {
    const l = tasks.list();
    return toon(l);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
