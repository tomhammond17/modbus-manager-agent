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

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Installation complete!"
    echo ""
    echo "📋 To start the agent, run:"
    echo "   node agent.js --token=YOUR_REGISTRATION_TOKEN"
    echo ""
    echo "💡 Get your registration token from the Agents page in Modbus Manager"
else
    echo "❌ Installation failed"
    exit 1
fi
