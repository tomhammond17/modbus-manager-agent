#!/usr/bin/env node

const WebSocket = require('ws');
const ModbusRTU = require('modbus-serial');
const net = require('net');
const { program } = require('commander');
const fs = require('fs');
const path = require('path');

// ============================================================================
// VALUE CACHE - Tracks last known values for report-by-exception
// ============================================================================
class ValueCache {
  constructor() {
    this.cache = new Map(); // key: `${deviceId}:${registerId}`, value: number
  }

  updateValue(deviceId, registerId, value) {
    const key = `${deviceId}:${registerId}`;
    const lastValue = this.cache.get(key);
    const hasChanged = lastValue !== value;
    this.cache.set(key, value);
    return hasChanged;
  }

  getLastValue(deviceId, registerId) {
    const key = `${deviceId}:${registerId}`;
    return this.cache.get(key);
  }

  getAllValues() {
    const result = [];
    for (const [key, value] of this.cache.entries()) {
      const [deviceId, registerId] = key.split(':');
      result.push({ deviceId, registerId, value });
    }
    return result;
  }

  clearCache() {
    this.cache.clear();
  }
}

// ============================================================================
// DATA TRANSMIT BUFFER - Manages batched WebSocket transmissions
// ============================================================================
class DataTransmitBuffer {
  constructor(fullRefreshInterval = 300000) { // 5 minutes default
    this.changeBuffer = [];
    this.lastFullRefresh = Date.now();
    this.fullRefreshInterval = fullRefreshInterval;
  }

  queueChange(deviceId, registerId, value, timestamp = new Date().toISOString()) {
    this.changeBuffer.push({ deviceId, registerId, value, timestamp });
  }

  shouldSendFullRefresh() {
    return Date.now() - this.lastFullRefresh >= this.fullRefreshInterval;
  }

  getBufferedChanges() {
    const changes = [...this.changeBuffer];
    this.changeBuffer = [];
    return changes;
  }

  resetFullRefreshTimer() {
    this.lastFullRefresh = Date.now();
  }
}

// ============================================================================
// OFFLINE BUFFER - Persists data to disk when connection is lost
// ============================================================================
class OfflineBuffer {
  constructor(bufferDir = './.modbus-agent-buffer') {
    this.bufferDir = bufferDir;
    this.bufferFile = path.join(bufferDir, 'offline-buffer.json');
    this.maxFileSize = 50 * 1024 * 1024; // 50MB max
    this.isOffline = false;
    this.ensureBufferDir();
  }

  ensureBufferDir() {
    if (!fs.existsSync(this.bufferDir)) {
      fs.mkdirSync(this.bufferDir, { recursive: true });
    }
  }

  startBuffering() {
    this.isOffline = true;
    console.log('[OfflineBuffer] Started offline buffering mode');
  }

  stopBuffering() {
    this.isOffline = false;
    console.log('[OfflineBuffer] Stopped offline buffering mode');
  }

  addDataPoints(dataPoints) {
    if (!this.isOffline || !dataPoints || dataPoints.length === 0) return;

    try {
      let buffer = [];
      
      // Load existing buffer
      if (fs.existsSync(this.bufferFile)) {
        const fileContent = fs.readFileSync(this.bufferFile, 'utf-8');
        buffer = JSON.parse(fileContent);
      }

      // Add new data points
      buffer.push(...dataPoints);

      // Write back to file
      fs.writeFileSync(this.bufferFile, JSON.stringify(buffer, null, 2));
      
      console.log(`[OfflineBuffer] Buffered ${dataPoints.length} data points (total: ${buffer.length})`);
    } catch (error) {
      console.error('[OfflineBuffer] Error writing to buffer:', error.message);
    }
  }

  getBufferedData() {
    try {
      if (!fs.existsSync(this.bufferFile)) return [];
      
      const fileContent = fs.readFileSync(this.bufferFile, 'utf-8');
      return JSON.parse(fileContent);
    } catch (error) {
      console.error('[OfflineBuffer] Error reading buffer:', error.message);
      return [];
    }
  }

  clearBuffer() {
    try {
      if (fs.existsSync(this.bufferFile)) {
        fs.unlinkSync(this.bufferFile);
        console.log('[OfflineBuffer] Buffer cleared');
      }
    } catch (error) {
      console.error('[OfflineBuffer] Error clearing buffer:', error.message);
    }
  }

  getBufferSize() {
    try {
      if (!fs.existsSync(this.bufferFile)) return 0;
      const stats = fs.statSync(this.bufferFile);
      return stats.size;
    } catch (error) {
      return 0;
    }
  }

  getRecordCount() {
    try {
      if (!fs.existsSync(this.bufferFile)) return 0;
      const fileContent = fs.readFileSync(this.bufferFile, 'utf-8');
      const buffer = JSON.parse(fileContent);
      return buffer.length;
    } catch (error) {
      return 0;
    }
  }
}

// ============================================================================
// HISTORICAL DATA BUFFER - Stores all reads for bulk upload
// ============================================================================
class HistoricalDataBuffer {
  constructor(maxBufferSize = 10000) {
    this.dataPoints = [];
    this.maxBufferSize = maxBufferSize;
  }

  addDataPoint(deviceId, registerId, value, timestamp = new Date().toISOString(), quality = 'good') {
    this.dataPoints.push({ deviceId, registerId, value, timestamp, quality });
    
    // Prevent memory overflow
    if (this.dataPoints.length > this.maxBufferSize) {
      console.warn(`[HistoricalDataBuffer] Buffer size exceeded ${this.maxBufferSize}, dropping oldest records`);
      this.dataPoints = this.dataPoints.slice(-this.maxBufferSize);
    }
  }

  getBufferedData() {
    return [...this.dataPoints];
  }

  clearBuffer() {
    this.dataPoints = [];
  }

  size() {
    return this.dataPoints.length;
  }
}

// ============================================================================
// REGISTER OPTIMIZER - Groups contiguous registers for efficient Modbus reads
// ============================================================================
class RegisterOptimizer {
  static optimizeRegisterReads(registers, maxBlockSize = 125) {
    if (!registers || registers.length === 0) return [];

    // Sort by address
    const sorted = [...registers].sort((a, b) => a.address - b.address);
    const blocks = [];
    let currentBlock = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = currentBlock[currentBlock.length - 1];
      
      // Check if contiguous and within max block size
      const isContiguous = current.address === last.address + 1;
      const wouldExceedMax = currentBlock.length >= maxBlockSize;

      if (isContiguous && !wouldExceedMax) {
        currentBlock.push(current);
      } else {
        blocks.push(currentBlock);
        currentBlock = [current];
      }
    }
    
    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    // Convert to read commands
    return blocks.map(block => ({
      startAddress: block[0].address,
      count: block.length,
      registers: block,
    }));
  }
}

// ============================================================================
// POLLING SCHEDULER - Manages internal polling timers
// ============================================================================
class PollingScheduler {
  constructor(agent) {
    this.agent = agent;
    this.timers = new Map(); // key: groupId, value: interval handle
    this.config = null;
    this.lastSuccessfulRead = new Map(); // Track last successful read timestamp per device
  }

  startPolling(config) {
    this.stopPolling();
    this.config = config;

    console.log('[PollingScheduler] Starting polling with config:', JSON.stringify(config, null, 2));

    for (const device of config.devices) {
      for (const group of device.pollGroups) {
        const timerId = setInterval(() => {
          this.pollGroup(device, group);
        }, group.interval);

        this.timers.set(group.groupId, timerId);
        console.log(`[PollingScheduler] Started poll group ${group.groupId} for device ${device.deviceId} at ${group.interval}ms interval`);
      }
    }
  }

  async pollGroup(device, group) {
    try {
      console.log(`[PollingScheduler] Polling group ${group.groupId} on device ${device.deviceId}`);

      // Connect to device
      let client;
      try {
        client = await this.agent.connectToDevice(device.connectionParams);
        if (!client) {
          throw new Error('Failed to get Modbus client');
        }
      } catch (connError) {
        console.error(`[PollingScheduler] Connection error for device ${device.deviceId}: ${connError.message} (code: ${connError.code || 'n/a'})`);
        const timestamp = new Date().toISOString();
        group.registers.forEach(register => {
          this.agent.historicalBuffer.addDataPoint(device.deviceId, register.registerId, null, timestamp, 'bad');
        });
        return;
      }

      // Optimize register reads
      const optimizedReads = RegisterOptimizer.optimizeRegisterReads(group.registers);
      console.log(`[PollingScheduler] Optimized ${group.registers.length} registers into ${optimizedReads.length} read commands`);

      const timestamp = new Date().toISOString();

      // Build merged connection params with protocol
      const connParams = {
        protocol: device.protocol,
        ...device.connectionParams
      };
      
      // Safety check for missing protocol
      if (!connParams.protocol) {
        console.warn(`[PollingScheduler] Device ${device.deviceId} missing protocol, skipping poll group`);
        return;
      }

      const cacheKey = JSON.stringify(connParams);
      const lastReadTime = this.lastSuccessfulRead.get(device.deviceId);

      // Execute optimized reads
      for (const readCmd of optimizedReads) {
        try {
          // Normalize Modbus register address (support 40001/30001 style maps)
          const normalize = (addr) => {
            if (addr >= 40001 && addr <= 49999) return addr - 40001; // Holding Registers (FC3)
            if (addr >= 30001 && addr <= 39999) return addr - 30001; // Input Registers (FC4)
            if (addr > 0) return addr - 1; // 1-based to 0-based fallback
            return addr;
          };

          // Check if we need to reconnect (socket health check only)
          let needsReconnect = false;
          if (connParams.protocol === 'tcp' && client) {
            const sock = client._client;
            const isDestroyed = sock?.destroyed === true;
            const isNotWritable = sock && !sock.writable;
            
            if (isDestroyed || isNotWritable) {
              console.log(`[PollingScheduler] Connection needs refresh: destroyed=${isDestroyed}, notWritable=${isNotWritable}`);
              needsReconnect = true;
            }
          }

          // Reconnect if needed
          if (needsReconnect || !client) {
            this.agent.deviceConnections.delete(cacheKey);
            console.log(`[PollingScheduler] Establishing fresh connection before read...`);
            client = await this.agent.connectToDevice(connParams);
          }

          const start = normalize(readCmd.startAddress);
          const data = await client.readHoldingRegisters(start, readCmd.count);
          
          // Track successful read
          this.lastSuccessfulRead.set(device.deviceId, Date.now());
          
          // Process each register value
          readCmd.registers.forEach((register, index) => {
            const value = data.data[index];
            const hasChanged = this.agent.valueCache.updateValue(device.deviceId, register.registerId, value);

            // Add to historical buffer (all data)
            this.agent.historicalBuffer.addDataPoint(
              device.deviceId,
              register.registerId,
              value,
              timestamp,
              'good'
            );

            // Add to transmit buffer only if changed (report-by-exception)
            if (hasChanged || this.agent.transmitBuffer.shouldSendFullRefresh()) {
              this.agent.transmitBuffer.queueChange(
                device.deviceId,
                register.registerId,
                value,
                timestamp
              );
            }
          });
        } catch (readError) {
          // Enhanced error logging with socket state diagnostics
          const sock = client?._client;
          const sockState = sock ? {
            destroyed: sock.destroyed,
            writable: sock.writable,
            readyState: sock.readyState,
            connecting: sock.connecting
          } : 'no socket';
          console.error(`[PollingScheduler] Error reading ${readCmd.startAddress}-${readCmd.startAddress + readCmd.count - 1}: ${readError.message} (code: ${readError.code || 'n/a'})`);
          console.error(`[PollingScheduler] Socket state at error:`, sockState);
          
          const isConnErr = /Port Not Open|ECONN|EPIPE|reset|closed|socket|Timeout/i.test(readError.message || '');
          if (isConnErr) {
            console.log('[PollingScheduler] Connection error detected, clearing cache and forcing fresh connection...');
            this.agent.deviceConnections.delete(cacheKey);
            try {
              client = await this.agent.connectToDevice(connParams);
              const retryStart = (function(addr){
                if (addr >= 40001 && addr <= 49999) return addr - 40001;
                if (addr >= 30001 && addr <= 39999) return addr - 30001;
                if (addr > 0) return addr - 1; 
                return addr;
              })(readCmd.startAddress);
              const retryData = await client.readHoldingRegisters(retryStart, readCmd.count);
              readCmd.registers.forEach((register, index) => {
                const value = retryData.data[index];
                const hasChanged = this.agent.valueCache.updateValue(device.deviceId, register.registerId, value);
                this.agent.historicalBuffer.addDataPoint(device.deviceId, register.registerId, value, timestamp, 'good');
                if (hasChanged || this.agent.transmitBuffer.shouldSendFullRefresh()) {
                  this.agent.transmitBuffer.queueChange(device.deviceId, register.registerId, value, timestamp);
                }
              });
              continue;
            } catch (retryErr) {
              console.error('[PollingScheduler] Retry failed:', retryErr.message);
            }
          }
          // Mark registers as bad quality in historical buffer
          readCmd.registers.forEach(register => {
            this.agent.historicalBuffer.addDataPoint(
              device.deviceId,
              register.registerId,
              null,
              timestamp,
              'bad'
            );
          });
        }
      }

    } catch (error) {
      console.error(`[PollingScheduler] Error polling group ${group.groupId}:`, error.message);
    }
  }

  stopPolling() {
    for (const [groupId, timerId] of this.timers.entries()) {
      clearInterval(timerId);
      console.log(`[PollingScheduler] Stopped poll group ${groupId}`);
    }
    this.timers.clear();
  }

  updateSchedule(newConfig) {
    console.log('[PollingScheduler] Updating polling schedule');
    this.startPolling(newConfig);
  }
}

// ============================================================================
// MODBUS MANAGER AGENT - Main agent class
// ============================================================================
class ModbusAgent {
  constructor(token) {
    this.registrationToken = token;
    this.jwt = null;
    this.jwtExpiry = null;
    this.ws = null;
    this.agentId = null;
    this.reconnectTimeout = null;
    this.heartbeatInterval = null;
    this.batchTransmitInterval = null;
    this.historicalUploadInterval = null;
    this.configCheckInterval = null;
    this.jwtRefreshInterval = null;
    this.deviceConnections = new Map(); // Cache Modbus connections

    // Polling engine components
    this.valueCache = new ValueCache();
    this.transmitBuffer = new DataTransmitBuffer(300000); // 5 min full refresh
    this.historicalBuffer = new HistoricalDataBuffer(10000);
    this.pollingScheduler = new PollingScheduler(this);

    // Configuration
    this.batchWindow = 2000; // 2 seconds
    this.historicalBatchInterval = 5000; // 5 seconds (for testing)
    this.configCheckIntervalMs = 120000; // 2 minutes
  }

  async connect() {
    // Exchange registration token for JWT if we don't have a valid one
    if (!this.jwt || this.isJwtExpiringSoon()) {
      await this.refreshJwt();
    }

    const wsUrl = `wss://ckdjiovqshugcprabpty.functions.supabase.co/agent-websocket?token=${this.jwt}`;
    
    console.log('Connecting to Modbus Manager...');
    console.log('WebSocket URL:', wsUrl);
    
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      console.log('✓ Connected to Modbus Manager');
      this.isOnline = true;
      this.connectionFailureCount = 0;
      this.lastConnectionTime = Date.now();
      
      // Stop offline buffering and upload any buffered data
      this.offlineBuffer.stopBuffering();
      this.uploadOfflineBuffer();
      
      this.startHeartbeat();
      this.startBatchTransmit();
      this.startHistoricalUpload();
      this.startConfigCheck();
      this.startJwtRefresh();
    });

    this.ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle welcome/connected message
        if (message.type === 'connected' && message.agentId) {
          this.agentId = message.agentId;
          console.log(`✓ Agent ID set: ${this.agentId}`);
          // Auto-fetch active polling config for this agent
          this.fetchAndApplyActiveConfig();
          return;
        }
        
        this.handleCommand(message);
      } catch (error) {
        console.error('Error parsing message:', error.message);
      }
    });

    this.ws.on('close', () => {
      console.log('✗ Disconnected from Modbus Manager');
      this.isOnline = false;
      this.connectionFailureCount++;
      
      // Start offline buffering
      this.offlineBuffer.startBuffering();
      this.updateBufferingStatus();
      
      this.stopHeartbeat();
      this.stopBatchTransmit();
      this.stopHistoricalUpload();
      this.stopConfigCheck();
      this.stopJwtRefresh();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.error('WebSocket error:', error.message);
      if (!this.isOnline) {
        this.connectionFailureCount++;
        this.offlineBuffer.startBuffering();
      }
    });
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'heartbeat' }));
      }
    }, 30000); // 30 seconds
  }

  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  startJwtRefresh() {
    // Refresh JWT every 55 minutes (5 minutes before expiry)
    this.jwtRefreshInterval = setInterval(async () => {
      try {
        console.log('Refreshing JWT token...');
        await this.refreshJwt();
        
        // Reconnect with new JWT
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          console.log('Reconnecting with refreshed JWT...');
          this.ws.close();
          await this.connect();
        }
      } catch (error) {
        console.error('Failed to refresh JWT:', error.message);
      }
    }, 55 * 60 * 1000); // 55 minutes
  }

  stopJwtRefresh() {
    if (this.jwtRefreshInterval) {
      clearInterval(this.jwtRefreshInterval);
      this.jwtRefreshInterval = null;
    }
  }

  async refreshJwt() {
    try {
      const authUrl = 'https://ckdjiovqshugcprabpty.functions.supabase.co/agent-auth';
      
      const response = await fetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          registration_token: this.registrationToken
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to authenticate');
      }

      const data = await response.json();
      this.jwt = data.jwt;
      this.jwtExpiry = Date.now() + (data.expires_in * 1000);
      
      console.log('✓ JWT refreshed successfully, expires in', data.expires_in, 'seconds');
    } catch (error) {
      console.error('JWT refresh failed:', error.message);
      throw error;
    }
  }

  isJwtExpiringSoon() {
    if (!this.jwtExpiry) return true;
    // Consider JWT expiring soon if less than 5 minutes remain
    return (this.jwtExpiry - Date.now()) < (5 * 60 * 1000);
  }

  startBatchTransmit() {
    this.batchTransmitInterval = setInterval(() => {
      this.sendBatchedUpdates();
    }, this.batchWindow);
  }

  stopBatchTransmit() {
    if (this.batchTransmitInterval) {
      clearInterval(this.batchTransmitInterval);
      this.batchTransmitInterval = null;
    }
  }

  startHistoricalUpload() {
    this.historicalUploadInterval = setInterval(() => {
      this.uploadHistoricalData();
    }, this.historicalBatchInterval);
  }

  stopHistoricalUpload() {
    if (this.historicalUploadInterval) {
      clearInterval(this.historicalUploadInterval);
      this.historicalUploadInterval = null;
    }
  }

  startConfigCheck() {
    // Check for config updates every 2 minutes
    this.configCheckInterval = setInterval(() => {
      this.fetchAndApplyActiveConfig();
    }, this.configCheckIntervalMs);
    console.log(`[ConfigCheck] Started periodic config check every ${this.configCheckIntervalMs / 1000}s`);
  }

  stopConfigCheck() {
    if (this.configCheckInterval) {
      clearInterval(this.configCheckInterval);
      this.configCheckInterval = null;
      console.log('[ConfigCheck] Stopped periodic config check');
    }
  }

  sendBatchedUpdates() {
    const isFullRefresh = this.transmitBuffer.shouldSendFullRefresh();
    let updates;

    if (isFullRefresh) {
      updates = this.valueCache.getAllValues();
      this.transmitBuffer.resetFullRefreshTimer();
      console.log(`[BatchTransmit] Sending full refresh with ${updates.length} values`);
    } else {
      updates = this.transmitBuffer.getBufferedChanges();
      if (updates.length === 0) return; // Nothing to send
      console.log(`[BatchTransmit] Sending ${updates.length} changed values`);
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: 'data_update',
        timestamp: new Date().toISOString(),
        isFullRefresh,
        updates,
      }));
    }
  }

  async uploadHistoricalData() {
    const dataPoints = this.historicalBuffer.getBufferedData();
    if (dataPoints.length === 0) return;

    console.log(`[HistoricalUpload] Uploading ${dataPoints.length} data points to cloud`);

    // If offline, buffer the data instead
    if (!this.isOnline || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.log('[HistoricalUpload] Offline - buffering data to disk');
      this.offlineBuffer.addDataPoints(dataPoints);
      this.historicalBuffer.clearBuffer();
      this.updateBufferingStatus();
      return;
    }

    try {
      const response = await fetch('https://ckdjiovqshugcprabpty.supabase.co/functions/v1/ingest-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          agentId: this.agentId,
          dataPoints,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        if (result.success) {
          console.log(`[HistoricalUpload] Successfully uploaded ${result.inserted} records`);
          this.historicalBuffer.clearBuffer();
          this.updateBufferingStatus();
        } else {
          console.error('[HistoricalUpload] Upload failed:', result.error || result.errors);
          // Buffer on failure
          this.offlineBuffer.addDataPoints(dataPoints);
          this.updateBufferingStatus();
        }
      } else {
        console.error('[HistoricalUpload] HTTP error:', response.status);
        // Buffer on failure
        this.offlineBuffer.addDataPoints(dataPoints);
        this.updateBufferingStatus();
      }
    } catch (error) {
      console.error('[HistoricalUpload] Failed to upload:', error.message);
      // Buffer on network error
      this.offlineBuffer.addDataPoints(dataPoints);
      this.historicalBuffer.clearBuffer();
      this.updateBufferingStatus();
    }
  }

  async uploadOfflineBuffer() {
    const bufferedData = this.offlineBuffer.getBufferedData();
    if (bufferedData.length === 0) return;

    console.log(`[OfflineRecovery] Uploading ${bufferedData.length} buffered data points from offline storage`);

    try {
      // Upload in batches to avoid overwhelming the backend
      const batchSize = 1000;
      for (let i = 0; i < bufferedData.length; i += batchSize) {
        const batch = bufferedData.slice(i, i + batchSize);
        
        const response = await fetch('https://ckdjiovqshugcprabpty.supabase.co/functions/v1/ingest-batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            agentId: this.agentId,
            dataPoints: batch,
          }),
        });

        if (response.ok) {
          const result = await response.json();
          if (result.success) {
            console.log(`[OfflineRecovery] Uploaded batch ${Math.floor(i / batchSize) + 1}: ${result.inserted} records`);
          }
        } else {
          throw new Error(`HTTP ${response.status}`);
        }
      }

      // Clear buffer after successful upload
      this.offlineBuffer.clearBuffer();
      console.log('[OfflineRecovery] All buffered data uploaded successfully');
      this.updateBufferingStatus();
    } catch (error) {
      console.error('[OfflineRecovery] Failed to upload buffered data:', error.message);
      console.log('[OfflineRecovery] Will retry on next connection');
    }
  }

  async updateBufferingStatus() {
    if (!this.agentId) return;

    const bufferedRecords = this.offlineBuffer.getRecordCount();
    const bufferingStatus = this.isOnline 
      ? (bufferedRecords > 0 ? 'online' : 'online')
      : 'buffering';

    try {
      await fetch('https://ckdjiovqshugcprabpty.supabase.co/rest/v1/agents?id=eq.' + this.agentId, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrZGppb3Zxc2h1Z2NwcmFicHR5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTkzNTMzMDIsImV4cCI6MjA3NDkyOTMwMn0.yGXKKQG3KkNv-O8eYsO9YgzsHuYJWXvi6RFJzNBfRHY',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          buffering_status: bufferingStatus,
          buffered_records: bufferedRecords
        }),
      });
    } catch (error) {
      console.error('[BufferingStatus] Failed to update status:', error.message);
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) return;
    
    console.log('Reconnecting in 5 seconds...');
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      this.connect();
    }, 5000);
  }

  async handleCommand(message) {
    // Support both camelCase and snake_case for backward compatibility
    const command = message.command || message.type;
    const commandId = message.commandId || message.command_id;
    const params = message.params || {};
    
    console.log(`Received command: ${command}`, commandId);

    try {
      switch (command) {
        case 'set_polling_config':
          await this.handleSetPollingConfig({ command, commandId, params });
          break;

        case 'network_scan':
          await this.handleNetworkScan({ command, commandId, params });
          break;

        case 'modbus_read':
          await this.handleModbusRead({ command, commandId, params });
          break;

        case 'modbus_write':
          await this.handleModbusWrite({ command, commandId, params });
          break;

        case 'test_communication':
          await this.handleTestCommunication({ command, commandId, params });
          break;

        case 'heartbeat_ack':
          // Heartbeat acknowledgment - no action needed
          console.log('[Heartbeat] Received acknowledgment from server');
          break;

        default:
          console.log(`Unknown command: ${command}`);
      }
    } catch (error) {
      console.error(`Error handling command ${command}:`, error.message);
      this.sendError(commandId, error.message);
    }
  }

  async handleSetPollingConfig(message) {
    const { commandId, params } = message;
    
    console.log('[SetPollingConfig] Received new polling configuration');

    try {
      // Update configuration settings
      if (params.fullRefreshInterval) {
        this.transmitBuffer.fullRefreshInterval = params.fullRefreshInterval;
      }
      if (params.batchWindow) {
        this.batchWindow = params.batchWindow;
        this.stopBatchTransmit();
        this.startBatchTransmit();
      }
      if (params.historicalBatchInterval) {
        this.historicalBatchInterval = params.historicalBatchInterval;
        this.stopHistoricalUpload();
        this.startHistoricalUpload();
      }

      // Start polling with new configuration
      this.pollingScheduler.updateSchedule(params);

      this.sendResult(commandId, 'polling_config_set', {
        success: true,
        message: 'Polling configuration applied successfully',
        devices: params.devices?.length || 0,
        totalPollGroups: params.devices?.reduce((sum, d) => sum + (d.pollGroups?.length || 0), 0) || 0,
      });
    } catch (error) {
      this.sendError(commandId, `Failed to set polling config: ${error.message}`);
    }
  }

  async connectToDevice(params, retries = 3) {
    // Infer protocol if missing
    if (!params.protocol) {
      if (params.deviceIp || params.ip) {
        params.protocol = 'tcp';
        console.log(`[Connection] Inferred protocol: tcp from IP address`);
      } else if (params.serialPort) {
        params.protocol = 'rtu';
        console.log(`[Connection] Inferred protocol: rtu from serial port`);
      } else {
        throw new Error('Missing protocol in connection params and cannot infer from params');
      }
    }

    const cacheKey = JSON.stringify(params);
    
    // Return cached connection if available and still open
    if (this.deviceConnections.has(cacheKey)) {
      const cachedClient = this.deviceConnections.get(cacheKey);
      
      // Different connection checks for TCP vs RTU
      let isOpen = false;
      if (params.protocol === 'tcp') {
        // For TCP: check if socket exists and is not destroyed
        isOpen = cachedClient?._client?.destroyed === false;
      } else {
        // For RTU: check serial port isOpen property
        isOpen = cachedClient?._port?.isOpen || false;
      }
      
      if (cachedClient && isOpen) {
        console.log(`[Connection] Using cached ${params.protocol.toUpperCase()} connection`);
        return cachedClient;
      }
      // Remove stale connection
      this.deviceConnections.delete(cacheKey);
      console.log(`[Connection] Cleared stale cached ${params.protocol} connection`);
    }

    const client = new ModbusRTU();
    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (params.protocol === 'tcp') {
          const ip = params.deviceIp || params.ip;
          const port = params.port || 502;
          console.log(`[Connection] Attempt ${attempt}/${retries} - Connecting to ${ip}:${port}`);
          
          await client.connectTCP(ip, { port });
          client.setID(params.unitId || 1);
          client.setTimeout(10000); // 10 second timeout
          
          // Attach socket diagnostics and enable keep-alive (TCP only)
          const sock = client?._client;
          if (sock && !sock._agentMonitored) {
            sock._agentMonitored = true;
            sock.setKeepAlive(true, 1000); // Enable keep-alive to prevent idle timeout
            sock.on('error', (e) => console.error(`[TCP] Socket error ${ip}:${port} - ${e.code || e.message}`));
            sock.on('close', (hadErr) => console.warn(`[TCP] Socket closed ${ip}:${port}, hadError=${hadErr}`));
            sock.on('end', () => console.warn(`[TCP] Socket ended ${ip}:${port}`));
          }

          console.log(`[Connection] ✓ Successfully connected to ${ip}:${port}`);
        } else if (params.protocol === 'rtu') {
          console.log(`[Connection] Attempt ${attempt}/${retries} - Connecting to ${params.serialPort}`);
          
          await client.connectRTUBuffered(params.serialPort, {
            baudRate: params.baudRate || 9600,
            parity: params.parity || 'none',
            dataBits: params.dataBits || 8,
            stopBits: params.stopBits || 1,
          });
          client.setID(params.unitId || 1);
          client.setTimeout(10000);
          
          console.log(`[Connection] ✓ Successfully connected to ${params.serialPort}`);
        } else {
          throw new Error(`Unknown protocol: ${params.protocol}`);
        }

        this.deviceConnections.set(cacheKey, client);
        return client;
      } catch (error) {
        lastError = error;
        console.error(`[Connection] ✗ Attempt ${attempt}/${retries} failed: ${error.message} (code: ${error.code || 'n/a'})`);
        
        // TCP reachability probe for diagnostics
        if (params.protocol === 'tcp') {
          const ip = params.deviceIp || params.ip;
          const port = params.port || 502;
          await new Promise((resolve) => {
            try {
              const probe = new net.Socket();
              let outcome = 'unknown';
              probe.setTimeout(2000);
              probe.once('connect', () => { outcome = 'connect'; probe.destroy(); });
              probe.once('timeout', () => { outcome = 'timeout'; probe.destroy(); });
              probe.once('error', (e) => { outcome = `error:${e.code || e.message}`; });
              probe.once('close', () => { console.log(`[Connection][Diag] Probe ${ip}:${port} -> ${outcome}`); resolve(null); });
              probe.connect(port, ip);
            } catch (_) { resolve(null); }
          });
        }

        if (attempt < retries) {
          console.log(`[Connection] Retrying in 2 seconds...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    const errorMsg = `Failed to connect after ${retries} attempts: ${lastError?.message || 'Unknown error'}`;
    console.error(`[Connection] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  async handleNetworkScan(message) {
    const { commandId, params } = message;
    const results = [];

    try {
      const ipRange = params.ipRange || '192.168.1.1-254';
      const [baseIp, range] = ipRange.split('-');
      const [a, b, c, start] = baseIp.split('.').map(Number);
      const end = parseInt(range) || start;

      for (let i = start; i <= end; i++) {
        const ip = `${a}.${b}.${c}.${i}`;
        const client = await this.connectToDevice({
          protocol: 'tcp',
          deviceIp: ip,
          port: params.port || 502,
          unitId: 1,
        });

        if (client) {
          try {
            await client.readHoldingRegisters(0, 1);
            results.push({ ip, status: 'online', port: params.port || 502 });
            console.log(`✓ Found device at ${ip}`);
          } catch {
            // Device didn't respond
          }
        }
      }

      this.sendResult(commandId, 'scan_result', { devices: results });
    } catch (error) {
      this.sendError(commandId, error.message);
    }
  }

  async handleModbusRead(message) {
    const { commandId, params } = message;

    try {
      const client = await this.connectToDevice(params);
      if (!client) {
        throw new Error('Failed to connect to device');
      }

      const address = params.registerAddress;
      const count = params.registerCount || 1;
      const functionCode = params.functionCode || 3;

      let data;
      const normalize = (addr) => {
        if (addr >= 40001 && addr <= 49999) return addr - 40001;
        if (addr >= 30001 && addr <= 39999) return addr - 30001;
        if (addr > 0) return addr - 1;
        return addr;
      };
      const start = normalize(address);
      if (functionCode === 1) {
        data = await client.readCoils(start, count);
      } else if (functionCode === 2) {
        data = await client.readDiscreteInputs(start, count);
      } else if (functionCode === 3) {
        data = await client.readHoldingRegisters(start, count);
      } else if (functionCode === 4) {
        data = await client.readInputRegisters(start, count);
      }

      this.sendResult(commandId, 'modbus_read_result', {
        address,
        count,
        values: data.data,
      });
    } catch (error) {
      this.sendError(commandId, error.message);
    }
  }

  async handleModbusWrite(message) {
    const { commandId, params } = message;

    try {
      const client = await this.connectToDevice(params);
      if (!client) {
        throw new Error('Failed to connect to device');
      }

      const address = params.registerAddress;
      const value = params.value;
      const functionCode = params.functionCode || 6;

      if (functionCode === 5) {
        await client.writeCoil(address, value);
      } else if (functionCode === 6) {
        await client.writeRegister(address, value);
      } else if (functionCode === 15) {
        await client.writeCoils(address, [value]);
      } else if (functionCode === 16) {
        await client.writeRegisters(address, [value]);
      }

      this.sendResult(commandId, 'modbus_write_result', {
        address,
        value,
        success: true,
      });
    } catch (error) {
      this.sendError(commandId, error.message);
    }
  }

  async handleTestCommunication(message) {
    const { commandId, params } = message;

    try {
      const client = await this.connectToDevice(params);
      if (!client) {
        throw new Error('Failed to connect to device');
      }

      const pingCount = params.pingCount || 3;
      const results = [];

      for (let i = 0; i < pingCount; i++) {
        const startTime = Date.now();
        try {
          await client.readHoldingRegisters(0, 1);
          const responseTime = Date.now() - startTime;
          results.push({ success: true, responseTime });
        } catch {
          results.push({ success: false, responseTime: null });
        }
      }

      const successfulPings = results.filter(r => r.success).length;
      const avgResponseTime = results.filter(r => r.success)
        .reduce((sum, r) => sum + r.responseTime, 0) / successfulPings;

      this.sendResult(commandId, 'test_result', {
        success: successfulPings > 0,
        successRate: (successfulPings / pingCount) * 100,
        avgResponseTime: avgResponseTime || null,
        results,
      });
    } catch (error) {
      this.sendError(commandId, error.message);
    }
  }

  sendResult(commandId, type, data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        commandId,
        type,
        ...data,
      }));
    }
  }

  sendError(commandId, message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        commandId,
        type: 'error',
        error: message,
      }));
    }
  }

  async fetchAndApplyActiveConfig() {
    try {
      const resp = await fetch('https://ckdjiovqshugcprabpty.supabase.co/functions/v1/get-active-config', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.token}`,
        },
      });
      const result = await resp.json();
      console.log('[ConfigCheck] API response:', JSON.stringify(result, null, 2));
      if (result?.hasConfig && result.config?.polling_config) {
        const configId = result.config.id;
        const configName = result.config.config_name;
        
        // Check if this is a new config or an update
        const isNewConfig = !this.currentConfigId || this.currentConfigId !== configId;
        
        if (isNewConfig) {
          console.log(`[ConfigCheck] New configuration detected: ${configName} (${configId})`);
          this.currentConfigId = configId;
          await this.handleSetPollingConfig({ commandId: 'config-update', params: result.config.polling_config });
        } else {
          console.log(`[ConfigCheck] Configuration unchanged: ${configName}`);
        }
      } else {
        if (this.currentConfigId) {
          console.log('[ConfigCheck] Active config removed - stopping polling');
          this.pollingScheduler.stopPolling();
          this.currentConfigId = null;
        } else {
          console.log('[ConfigCheck] No active polling configuration assigned to this agent');
        }
      }
    } catch (e) {
      console.error('[ConfigCheck] Failed to fetch active config:', e.message);
    }
  }
}

// ============================================================================
// CLI ENTRY POINT
// ============================================================================
program
  .version('0.2.0')
  .description('Modbus Manager Local Agent - High-Performance Polling Engine')
  .requiredOption('-t, --token <token>', 'Agent registration token')
  .parse(process.argv);

const options = program.opts();
const agent = new ModbusAgent(options.token);
agent.connect();

console.log('Modbus Manager Agent v0.2.0 - High-Performance Polling Engine');
console.log('Press Ctrl+C to stop');
