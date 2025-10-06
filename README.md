# Modbus Manager Agent

Local agent for connecting Modbus devices to Modbus Manager cloud platform.

## Installation

**Option 1: Run with npx (no installation needed)**
```bash
npx @modbus-manager/agent --token=YOUR_REGISTRATION_TOKEN
```

**Option 2: Install globally**
```bash
npm install -g @modbus-manager/agent
modbus-agent --token=YOUR_REGISTRATION_TOKEN
```

**Option 3: Install locally in a project**
```bash
npm install @modbus-manager/agent
npx modbus-agent --token=YOUR_REGISTRATION_TOKEN
```

## Requirements

- Node.js 18 or higher
- Network access to your Modbus devices

## Getting Your Registration Token

1. Go to the **Agents** page in Modbus Manager
2. Click **Register Agent**
3. Copy your registration token

## Quick Start

```bash
# Run directly with npx (easiest)
npx @modbus-manager/agent --token=abc123...

# The agent will:
# ✅ Connect to Modbus Manager cloud
# ✅ Appear as "Online" in your dashboard
# ✅ Be ready to scan networks and communicate with devices
```

## Features

- ✅ Network scanning for Modbus devices
- ✅ Real-time Modbus read/write operations
- ✅ Automatic reconnection
- ✅ Device communication testing
- ✅ Secure WebSocket connection

## Supported Modbus Protocols

- Modbus TCP/IP
- Modbus RTU (via serial adapter)

## Usage

```bash
# Basic usage
modbus-agent --token=YOUR_REGISTRATION_TOKEN

# Show help
modbus-agent --help

# Show version
modbus-agent --version
```

## Running as a Service

### Windows (with NSSM)
```bash
nssm install ModbusAgent "C:\Program Files\nodejs\node.exe" "C:\path\to\agent.js --token=YOUR_TOKEN"
nssm start ModbusAgent
```

### Linux (systemd)
Create `/etc/systemd/system/modbus-agent.service`:
```ini
[Unit]
Description=Modbus Manager Agent
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/agent-package
ExecStart=/usr/bin/node agent.js --token=YOUR_TOKEN
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable modbus-agent
sudo systemctl start modbus-agent
```

### macOS (launchd)
Create `~/Library/LaunchAgents/com.modbusmanager.agent.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.modbusmanager.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/agent.js</string>
        <string>--token=YOUR_TOKEN</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

Then:
```bash
launchctl load ~/Library/LaunchAgents/com.modbusmagicmaker.agent.plist
```

## Troubleshooting

### Connection Issues
- Verify your registration token is correct
- Check firewall settings (agent needs outbound HTTPS/WSS access)
- Ensure stable internet connection

### Modbus Communication Errors
- Verify Modbus device IP/port settings
- Check network connectivity to devices
- Confirm correct slave ID configuration
- Test with a Modbus client tool first

### Agent Keeps Disconnecting
- Check system time (should be synchronized)
- Review system logs for errors
- Verify sufficient system resources

## Security

- Keep your registration token secure
- Run agent with minimal required permissions
- Use network isolation when possible
- Keep Node.js and dependencies updated

## Support

For issues or questions, visit the Modbus Manager platform or check the documentation.
