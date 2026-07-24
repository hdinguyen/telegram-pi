import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const inputPath = resolve(projectRoot, "test", "input.md");
const outputPath = resolve(projectRoot, "test", "output.md");

process.env.SESSION_DIR ??= resolve(projectRoot, "test", "sessions");
process.env.DATABASE_PATH ??= resolve(projectRoot, "test", "sessions.db");
process.env.LOG_LEVEL ??= "warn";

async function main() {
  let piAgent;

  try {
    const { piAgent: agent, getAgentOptions } = await import("../src/agent/index.js");
    piAgent = agent;

    const rawInput = await readFile(inputPath, "utf8");
    const order = rawInput.trim();

    if (!order) {
      const message = "Input file is empty; nothing to send to the agent.";
      await writeFile(outputPath, `${message}\n`, "utf8");
      console.warn(message);
      return;
    }

    if (!piAgent.isInitialized) {
      await piAgent.initialize(getAgentOptions());
    }

    const response = await piAgent.processMessage("e2e-test-chat", order, {
      recentMessages: [],
      chatType: "private",
      chatTitle: "E2E Test Chat",
      username: "agent-e2e",
    });

    const lines = [
      `# Agent E2E Test`,
      `Input file: ${relative(projectRoot, inputPath)}`,
      `Output file: ${relative(projectRoot, outputPath)}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "## Request",
      order,
      "",
      "## Response",
      response.text || "(no response returned)",
    ];

    if (response.tools?.length) {
      lines.push("", "## Tools Used");
      for (const tool of response.tools) {
        lines.push(`- ${tool.tool}${tool.id ? ` (id: ${tool.id})` : ""}`);
      }
    }

    await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
    console.log(`Agent response written to ${relative(projectRoot, outputPath)}`);
  } catch (error) {
    const message = `Agent test failed: ${error?.stack || error}`;
    console.error(message);
    await writeFile(outputPath, `${message}\n`, "utf8").catch(() => {});
    process.exitCode = 1;
  } finally {
    if (piAgent?.isInitialized) {
      try {
        piAgent.dispose();
      } catch (disposeError) {
        console.warn("Failed to dispose agent cleanly:", disposeError);
      }
    }
  }
}

await main();
