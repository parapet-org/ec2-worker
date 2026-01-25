#!/bin/bash
set -e  # Exit on any error

# Log everything to /var/log/user-data.log
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "Starting EC2 worker setup..."

# Update system packages
echo "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

# Install required dependencies
echo "Installing dependencies..."
apt-get install -y git curl unzip ca-certificates

# Install AWS CLI (optional - only needed if reading SQS_QUEUE_URL from instance tags)
# apt-get install -y awscli

# Install Bun
echo "Installing Bun..."
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
# Also add to bashrc for future sessions
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> /root/.bashrc

# Verify Bun installation
/root/.bun/bin/bun --version

# Clone the repository
echo "Cloning repository..."
cd /opt
if [ -d "ec2-worker" ]; then
    echo "Directory exists, removing it..."
    rm -rf ec2-worker
fi
git clone https://github.com/parapet-org/ec2-worker.git
cd ec2-worker

# Install project dependencies
echo "Installing project dependencies..."
/root/.bun/bin/bun install

# ============================================================================
# CONFIGURATION: Set your SQS Queue URL here (uncomment and set your value)
# ============================================================================
# SQS_QUEUE_URL="https://sqs.us-east-1.amazonaws.com/123456789012/your-queue-name"
# AWS_REGION="us-east-1"  # Optional, defaults to us-east-1

# Alternative: Read from EC2 instance tags (uncomment to use)
# INSTANCE_ID=$(curl -s http://169.254.169.254/latest/meta-data/instance-id)
# REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)
# SQS_QUEUE_URL=$(aws ec2 describe-tags \
#   --filters "Name=resource-id,Values=$INSTANCE_ID" "Name=key,Values=SQS_QUEUE_URL" \
#   --region $REGION \
#   --query 'Tags[0].Value' \
#   --output text 2>/dev/null || echo "")

# Create systemd service for the worker
echo "Creating systemd service..."
{
    echo "[Unit]"
    echo "Description=EC2 Worker SQS Queue Processor"
    echo "After=network.target"
    echo ""
    echo "[Service]"
    echo "Type=simple"
    echo "User=root"
    echo "WorkingDirectory=/opt/ec2-worker"
    echo 'Environment="PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"'
    if [ -n "$SQS_QUEUE_URL" ]; then
        echo "Environment=\"SQS_QUEUE_URL=$SQS_QUEUE_URL\""
    fi
    if [ -n "$AWS_REGION" ]; then
        echo "Environment=\"AWS_REGION=$AWS_REGION\""
    fi
    echo "ExecStart=/root/.bun/bin/bun run /opt/ec2-worker/src/index.ts"
    echo "Restart=always"
    echo "RestartSec=10"
    echo "StandardOutput=journal"
    echo "StandardError=journal"
    echo ""
    echo "[Install]"
    echo "WantedBy=multi-user.target"
} > /etc/systemd/system/ec2-worker.service

# Reload systemd and enable the service
systemctl daemon-reload
systemctl enable ec2-worker.service

# Start the service
echo "Starting EC2 worker service..."
systemctl start ec2-worker.service

# Check service status
sleep 5
systemctl status ec2-worker.service --no-pager || true

echo "Setup complete!"
echo ""
if [ -z "$SQS_QUEUE_URL" ]; then
    echo "WARNING: SQS_QUEUE_URL is not set!"
    echo "Please edit /etc/systemd/system/ec2-worker.service and add:"
    echo "  Environment=\"SQS_QUEUE_URL=https://sqs.region.amazonaws.com/account-id/queue-name\""
    echo "Then run: systemctl daemon-reload && systemctl restart ec2-worker"
else
    echo "SQS_QUEUE_URL is set: $SQS_QUEUE_URL"
fi
echo ""
echo "To check logs: journalctl -u ec2-worker -f"
echo "To restart: systemctl restart ec2-worker"
echo "To check status: systemctl status ec2-worker"
