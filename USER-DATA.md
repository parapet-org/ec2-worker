# EC2 User Data Script

This script (`user-data.sh`) is designed to be used as EC2 Launch Template User Data for Ubuntu instances.

## Usage

### Option 1: Direct Copy-Paste
Copy the contents of `user-data.sh` and paste it directly into the EC2 Launch Template "User data" field.

### Option 2: Upload File
Upload `user-data.sh` as a file in the EC2 Launch Template interface.

## What it does

1. **Updates system packages** - Ensures Ubuntu is up to date
2. **Installs dependencies** - git, curl, unzip, ca-certificates
3. **Installs Bun** - Latest version from official installer
4. **Clones repository** - Clones from `github.com/parapet-org/ec2-worker.git` to `/opt/ec2-worker`
5. **Installs project dependencies** - Runs `bun install`
6. **Creates systemd service** - Sets up `ec2-worker.service` for automatic startup and restart
7. **Starts the service** - Automatically starts the worker on boot

## Configuration

### Required: SQS Queue URL

You need to set the `SQS_QUEUE_URL` environment variable. You have several options:

#### Option A: Modify the script before launch
Add these lines before the systemd service creation:
```bash
# Set environment variables
export SQS_QUEUE_URL="https://sqs.region.amazonaws.com/account-id/queue-name"
export AWS_REGION="us-east-1"
```

Then modify the systemd service to use these:
```bash
Environment="SQS_QUEUE_URL=${SQS_QUEUE_URL}"
Environment="AWS_REGION=${AWS_REGION}"
```

#### Option B: Use EC2 Instance Tags (Advanced)
You can modify the script to read from EC2 instance tags:
```bash
# Get instance ID and region
INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)

# Get SQS_QUEUE_URL from instance tag
SQS_QUEUE_URL=$(aws ec2 describe-tags \
  --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=SQS_QUEUE_URL" \
  --region $REGION \
  --query 'Tags[0].Value' \
  --output text)
```

#### Option C: Edit after launch
SSH into the instance and edit `/opt/ec2-worker/.env` or `/etc/systemd/system/ec2-worker.service`, then restart:
```bash
sudo systemctl restart ec2-worker
```

### AWS Credentials

The script assumes AWS credentials are available via:
- IAM instance role (recommended)
- Environment variables
- AWS credentials file

Make sure your EC2 instance has an IAM role with permissions to:
- Read from the SQS queue
- Delete messages from the SQS queue

## Monitoring

After launch, you can monitor the service:

```bash
# View logs
sudo journalctl -u ec2-worker -f

# Check status
sudo systemctl status ec2-worker

# Restart service
sudo systemctl restart ec2-worker
```

## Troubleshooting

1. **Check user-data execution logs:**
   ```bash
   cat /var/log/user-data.log
   ```

2. **Check service logs:**
   ```bash
   sudo journalctl -u ec2-worker -n 100
   ```

3. **Verify Bun installation:**
   ```bash
   /root/.bun/bin/bun --version
   ```

4. **Verify repository:**
   ```bash
   ls -la /opt/ec2-worker
   ```

5. **Check environment variables:**
   ```bash
   sudo systemctl show ec2-worker --property=Environment
   ```
