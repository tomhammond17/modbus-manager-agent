#!/usr/bin/env node

/**
 * Modbus Manager - Local Agent
 * Connects local Modbus devices to the cloud platform
 * Supports both Modbus TCP and RTU protocols
 */

const WebSocket = require('ws');
const { program } = require('commander');
const ModbusRTU = require('modbus-serial');

const WEBSOCKET_URL = 'wss://ckdjiovqshugcprabpty.supabase.co/functions/v1/agent-websocket';

class ModbusAgent {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.modbusClient = new ModbusRTU();
    this.reconnectInterval = 5000;
    this.heartbeatInterval = null;
  }

  async connect() {
    try {
      console.log('🔌 Connecting to Modbus Manager...');
      console.log(`⏱️  Connection timeout: ${this.reconnectInterval}ms`);
      
      this.ws = new WebSocket(`${WEBSOCKET_URL}?token=${this.token}`, {
        handshakeTimeout: 10000, // 10 second timeout
      });

      this.ws.on('open', () => {
        console.log('✅ Connected successfully!');
        console.log('📡 Agent is now online and ready to receive commands');
        console.log('🔧 Supports: Modbus TCP & RTU\n');
        this.startHeartbeat();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`📨 Message received: type=${message.type}, command_id=${message.command_id || 'N/A'}`);
          this.handleCommand(message);
        } catch (parseError) {
          console.error('❌ Failed to parse WebSocket message:', parseError.message);
          console.error('📄 Raw message:', data.toString());
        }
      });

      this.ws.on('close', (code, reason) => {
        console.log(`❌ Connection closed (Code: ${code}, Reason: ${reason || 'No reason provided'})`);
        console.log(`⏳ Reconnecting in ${this.reconnectInterval / 1000}s...`);
        this.stopHeartbeat();
        setTimeout(() => this.connect(), this.reconnectInterval);
      });

      this.ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error.message);
        console.error('🔍 Error details:', {
          code: error.code,
          syscall: error.syscall,
          address: error.address
        });
      });

    } catch (error) {
      console.error('❌ Connection failed:', error.message);
      console.error('🔍 Stack trace:', error.stack);
      console.log(`⏳ Retrying in ${this.reconnectInterval / 1000}s...`);
      setTimeout(() => this.connect(), this.reconnectInterval);
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 30000);
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async handleCommand(message) {
    const startTime = Date.now();
    console.log(`📥 Received command: ${message.type} (ID: ${message.command_id || 'N/A'})`);
    console.log(`🔧 Parameters:`, JSON.stringify(message.params || {}, null, 2));

    try {
      switch (message.type) {
        case 'connected':
          // Server acknowledgment - agent successfully connected
          console.log(`✅ Server confirmed connection`);
          break;
        case 'heartbeat_ack':
          // Server acknowledged heartbeat - connection is healthy
          break;
        case 'network_scan':
          await this.handleNetworkScan(message);
          break;
        case 'modbus_read':
          await this.handleModbusRead(message);
          break;
        case 'modbus_write':
          await this.handleModbusWrite(message);
          break;
        case 'test_communication':
          await this.handleTestCommunication(message);
          break;
        default:
          console.log(`⚠️  Unknown command type: ${message.type}`);
          this.sendError(message.command_id, `Unknown command type: ${message.type}`);
      }
      
      const duration = Date.now() - startTime;
      console.log(`✅ Command ${message.type} completed in ${duration}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`❌ Error handling command after ${duration}ms:`, error.message);
      console.error('🔍 Stack trace:', error.stack);
      this.sendError(message.command_id, error.message);
    }
  }

  async connectToDevice(params) {
    const protocol = params.protocol || 'tcp';
    
    try {
      if (protocol === 'tcp') {
        const ip = params.ip || params.deviceIp || params.device_ip;
        const port = params.port || params.device_port || 502;
        
        if (!ip) {
          throw new Error('IP address is required for TCP connection');
        }
        
        console.log(`🔌 Connecting via Modbus TCP to ${ip}:${port}`);
        console.log(`⏱️  Connection timeout: ${params.timeout || 5000}ms`);
        
        await Promise.race([
          this.modbusClient.connectTCP(ip, { port }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('TCP connection timeout')), params.timeout || 5000)
          )
        ]);
        
        console.log(`✓ TCP connection established`);
      } else if (protocol === 'rtu') {
        const serialPort = params.serialPort || params.serial_port;
        const baudRate = params.baudRate || params.baud_rate || 9600;
        const parity = params.parity || 'none';
        const dataBits = params.dataBits || params.data_bits || 8;
        const stopBits = params.stopBits || params.stop_bits || 1;
        
        if (!serialPort) {
          throw new Error('Serial port is required for RTU connection');
        }
        
        console.log(`🔌 Connecting via Modbus RTU to ${serialPort} (${baudRate}/${parity}/${dataBits}/${stopBits})`);
        
        await this.modbusClient.connectRTUBuffered(serialPort, {
          baudRate,
          parity,
          dataBits,
          stopBits
        });
        
        console.log(`✓ RTU connection established`);
      } else {
        throw new Error(`Unsupported protocol: ${protocol}`);
      }
      
      const unitId = params.unitId || params.slave_id || params.unit_id || 1;
      console.log(`🎯 Setting Unit ID: ${unitId}`);
      this.modbusClient.setID(unitId);
      
      if (params.timeout) {
        console.log(`⏱️  Setting Modbus timeout: ${params.timeout}ms`);
        this.modbusClient.setTimeout(params.timeout);
      }
    } catch (error) {
      console.error(`❌ Device connection failed:`, error.message);
      throw error;
    }
  }

  async handleNetworkScan(message) {
    console.log('🔍 Scanning for Modbus devices...');
    
    const devices = [];
    const errors = [];
    const { start_address = 1, end_address = 247, timeout = 500, protocol = 'tcp' } = message.params || {};
    const totalAddresses = end_address - start_address + 1;

    console.log(`📊 Scan range: ${start_address}-${end_address} (${totalAddresses} addresses)`);
    console.log(`⏱️  Timeout per address: ${timeout}ms`);
    console.log(`🔌 Protocol: ${protocol.toUpperCase()}`);

    for (let address = start_address; address <= end_address; address++) {
      const progress = Math.round(((address - start_address + 1) / totalAddresses) * 100);
      process.stdout.write(`\r📡 Progress: ${progress}% (${address}/${end_address})`);
      
      try {
        await this.connectToDevice({ ...message.params, unit_id: address, timeout });

        // Try reading a register to verify device
        await Promise.race([
          this.modbusClient.readHoldingRegisters(0, 1),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Read timeout')), timeout)
          )
        ]);
        
        devices.push({
          address,
          type: 'unknown',
          status: 'responding',
          protocol
        });

        console.log(`\n✓ Found device at address ${address}`);
        
        this.modbusClient.close(() => {});
      } catch (error) {
        // Device not found at this address - this is expected
        if (error.message !== 'Read timeout' && error.message !== 'TCP connection timeout') {
          errors.push({ address, error: error.message });
        }
        try {
          this.modbusClient.close(() => {});
        } catch (closeError) {
          // Ignore close errors
        }
      }
    }

    console.log(`\n✅ Scan complete. Found ${devices.length} device(s)`);
    if (errors.length > 0) {
      console.log(`⚠️  ${errors.length} error(s) encountered during scan`);
    }
    
    this.sendResult(message.command_id, 'scan_result', { devices, errors: errors.slice(0, 10) });
  }

  async handleModbusRead(message) {
    const { register, registerAddress, count = 1, slave_id } = message.params;
    const regAddr = register || registerAddress || 0;
    
    console.log(`📖 Reading ${count} register(s) from address ${regAddr} (Unit ${slave_id || 1})`);

    try {
      await this.connectToDevice(message.params);
      
      const timeout = message.params.timeout || 3000;
      const data = await Promise.race([
        this.modbusClient.readHoldingRegisters(regAddr, count),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Modbus read timeout')), timeout)
        )
      ]);
      
      if (!data || !data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid Modbus response: no data received');
      }
      
      this.sendResult(message.command_id, 'modbus_read_result', {
        values: data.data,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ Read successful: [${data.data.join(', ')}]`);
    } catch (error) {
      console.error(`❌ Read failed:`, error.message);
      throw error;
    } finally {
      try {
        this.modbusClient.close(() => {});
      } catch (closeError) {
        console.error(`⚠️  Error closing connection:`, closeError.message);
      }
    }
  }

  async handleModbusWrite(message) {
    const { register, registerAddress, value, slave_id } = message.params;
    const regAddr = register || registerAddress || 0;
    
    if (value === undefined || value === null) {
      throw new Error('Value is required for write operation');
    }
    
    console.log(`✍️  Writing value ${value} to register ${regAddr} (Unit ${slave_id || 1})`);

    try {
      await this.connectToDevice(message.params);
      
      const timeout = message.params.timeout || 3000;
      await Promise.race([
        this.modbusClient.writeRegister(regAddr, value),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Modbus write timeout')), timeout)
        )
      ]);
      
      this.sendResult(message.command_id, 'modbus_write_result', {
        success: true,
        timestamp: new Date().toISOString()
      });

      console.log(`✅ Write successful`);
    } catch (error) {
      console.error(`❌ Write failed:`, error.message);
      throw error;
    } finally {
      try {
        this.modbusClient.close(() => {});
      } catch (closeError) {
        console.error(`⚠️  Error closing connection:`, closeError.message);
      }
    }
  }

  async handleTestCommunication(message) {
    console.log(`🧪 Testing communication...`);
    const testResults = {
      connection: false,
      read: false,
      latency: null,
      error: null
    };

    try {
      // Test 1: Connection
      console.log(`  Step 1/2: Establishing connection...`);
      await this.connectToDevice(message.params);
      testResults.connection = true;
      console.log(`  ✓ Connection established`);
      
      // Test 2: Read operation
      console.log(`  Step 2/2: Testing read operation...`);
      const startTime = Date.now();
      const timeout = message.params.timeout || 3000;
      
      await Promise.race([
        this.modbusClient.readHoldingRegisters(0, 1),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Test read timeout')), timeout)
        )
      ]);
      
      const latency = Date.now() - startTime;
      testResults.read = true;
      testResults.latency = latency;
      console.log(`  ✓ Read operation successful`);
      
      this.sendResult(message.command_id, 'test_result', {
        success: true,
        latency,
        message: 'Device is responding',
        details: testResults
      });

      console.log(`✅ Communication test passed (${latency}ms)`);
    } catch (error) {
      testResults.error = error.message;
      
      this.sendResult(message.command_id, 'test_result', {
        success: false,
        message: error.message,
        details: testResults
      });
      
      console.log(`❌ Communication test failed: ${error.message}`);
      console.log(`📊 Test results:`, testResults);
    } finally {
      try {
        this.modbusClient.close(() => {});
      } catch (closeError) {
        console.error(`⚠️  Error closing connection:`, closeError.message);
      }
    }
  }

  sendResult(commandId, type, data) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log(`📤 Sending result: ${type} (command_id: ${commandId})`);
      this.ws.send(JSON.stringify({
        type,
        command_id: commandId,
        data
      }));
    } else {
      console.error(`❌ Cannot send result: WebSocket not connected (state: ${this.ws?.readyState})`);
    }
  }

  sendError(commandId, message) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log(`📤 Sending error: ${message} (command_id: ${commandId})`);
      this.ws.send(JSON.stringify({
        type: 'error',
        command_id: commandId,
        error: message
      }));
    } else {
      console.error(`❌ Cannot send error: WebSocket not connected (state: ${this.ws?.readyState})`);
    }
  }
}

// CLI
program
  .name('modbus-agent')
  .description('Modbus Manager Local Agent - Supports TCP & RTU')
  .version('1.0.0')
  .requiredOption('-t, --token <token>', 'Agent registration token')
  .parse();

const options = program.opts();
const agent = new ModbusAgent(options.token);
agent.connect();

console.log(`
╔════════════════════════════════════════╗
║   Modbus Manager Local Agent          ║
║   Protocol Support: TCP & RTU         ║
╚════════════════════════════════════════╝
`);
