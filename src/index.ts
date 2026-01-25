import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from "@aws-sdk/client-sqs";

// Configuration
const QUEUE_URL = process.env.SQS_QUEUE_URL || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const POLL_INTERVAL = 5000; // 5 seconds

// Allowlist of executable commands
const ALLOWLIST = new Set<string>([
  "ls",
  "grep",
  "git",
  "cat",
  "echo",
  "pwd",
  "whoami",
  "date",
  "uname",
]);

// Initialize SQS client
const sqsClient = new SQSClient({ region: AWS_REGION });

interface CommandMessage {
  command: string;
  args?: string[];
  cwd?: string;
}

/**
 * Validates if a command is in the allowlist
 */
function isCommandAllowed(command: string): boolean {
  // Extract the base command (without path)
  const baseCommand = command.split("/").pop() || command;
  return ALLOWLIST.has(baseCommand);
}

/**
 * Parses a message from SQS into a command structure
 */
function parseMessage(body: string): CommandMessage | null {
  try {
    const parsed = JSON.parse(body);
    
    // Support both string commands and structured objects
    if (typeof parsed === "string") {
      // Simple string command: "ls -la"
      const parts = parsed.trim().split(/\s+/);
      return {
        command: parts[0],
        args: parts.slice(1),
      };
    }
    
    // Structured object: { command: "ls", args: ["-la"] }
    if (parsed.command && typeof parsed.command === "string") {
      return {
        command: parsed.command,
        args: parsed.args || [],
        cwd: parsed.cwd,
      };
    }
    
    return null;
  } catch (error) {
    console.error("Failed to parse message:", error);
    return null;
  }
}

/**
 * Executes a command using Bun.spawn
 */
async function executeCommand(cmd: CommandMessage): Promise<{ success: boolean; output: string; error?: string }> {
  try {
    const proc = Bun.spawn([cmd.command, ...(cmd.args || [])], {
      cwd: cmd.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    return {
      success: exitCode === 0,
      output: stdout,
      error: stderr || undefined,
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Processes a single message from SQS
 */
async function processMessage(message: any): Promise<void> {
  const body = message.Body || "";
  const receiptHandle = message.ReceiptHandle;

  console.log(`Received message: ${body}`);

  const cmd = parseMessage(body);
  if (!cmd) {
    console.error("Invalid message format");
    return;
  }

  // Validate command against allowlist
  if (!isCommandAllowed(cmd.command)) {
    console.error(`Command "${cmd.command}" is not in the allowlist`);
    
    // Delete the message even if rejected to prevent reprocessing
    if (receiptHandle) {
      try {
        await sqsClient.send(
          new DeleteMessageCommand({
            QueueUrl: QUEUE_URL,
            ReceiptHandle: receiptHandle,
          })
        );
      } catch (error) {
        console.error("Failed to delete rejected message:", error);
      }
    }
    return;
  }

  console.log(`Executing: ${cmd.command} ${(cmd.args || []).join(" ")}`);

  // Execute the command
  const result = await executeCommand(cmd);

  if (result.success) {
    console.log("Command executed successfully");
    console.log("Output:", result.output);
  } else {
    console.error("Command failed");
    console.error("Error:", result.error);
  }

  // Delete the message after processing
  if (receiptHandle) {
    try {
      await sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: QUEUE_URL,
          ReceiptHandle: receiptHandle,
        })
      );
      console.log("Message deleted from queue");
    } catch (error) {
      console.error("Failed to delete message:", error);
    }
  }
}

/**
 * Polls the SQS queue for messages
 */
async function pollQueue(): Promise<void> {
  try {
    const command = new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20, // Long polling
      VisibilityTimeout: 30,
    });

    const response = await sqsClient.send(command);

    if (response.Messages && response.Messages.length > 0) {
      for (const message of response.Messages) {
        await processMessage(message);
      }
    }
  } catch (error) {
    console.error("Error polling queue:", error);
  }
}

/**
 * Main loop
 */
async function main() {
  if (!QUEUE_URL) {
    console.error("SQS_QUEUE_URL environment variable is required");
    process.exit(1);
  }

  console.log(`Starting SQS worker for queue: ${QUEUE_URL}`);
  console.log(`Allowed commands: ${Array.from(ALLOWLIST).join(", ")}`);

  // Start polling loop
  while (true) {
    await pollQueue();
    // Small delay before next poll if no messages were received
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

// Start the worker
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
