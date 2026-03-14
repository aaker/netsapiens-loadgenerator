const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * Configuration loader for multi-server and single-server modes
 *
 * Supports:
 * - Multi-server mode: servers.json with multiple target configurations
 * - Legacy mode: .env with single TARGET_SERVER and APIKEY
 * - Command-line argument parsing: --server <server-id>
 */

class ConfigLoader {
  constructor() {
    this.mode = null; // 'multi' or 'single'
    this.servers = [];
    this.selectedServer = null;
  }

  /**
   * Load configuration from servers.json or .env
   * @returns {Object} Configuration object
   */
  load() {
    const serversJsonPath = path.join(process.cwd(), 'servers.json');

    // Check if servers.json exists (multi-server mode)
    if (fs.existsSync(serversJsonPath)) {
      this.mode = 'multi';
      this._loadMultiServerConfig(serversJsonPath);
    } else {
      this.mode = 'single';
      this._loadSingleServerConfig();
    }

    // Parse command-line arguments
    this._parseCommandLineArgs();

    // Validate configuration
    this._validate();

    return {
      mode: this.mode,
      servers: this.servers,
      selectedServer: this.selectedServer
    };
  }

  /**
   * Load multi-server configuration from servers.json
   * @private
   */
  _loadMultiServerConfig(filePath) {
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const config = JSON.parse(data);

      if (!config.servers || !Array.isArray(config.servers)) {
        throw new Error('servers.json must contain a "servers" array');
      }

      this.servers = config.servers.map(server => ({
        id: server.id,
        hostname: server.hostname,
        apikey: server.apikey,
        maxDomains: server.maxDomains || parseInt(process.env.MAX_DOMAIN) || 10,
        maxResellers: server.maxResellers  || parseInt(process.env.MAX_RESELLERS) || Math.max(Math.floor(parseInt(server.maxDomains)/30),199) || Math.max(Math.floor(parseInt(process.env.MAX_DOMAIN)/30), 200) || 30,
        peakCps: parseFloat(server.peakCps) || parseFloat(process.env.PEAK_CPS) || 10,
        registrationPct: parseFloat(server.registrationPct) || parseFloat(process.env.REGISTRATION_PCT) || 0.8,
        seed: parseInt(server.seed) || parseInt(process.env.SEED) || Math.floor(Math.random() * 100000),
        description: server.description || ''
      }));

      console.log(`[Config] Loaded ${this.servers.length} server(s) from servers.json`);
      this.servers.forEach(s => {
        console.log(`  - ${s.id}: ${s.hostname} (${s.maxDomains} domains, ${s.maxResellers} resellers, CPS: ${s.peakCps})`);
      });

    } catch (error) {
      throw new Error(`Failed to load servers.json: ${error.message}`);
    }
  }

  /**
   * Load single-server configuration from .env (legacy mode)
   * @private
   */
  _loadSingleServerConfig() {
    const hostname = process.env.TARGET_SERVER;
    const apikey = process.env.APIKEY;

    if (!hostname || !apikey) {
      throw new Error('Legacy mode requires TARGET_SERVER and APIKEY in .env file');
    }

    const server = {
      id: 'default',
      hostname: hostname,
      apikey: apikey,
      maxDomains: parseInt(process.env.MAX_DOMAIN) || 10,
      maxResellers: parseInt(process.env.MAX_RESELLERS) ||  Math.max(Math.floor(parseInt(process.env.MAX_DOMAIN)/30), 200) || 30,
      peakCps: parseFloat(process.env.PEAK_CPS) || 10,
      registrationPct: parseFloat(process.env.REGISTRATION_PCT) || 0.8,
      seed: parseInt(process.env.SEED) || Math.floor(Math.random() * 100000),
      description: 'Legacy single-server configuration'
    };

    this.servers = [server];
    this.selectedServer = server;

    console.log(`[Config] Loaded legacy single-server configuration: ${hostname}`);
  }

  /**
   * Parse command-line arguments
   * @private
   */
  _parseCommandLineArgs() {
    const args = process.argv.slice(2);

    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--server' && i + 1 < args.length) {
        const serverId = args[i + 1];
        const server = this.servers.find(s => s.id === serverId);

        if (!server) {
          const availableIds = this.servers.map(s => s.id).join(', ');
          throw new Error(
            `Server '${serverId}' not found in configuration. ` +
            `Available servers: ${availableIds}`
          );
        }

        this.selectedServer = server;
        console.log(`[Config] Selected server: ${serverId} (${server.hostname})`);
        break;
      }
    }
  }

  /**
   * Validate configuration
   * @private
   */
  _validate() {
    // In multi-server mode, require explicit --server selection
    if (this.mode === 'multi' && !this.selectedServer) {
      const availableIds = this.servers.map(s => s.id).join(', ');
      throw new Error(
        `Multi-server mode requires --server flag. ` +
        `Available servers: ${availableIds}\n` +
        `Usage: node server.js --server <server-id>`
      );
    }

    // Validate selected server has all required fields
    if (this.selectedServer) {
      const required = ['id', 'hostname', 'apikey'];
      for (const field of required) {
        if (!this.selectedServer[field]) {
          throw new Error(`Server configuration missing required field: ${field}`);
        }
      }

      // Validate hostname format
      const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*[a-zA-Z0-9]$/;
      if (!hostnameRegex.test(this.selectedServer.hostname)) {
        throw new Error(`Invalid hostname format: ${this.selectedServer.hostname}`);
      }

      // Validate numeric fields
      if (this.selectedServer.maxDomains < 1) {
        throw new Error('maxDomains must be at least 1');
      }

      if (this.selectedServer.maxResellers < 1) {
        throw new Error('maxResellers must be at least 1');
      }
      if (this.selectedServer.peakCps <= 0) {
        throw new Error('peakCps must be greater than 0 (supports decimals like 0.5)');
      }
      if (this.selectedServer.registrationPct < 0 || this.selectedServer.registrationPct > 1) {
        throw new Error('registrationPct must be between 0 and 1 (e.g., 0.5 = 50%)');
      }
    }
  }

  /**
   * Get the selected server configuration
   * @returns {Object|null} Server configuration object
   */
  getSelectedServer() {
    return this.selectedServer;
  }

  /**
   * Get all server configurations
   * @returns {Array} Array of server configuration objects
   */
  getAllServers() {
    return this.servers;
  }

  /**
   * Get configuration mode
   * @returns {string} 'multi' or 'single'
   */
  getMode() {
    return this.mode;
  }
}

/**
 * Factory function to load and return configuration
 * @returns {Object} Configuration object with mode, servers, and selectedServer
 */
function loadConfig() {
  const loader = new ConfigLoader();
  return loader.load();
}

module.exports = {
  ConfigLoader,
  loadConfig
};
