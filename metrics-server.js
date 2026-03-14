#!/usr/bin/env node

/**
 * SIPp Metrics Server
 * Continuous service that monitors SIPp statistics files and exposes Prometheus metrics
 *
 * Usage:
 *   node metrics-server.js
 *
 * Environment variables:
 *   METRICS_PORT - Port to listen on (default: 9090)
 *   STATS_DIR - Directory containing SIPp stats files (default: ./sipp/stats)
 *   UPDATE_INTERVAL - Interval to update metrics in seconds (default: 5)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
require('dotenv').config();

const { parseStatsDirectory, parseSippStatsFile, parseStatsFilename, parseLatestStats } = require('./lib/sipp-parser');
const {
  updateResponseTimeMetrics,
  updateCallMetrics,
  updateStatsFileCount,
  getMetrics,
  getContentType
} = require('./lib/prometheus-metrics');
const statsTracker = require('./lib/stats-tracker');

// Configuration
const PORT = process.env.METRICS_PORT || 9090;
const BASE_DIR = process.env.BASE_DIR || __dirname;
const STATS_DIR = process.env.STATS_DIR || path.join(BASE_DIR, 'sipp', 'stats');
const UPDATE_INTERVAL = parseInt(process.env.UPDATE_INTERVAL) || 10; // seconds (default 10)
const FILE_CLEANUP_AGE = parseInt(process.env.FILE_CLEANUP_AGE) || 600; // seconds (default 10 min)
const ENABLE_METRICS = process.env.ENABLE_METRICS !== 'false'; // Set to 'false' to disable all processing
const TEXTFILE_PATH = process.env.TEXTFILE_PATH || '/usr/local/NetSapiens/agent/textfile_collector/sipp.prom';

// State tracking
let lastUpdateTime = Date.now();
let statsFileCache = new Map(); // Track: { filePath: { mtime, size, lastParsedSize } }

// Performance tracking
let perfStats = {
  updateCycles: 0,
  totalUpdateTime: 0,
  totalParseTime: 0,
  filesProcessed: 0,
  filesDeleted: 0
};

/**
 * Initialize Express app
 */
const app = express();

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  const avgUpdateTime = perfStats.updateCycles > 0
    ? (perfStats.totalUpdateTime / perfStats.updateCycles).toFixed(2)
    : 0;
  const avgParseTime = perfStats.filesProcessed > 0
    ? (perfStats.totalParseTime / perfStats.filesProcessed).toFixed(2)
    : 0;

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    lastUpdate: new Date(lastUpdateTime).toISOString(),
    statsDirectory: STATS_DIR,
    activeFiles: statsFileCache.size,
    enabled: ENABLE_METRICS,
    settings: {
      updateIntervalSec: UPDATE_INTERVAL,
      fileCleanupAgeSec: FILE_CLEANUP_AGE
    },
    performance: {
      updateCycles: perfStats.updateCycles,
      avgUpdateTimeMs: avgUpdateTime,
      avgParseTimeMs: avgParseTime,
      totalFilesProcessed: perfStats.filesProcessed,
      filesDeleted: perfStats.filesDeleted
    }
  });
});

/**
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    const metrics = await getMetrics();
    res.end(metrics);
  } catch (error) {
    console.error('Error generating metrics:', error);
    res.status(500).end('Error generating metrics');
  }
});

/**
 * Root endpoint - basic info
 */
app.get('/', (req, res) => {
  res.send(`
    <html>
      <head><title>SIPp Metrics Server</title></head>
      <body>
        <h1>SIPp Prometheus Metrics Server</h1>
        <p>This server monitors SIPp statistics files and exposes metrics for Prometheus.</p>
        <ul>
          <li><a href="/metrics">/metrics</a> - Prometheus metrics endpoint</li>
          <li><a href="/health">/health</a> - Health check endpoint</li>
        </ul>
        <h2>Configuration</h2>
        <ul>
          <li>Stats Directory: <code>${STATS_DIR}</code></li>
          <li>Update Interval: ${UPDATE_INTERVAL} seconds</li>
          <li>Active Files: ${statsFileCache.size}</li>
          <li>Last Update: ${new Date(lastUpdateTime).toISOString()}</li>
        </ul>
      </body>
    </html>
  `);
});

/**
 * Write metrics to textfile for Prometheus Node Exporter textfile collector
 * Includes both SIPp metrics and performance stats
 */
async function writeMetricsToFile() {
  try {
    // Get main metrics
    const metricsContent = await getMetrics();

    // Add performance metrics
    const avgUpdateTime = perfStats.updateCycles > 0
      ? (perfStats.totalUpdateTime / perfStats.updateCycles).toFixed(2)
      : 0;
    const avgParseTime = perfStats.filesProcessed > 0
      ? (perfStats.totalParseTime / perfStats.filesProcessed).toFixed(2)
      : 0;

    const performanceMetrics = `
# HELP sipp_metrics_update_cycles_total Total number of update cycles completed
# TYPE sipp_metrics_update_cycles_total counter
sipp_metrics_update_cycles_total ${perfStats.updateCycles}

# HELP sipp_metrics_update_time_seconds_average Average update cycle time in seconds
# TYPE sipp_metrics_update_time_seconds_average gauge
sipp_metrics_update_time_seconds_average ${(avgUpdateTime / 1000).toFixed(6)}

# HELP sipp_metrics_parse_time_seconds_average Average parse time per file in seconds
# TYPE sipp_metrics_parse_time_seconds_average gauge
sipp_metrics_parse_time_seconds_average ${(avgParseTime / 1000).toFixed(6)}

# HELP sipp_metrics_files_processed_total Total number of files processed
# TYPE sipp_metrics_files_processed_total counter
sipp_metrics_files_processed_total ${perfStats.filesProcessed}

# HELP sipp_metrics_files_deleted_total Total number of old files deleted
# TYPE sipp_metrics_files_deleted_total counter
sipp_metrics_files_deleted_total ${perfStats.filesDeleted}

# HELP sipp_metrics_cache_size Current number of files in cache
# TYPE sipp_metrics_cache_size gauge
sipp_metrics_cache_size ${statsFileCache.size}
`;

    const fullContent = metricsContent + performanceMetrics;

    // Only write if directory exists (don't create it)
    const dir = path.dirname(TEXTFILE_PATH);
    if (!fs.existsSync(dir)) {
      // Directory doesn't exist, skip writing
      return;
    }

    // Atomic write: write to temp file, then rename
    const tempPath = TEXTFILE_PATH + '.tmp';
    fs.writeFileSync(tempPath, fullContent, 'utf-8');
    fs.renameSync(tempPath, TEXTFILE_PATH);

  } catch (error) {
    console.error('Error writing metrics to file:', error.message);
  }
}

/**
 * Update metrics from all stats files
 * Only parses the LAST line from each file (most recent stats)
 */
async function updateMetrics() {
  if (!ENABLE_METRICS) {
    return; // Completely skip processing if disabled
  }

  const cycleStart = Date.now();

  try {
    if (!fs.existsSync(STATS_DIR)) {
      return;
    }

    const files = fs.readdirSync(STATS_DIR).filter(f => f.endsWith('.csv'));

    // Early exit if no files - skip all processing
    if (files.length === 0) {
      updateStatsFileCount(0);
      return;
    }

    const currentFiles = new Set();
    const now = Date.now();
    let filesUpdated = 0;
    let skippedCount = 0;
    let deletedFiles = 0;

    // Remove stale files from stats tracker (>5min since last update)
    const staleFiles = statsTracker.removeStaleFiles();
    if (staleFiles.length > 0) {
      console.log(`Removed ${staleFiles.length} stale files from tracker`);
    }

    // Update file count metric
    updateStatsFileCount(files.length);

    // Collect stats for aggregation
    const fileStatsForAggregation = [];

    // Process each stats file
    for (const filename of files) {
      const filePath = path.join(STATS_DIR, filename);
      currentFiles.add(filePath);

      try {
        // Check if file was modified recently
        const fileStat = fs.statSync(filePath);
        const fileAge = (now - fileStat.mtimeMs) / 1000; // seconds

        // Delete files older than FILE_CLEANUP_AGE
        if (fileAge > FILE_CLEANUP_AGE) {
          try {
            fs.unlinkSync(filePath);
            statsFileCache.delete(filePath);
            deletedFiles++;
            perfStats.filesDeleted++;
            console.log(`Deleted old file (${Math.floor(fileAge / 60)}min old): ${filename}`);
          } catch (e) {
            console.error(`Failed to delete ${filename}:`, e.message);
          }
          continue;
        }

        const currentSize = fileStat.size;
        const cached = statsFileCache.get(filePath);

        // Skip if file hasn't grown
        if (cached && cached.size >= currentSize) {
          skippedCount++;
          continue;
        }

        // Parse only the last line (most recent stats)
        const parseStart = Date.now();
        const result = parseLatestStats(filePath);
        const parseTime = Date.now() - parseStart;

        perfStats.totalParseTime += parseTime;
        perfStats.filesProcessed++;

        if (!result.stats) {
          // Update cache even if parsing failed
          statsFileCache.set(filePath, {
            mtime: fileStat.mtimeMs,
            size: currentSize
          });
          skippedCount++;
          continue;
        }

        const metadata = parseStatsFilename(filename);
        // In legacy single-server mode (no servers.json), fall back to TARGET_SERVER from .env
        if (metadata.serverId === 'default' && process.env.TARGET_SERVER) {
          metadata.serverId = process.env.TARGET_SERVER;
        }
        const { serverId, scenario, transport } = metadata;

        // Update state tracker and get deltas
        const deltas = statsTracker.updateFileState(filePath, result.stats, currentSize);

        // Collect for aggregation (need both current stats and deltas)
        fileStatsForAggregation.push({
          metadata,
          stats: result.stats,
          deltas
        });

        // Update response time metrics for each operation
        const { responseTimesByOperation } = result.stats;

        if (responseTimesByOperation && Object.keys(responseTimesByOperation).length > 0) {
          let hasData = false;

          for (const [operation, responseTimes] of Object.entries(responseTimesByOperation)) {
            if (responseTimes && responseTimes.count > 0) {
              updateResponseTimeMetrics(serverId, scenario, operation, transport, responseTimes);
              hasData = true;

              // Log first few updates
              if (filesUpdated < 3) {
                console.log(
                  `✓ Updated ${filename}: server=${serverId}, scenario=${scenario}, ` +
                  `transport=${transport}, operation=${operation}, samples=${responseTimes.count}, ` +
                  `avg=${responseTimes.average.toFixed(4)}s, p95=${responseTimes.percentiles.p95.toFixed(4)}s, ` +
                  `calls=${result.stats.totalCalls}, rate=${deltas ? deltas.instantCallRate.toFixed(2) : 0}cps`
                );
              }
            }
          }

          if (!hasData && filesUpdated < 3) {
            console.log(
              `⚠ Skipped ${filename}: no response time data in any operation`
            );
          }
        } else {
          // Debug: Log why we're not updating metrics
          if (filesUpdated < 3) {
            console.log(
              `⚠ Skipped ${filename}: no operations found`
            );
          }
        }

        // Update cache
        statsFileCache.set(filePath, {
          mtime: fileStat.mtimeMs,
          size: currentSize
        });

        filesUpdated++;
      } catch (err) {
        console.error(`Error processing file ${filename}:`, err.message);
      }
    }

    // Aggregate stats and update call metrics
    if (fileStatsForAggregation.length > 0) {
      const aggregatedStats = statsTracker.aggregateStats(fileStatsForAggregation);
      updateCallMetrics(aggregatedStats);

      // Log aggregated stats
      if (aggregatedStats.size > 0) {
        const trackerStats = statsTracker.getCacheStats();
        console.log(
          `Aggregated: ${aggregatedStats.size} groups, ` +
          `tracker: ${trackerStats.activeFiles} active/${trackerStats.totalFiles} total`
        );
      }
    }

    // Clean up cache for files that no longer exist
    for (const [file, _] of statsFileCache.entries()) {
      if (!currentFiles.has(file)) {
        statsFileCache.delete(file);
        console.log(`Removed stale file from cache: ${path.basename(file)}`);
      }
    }

    const cycleTime = Date.now() - cycleStart;
    perfStats.updateCycles++;
    perfStats.totalUpdateTime += cycleTime;

    if (filesUpdated > 0 || deletedFiles > 0 || (Date.now() - lastUpdateTime) > 60000) {
      console.log(
        `Cycle: ${filesUpdated} updated, ${skippedCount} skipped, ${deletedFiles} deleted, ` +
        `${files.length} total, ${cycleTime}ms (avg: ${(perfStats.totalUpdateTime / perfStats.updateCycles).toFixed(1)}ms)`
      );
    }

    // Write metrics to textfile for Node Exporter
    await writeMetricsToFile();

    lastUpdateTime = Date.now();
  } catch (error) {
    console.error('Error updating metrics:', error);
    perfStats.updateCycles++;
    perfStats.totalUpdateTime += (Date.now() - cycleStart);
  }
}

/**
 * Process a single stats file
 * @param {string} filePath - Path to stats file
 */
function processStatsFile(filePath) {
  try {
    const filename = path.basename(filePath);

    // Check if file was modified since last update
    const fileStat = fs.statSync(filePath);
    const lastModified = fileStat.mtimeMs;

    const cachedModTime = statsFileCache.get(filePath);
    if (cachedModTime && cachedModTime >= lastModified) {
      // File hasn't changed, skip parsing
      return false;
    }

    // Parse only this file (moved require to top of file)
    const stats = parseSippStatsFile(filePath);

    if (!stats) {
      return false;
    }

    const metadata = parseStatsFilename(filename);
    // In legacy single-server mode (no servers.json), fall back to TARGET_SERVER from .env
    if (metadata.serverId === 'default' && process.env.TARGET_SERVER) {
      metadata.serverId = process.env.TARGET_SERVER;
    }
    const { serverId, scenario, transport } = metadata;

    // Update cache
    statsFileCache.set(filePath, lastModified);

    // Extract response times
    const { responseTimes } = stats;

    if (responseTimes && responseTimes.count > 0) {
      const operation = scenario === 'register' ? 'register' : scenario;
      updateResponseTimeMetrics(serverId, scenario, operation, transport, responseTimes);
      return true;
    }

    return false;
  } catch (err) {
    console.error(`Error processing file ${path.basename(filePath)}:`, err.message);
    return false;
  }
}

// Debounce mechanism to batch rapid file changes
let updateDebounceTimer = null;
let pendingFiles = new Set();

function scheduleFileUpdate(filePath) {
  pendingFiles.add(filePath);

  if (updateDebounceTimer) {
    clearTimeout(updateDebounceTimer);
  }

  updateDebounceTimer = setTimeout(() => {
    const files = Array.from(pendingFiles);
    pendingFiles.clear();

    let processed = 0;
    for (const file of files) {
      if (processStatsFile(file)) {
        processed++;
      }
    }

    if (processed > 0) {
      lastUpdateTime = Date.now();
    }
  }, 200); // Wait 200ms for more changes
}

/**
 * Start watching stats directory
 */
function startWatching() {
  if (!ENABLE_METRICS) {
    console.log('Metrics processing DISABLED (set ENABLE_METRICS=true to enable)');
    return null;
  }

  // Ensure stats directory exists
  if (!fs.existsSync(STATS_DIR)) {
    console.log(`Creating stats directory: ${STATS_DIR}`);
    fs.mkdirSync(STATS_DIR, { recursive: true });
  }

  console.log(`Watching stats directory: ${STATS_DIR}`);

  // DISABLED: File watcher can cause high CPU with many files
  // Using periodic polling only instead
  let watcher = null;

  const USE_FILE_WATCHER = process.env.USE_FILE_WATCHER === 'true';

  if (USE_FILE_WATCHER) {
    console.log('File watching ENABLED (can cause high CPU with many files)');
    watcher = chokidar.watch(`${STATS_DIR}/*.csv`, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 2000,
        pollInterval: 500
      },
      usePolling: false,
      interval: 5000,
      binaryInterval: 5000
    });

    watcher.on('add', (filePath) => {
      scheduleFileUpdate(filePath);
    });

    watcher.on('change', (filePath) => {
      scheduleFileUpdate(filePath);
    });

    watcher.on('unlink', (filePath) => {
      statsFileCache.delete(filePath);
    });

    watcher.on('error', (error) => {
      console.error('Watcher error:', error);
    });
  } else {
    console.log('File watching DISABLED - using periodic polling only');
  }

  // Periodic full scan - this is the main update mechanism now
  const scanInterval = UPDATE_INTERVAL * 1000; // No minimum, user controls it
  console.log(`Scanning every ${scanInterval / 1000} seconds`);

  setInterval(() => {
    updateMetrics();
  }, scanInterval);

  return watcher;
}

/**
 * Start the metrics server
 */
function startServer() {
  console.log('=================================');
  console.log('SIPp Prometheus Metrics Server');
  console.log('=================================');
  console.log(`Port: ${PORT}`);
  console.log(`Stats Directory: ${STATS_DIR}`);
  console.log(`Update Interval: ${UPDATE_INTERVAL}s`);
  console.log(`File Cleanup Age: ${FILE_CLEANUP_AGE}s (${Math.floor(FILE_CLEANUP_AGE / 60)}min)`);
  console.log(`Parse Mode: Last line only (fast)`);
  console.log(`Textfile Export: ${TEXTFILE_PATH}`);
  console.log('=================================\n');

  // Check if textfile export directory exists
  const textfileDir = path.dirname(TEXTFILE_PATH);
  if (!fs.existsSync(textfileDir)) {
    console.log(`⚠️  Textfile directory not found: ${textfileDir}`);
    console.log(`   Metrics will not be exported to file until directory is created\n`);
  } else {
    console.log(`✓ Textfile directory exists, will export to: ${TEXTFILE_PATH}\n`);
  }

  // Start watching stats directory
  const watcher = startWatching();

  // Initial metrics update
  updateMetrics();

  // Start Express server
  const server = app.listen(PORT, () => {
    console.log(`Metrics server listening on http://localhost:${PORT}`);
    console.log(`Prometheus endpoint: http://localhost:${PORT}/metrics`);
    console.log(`Health check: http://localhost:${PORT}/health\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    if (watcher) {
      watcher.close();
    }
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Start the server if run directly
if (require.main === module) {
  startServer();
}

module.exports = { app, startServer, updateMetrics };
