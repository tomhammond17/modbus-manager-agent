#!/bin/bash

echo "🚀 Modbus Manager Agent Installer"
echo "======================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "📦 Please install Node.js 18+ from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js found: $(node --version)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Installation failed"
    exit 1
fi

echo ""
echo "✅ Installation complete!"
echo ""

# Ask if user wants to install as a service
read -p "📋 Do you want to install the agent as a system service? (y/n): " install_service

if [[ $install_service == "y" || $install_service == "Y" ]]; then
    # Check if running as root/sudo
    if [ "$EUID" -ne 0 ]; then
        echo "❌ Service installation requires sudo privileges"
        echo "Please run: sudo ./install.sh"
        exit 1
    fi

    # Get registration token
    read -p "🔑 Enter your registration token: " token
    
    if [ -z "$token" ]; then
        echo "❌ Registration token is required"
        exit 1
    fi

    # Get current directory
    AGENT_DIR=$(pwd)
    
    # Create systemd service file
    echo "📝 Creating systemd service..."
    cat > /etc/systemd/system/modbus-agent.service << EOF
[Unit]
Description=Modbus Manager Agent
After=network.target

[Service]
Type=simple
User=$SUDO_USER
WorkingDirectory=$AGENT_DIR
ExecStart=$(which node) $AGENT_DIR/agent.js --token=$token
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=modbus-agent

[Install]
WantedBy=multi-user.target
EOF

    # Reload systemd, enable and start the service
    echo "🔄 Enabling service..."
    systemctl daemon-reload
    systemctl enable modbus-agent.service
    systemctl start modbus-agent.service

    # Check service status
    if systemctl is-active --quiet modbus-agent.service; then
        echo ""
        echo "✅ Service installed and started successfully!"
        echo ""
        echo "📋 Service commands:"
        echo "   sudo systemctl status modbus-agent   # Check status"
        echo "   sudo systemctl stop modbus-agent     # Stop service"
        echo "   sudo systemctl start modbus-agent    # Start service"
        echo "   sudo systemctl restart modbus-agent  # Restart service"
        echo "   sudo journalctl -u modbus-agent -f   # View logs"
    else
        echo "❌ Service failed to start. Check logs with: journalctl -u modbus-agent"
        exit 1
    fi
else
    echo "📋 To start the agent manually, run:"
    echo "   node agent.js --token=YOUR_REGISTRATION_TOKEN"
    echo ""
    echo "💡 Get your registration token from the Agents page in Modbus Manager"
fi
