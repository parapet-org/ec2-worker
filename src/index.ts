import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, SendMessageCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

// Configuration
const QUEUE_URL = process.env.SQS_QUEUE_URL || "";
const RESPONSE_QUEUE_NAME = process.env.RESPONSE_QUEUE_NAME || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const POLL_INTERVAL = 5000; // 5 seconds

// Derive response queue name from command queue if not explicitly set
// Queue URL format: https://sqs.region.amazonaws.com/account-id/queue-name
// We extract the queue name (instance ID) and append "-responses"
function getResponseQueueName(): string {
  if (RESPONSE_QUEUE_NAME) {
    return RESPONSE_QUEUE_NAME;
  }
  
  // Extract queue name from QUEUE_URL
  // Format: https://sqs.region.amazonaws.com/account-id/instance-id
  const match = QUEUE_URL.match(/\/[^\/]+$/);
  if (match) {
    const instanceId = match[0].substring(1); // Remove leading /
    return `${instanceId}-responses`;
  }
  
  return "";
}

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
  "npm",
  "npx",
  "bun",
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
  // Extract the base command (without path and without arguments)
  // First split by "/" to handle paths, then by space to get the first word
  const pathParts = command.split("/");
  const lastPart = pathParts[pathParts.length - 1] || command;
  const baseCommand = lastPart.trim().split(/\s+/)[0];
  
  // If the base command is in the allowlist, allow it with any subcommands
  if (ALLOWLIST.has(baseCommand)) {
    return true;
  }
  
  return false;
}

/**
 * Parses a message from SQS into a command structure
 */
function parseMessage(body: string): CommandMessage | null {
  // Log the raw body for debugging
  console.log(`[parseMessage] Raw body type: ${typeof body}, length: ${body.length}`);
  console.log(`[parseMessage] Raw body content: ${JSON.stringify(body)}`);
  
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
    
    console.error(`[parseMessage] Parsed value doesn't match expected format:`, parsed);
    return null;
  } catch (error) {
    console.error(`[parseMessage] Failed to parse message. Body: ${JSON.stringify(body)}`, error);
    // Try to handle plain text as a fallback (for backward compatibility with old messages)
    if (typeof body === "string" && body.trim().length > 0) {
      console.log(`[parseMessage] Attempting to parse as plain text command`);
      
      // Try to parse sqs_job format: sqs_job [instanceId=..., command=git clone ...]
      const commandMatch = body.match(/command=([^\]]+)/);
      if (commandMatch) {
        const commandString = commandMatch[1].trim().replace(/\]$/, ''); // Remove trailing bracket if present
        const parts = commandString.split(/\s+/);
        return {
          command: parts[0],
          args: parts.slice(1),
        };
      }
      
      // Fallback to simple whitespace splitting
      const parts = body.trim().split(/\s+/);
      return {
        command: parts[0],
        args: parts.slice(1),
      };
    }
    return null;
  }
}

/**
 * Sends command result back to response queue
 */
async function sendResponse(correlationId: string, result: { success: boolean; output: string; error?: string; exitCode: number }): Promise<void> {
  const responseQueueName = getResponseQueueName();
  if (!responseQueueName) {
    console.log("No response queue configured, skipping response");
    return;
  }

  try {
    // Get response queue URL
    const queueUrlResponse = await sqsClient.send(
      new GetQueueUrlCommand({
        QueueName: responseQueueName,
      })
    );

    if (!queueUrlResponse.QueueUrl) {
      console.error(`Response queue not found: ${responseQueueName}`);
      return;
    }

    const responseBody = JSON.stringify({
      correlationId,
      success: result.success,
      stdout: result.output,
      stderr: result.error || "",
      exitCode: result.exitCode,
    });

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrlResponse.QueueUrl,
        MessageBody: responseBody,
        MessageAttributes: {
          CorrelationId: {
            DataType: "String",
            StringValue: correlationId,
          },
        },
      })
    );

    console.log(`Response sent for correlation ID: ${correlationId}`);
  } catch (error) {
    console.error("Failed to send response:", error);
  }
}

/**
 * Executes a command using Bun.spawn
 */
async function executeCommand(cmd: CommandMessage): Promise<{ success: boolean; output: string; error?: string; exitCode: number }> {
  try {
    // Split command if it contains spaces and args weren't explicitly provided
    let command = cmd.command;
    let args = cmd.args ?? [];

    if (typeof command === "string") {
      const parts = command.trim().split(/\s+/);
      command = parts[0];
      if (!cmd.args) {
        args = parts.slice(1);
      }
    }

    const proc = Bun.spawn([command, ...args], {
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
      exitCode,
    };
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
      exitCode: 1,
    };
  }
}

/**
 * Processes a single message from SQS
 */
async function processMessage(message: any): Promise<void> {
  const body = message.Body || "";
  const receiptHandle = message.ReceiptHandle;
  const correlationId = message.MessageAttributes?.CorrelationId?.StringValue || message.MessageId || "";

  console.log(`Received message: ${body}`);

  const cmd = parseMessage(body);
  if (!cmd) {
    console.error("Invalid message format");
    return;
  }

  // Validate command against allowlist
  if (!isCommandAllowed(cmd.command)) {
    console.error(`Command "${cmd.command}" is not in the allowlist`);
    
    // Send error response
    if (correlationId) {
      await sendResponse(correlationId, {
        success: false,
        output: "",
        error: `Command "${cmd.command}" is not in the allowlist`,
        exitCode: 1,
      });
    }
    
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

  // Send response back
  if (correlationId) {
    await sendResponse(correlationId, result);
  }

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
      MessageAttributeNames: ["All"], // Receive message attributes
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
