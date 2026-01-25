# EC2 Worker

A lightweight script that subscribes to an Amazon SQS queue, validates commands against an allowlist, and executes them using Bun.spawn.

## Setup

1. Install dependencies:
```bash
bun install
```

2. Set environment variables:
```bash
export SQS_QUEUE_URL="https://sqs.region.amazonaws.com/account-id/queue-name"
export AWS_REGION="us-east-1"  # Optional, defaults to us-east-1
```

3. Configure AWS credentials (via AWS CLI, environment variables, or IAM role):
```bash
aws configure
# or
export AWS_ACCESS_KEY_ID="your-key"
export AWS_SECRET_ACCESS_KEY="your-secret"
```

## Usage

Run the worker:
```bash
bun run start
```

## Message Format

The script accepts two message formats:

1. **Simple string command:**
```json
"ls -la"
```

2. **Structured object:**
```json
{
  "command": "git",
  "args": ["status"],
  "cwd": "/path/to/directory"
}
```

## Allowlist

Commands are validated against an allowlist defined in `src/index.ts`. Only commands in the allowlist will be executed. Default allowed commands:
- ls
- grep
- git
- cat
- echo
- pwd
- whoami
- date
- uname

To modify the allowlist, edit the `ALLOWLIST` Set in `src/index.ts`.

## Security

- Commands are validated against an allowlist before execution
- Only the base command name is checked (paths are stripped)
- Messages are deleted from the queue after processing (success or failure)
