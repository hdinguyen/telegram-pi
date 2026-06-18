/**
 * Test script for Pi Agent integration
 * 
 * Usage: node src/agent/test-agent.js
 */

import { piAgent, getAgentOptions } from "./index.js";

async function testAgent() {
  console.log("🧪 Testing Pi Agent Integration\n");

  try {
    // Step 1: Initialize agent
    console.log("1️⃣ Initializing agent...");
    const options = getAgentOptions();
    await piAgent.initialize(options);
    console.log("✅ Agent initialized\n");

    // Step 2: Check status
    console.log("2️⃣ Checking agent status...");
    const status = piAgent.getStatus();
    console.log("Status:", JSON.stringify(status, null, 2));
    console.log("");

    // Step 3: Process a simple message
    console.log("3️⃣ Processing test message...");
    const response = await piAgent.processMessage(
      "Hello! What can you help me with?",
      {
        username: "test_user",
        chatType: "private",
        chatTitle: "Test Chat",
      },
    );

    console.log("\n📝 Response:");
    console.log("─".repeat(60));
    console.log(response.text);
    console.log("─".repeat(60));

    if (response.tools && response.tools.length > 0) {
      console.log("\n🔧 Tools used:", response.tools);
    }

    console.log("\n✅ Test completed successfully!");

    // Step 4: Cleanup
    piAgent.dispose();
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    process.exit(1);
  }
}

// Run test
testAgent();
