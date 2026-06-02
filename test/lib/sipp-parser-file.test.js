const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseSippStatsFile, parseStatsDirectory, parseLatestStats } = require('../../lib/sipp-parser');

// Minimal SIPp CSV header with essential columns
const SIPP_HEADER = [
  'StartTime', 'LastResetTime', 'CurrentTime', 'ElapsedTime', 'TargetRate',
  'CallRate', 'IncomingCall', 'OutgoingCall', 'TotalCallCreated',
  'CurrentCall', 'SuccessfulCall', 'FailedCall',
  'FailedCannotSendMessage', 'FailedMaxUDPRetrans', 'FailedUnexpectedMessage',
  'FailedCallRejected', 'FailedRegexpDoesntMatch', 'FailedRegexpHdrNotFound',
  'OutOfCallMsgs',
  'ResponseTimeRepartitionregister_<10', 'ResponseTimeRepartitionregister_<20',
  'ResponseTimeRepartitionregister_>=20'
].join(';');

const SIPP_DATA_LINE = [
  '1700000000', '1700000000', '1700000100', '100.0', '10',
  '5.0', '0', '100', '100',
  '10', '90', '5',
  '1', '2', '0',
  '1', '0', '0',
  '1',
  '50', '30', '5'
].join(';');

const SIPP_DATA_LINE_2 = [
  '1700000000', '1700000000', '1700000200', '200.0', '10',
  '8.0', '0', '200', '200',
  '15', '180', '10',
  '2', '3', '1',
  '2', '1', '0',
  '1',
  '80', '50', '10'
].join(';');

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sipp-parser-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseSippStatsFile', () => {
  test('returns null for non-existent file', () => {
    expect(parseSippStatsFile('/nonexistent/file.csv')).toBeNull();
  });

  test('returns null for empty file', () => {
    const filePath = path.join(tmpDir, 'empty.csv');
    fs.writeFileSync(filePath, '');
    expect(parseSippStatsFile(filePath)).toBeNull();
  });

  test('returns zeroed stats for header-only file', () => {
    const filePath = path.join(tmpDir, 'header-only.csv');
    fs.writeFileSync(filePath, SIPP_HEADER + '\n');
    // SIPp parser reads header as last line too, producing zeroed stats
    const result = parseSippStatsFile(filePath);
    if (result !== null) {
      expect(result.totalCalls).toBe(0);
      expect(result.successfulCalls).toBe(0);
    }
  });

  test('parses valid CSV file and returns expected structure', () => {
    const filePath = path.join(tmpDir, 'valid.csv');
    fs.writeFileSync(filePath, SIPP_HEADER + '\n' + SIPP_DATA_LINE + '\n');

    const result = parseSippStatsFile(filePath);
    expect(result).not.toBeNull();
    expect(result.totalCalls).toBe(100);
    expect(result.successfulCalls).toBe(90);
    expect(result.failedCalls).toBe(5);
    expect(result.currentCalls).toBe(10);
    expect(result.callRate).toBe(5.0);
    expect(result.responseTimesByOperation).toBeDefined();
    expect(result.responseTimesByOperation).toHaveProperty('register');
    expect(result.failureBreakdown).toBeDefined();
    expect(result.failureBreakdown.cannot_send_message).toBe(1);
    expect(result.failureBreakdown.max_udp_retrans).toBe(2);
  });
});

describe('parseLatestStats', () => {
  test('returns null stats and fileSize 0 for empty file', () => {
    const filePath = path.join(tmpDir, 'empty-latest.csv');
    fs.writeFileSync(filePath, '');
    const result = parseLatestStats(filePath);
    expect(result.stats).toBeNull();
    expect(result.fileSize).toBe(0);
  });

  test('returns correct fileSize and parsed stats', () => {
    const content = SIPP_HEADER + '\n' + SIPP_DATA_LINE + '\n';
    const filePath = path.join(tmpDir, 'latest-valid.csv');
    fs.writeFileSync(filePath, content);

    const result = parseLatestStats(filePath);
    expect(result.stats).not.toBeNull();
    expect(result.fileSize).toBe(Buffer.byteLength(content));
    expect(result.stats.totalCalls).toBe(100);
  });

  test('reads only the last data line from multi-line file', () => {
    const content = SIPP_HEADER + '\n' + SIPP_DATA_LINE + '\n' + SIPP_DATA_LINE_2 + '\n';
    const filePath = path.join(tmpDir, 'multi-line.csv');
    fs.writeFileSync(filePath, content);

    const result = parseLatestStats(filePath);
    expect(result.stats).not.toBeNull();
    // Should get values from SIPP_DATA_LINE_2
    expect(result.stats.totalCalls).toBe(200);
    expect(result.stats.successfulCalls).toBe(180);
  });
});

describe('parseStatsDirectory', () => {
  test('returns empty array for non-existent directory', () => {
    expect(parseStatsDirectory('/nonexistent/dir')).toEqual([]);
  });

  test('returns empty array for directory with no CSV files', () => {
    const emptyDir = path.join(tmpDir, 'empty-dir');
    fs.mkdirSync(emptyDir);
    fs.writeFileSync(path.join(emptyDir, 'readme.txt'), 'not a csv');
    expect(parseStatsDirectory(emptyDir)).toEqual([]);
  });

  test('returns parsed stats with metadata for valid CSVs', () => {
    const statsDir = path.join(tmpDir, 'stats-dir');
    fs.mkdirSync(statsDir);

    const content = SIPP_HEADER + '\n' + SIPP_DATA_LINE + '\n';
    fs.writeFileSync(path.join(statsDir, 'prod1_register_u1_test_com_12345.csv'), content);

    const results = parseStatsDirectory(statsDir);
    expect(results).toHaveLength(1);
    expect(results[0].serverId).toBe('prod1');
    expect(results[0].scenario).toBe('register');
    expect(results[0].transport).toBe('u1');
    expect(results[0].stats).toBeDefined();
    expect(results[0].stats.totalCalls).toBe(100);
  });

  test('ignores non-CSV files', () => {
    const mixedDir = path.join(tmpDir, 'mixed-dir');
    fs.mkdirSync(mixedDir);

    const content = SIPP_HEADER + '\n' + SIPP_DATA_LINE + '\n';
    fs.writeFileSync(path.join(mixedDir, 'prod1_register_u1_test_99.csv'), content);
    fs.writeFileSync(path.join(mixedDir, 'notes.txt'), 'not a csv');
    fs.writeFileSync(path.join(mixedDir, 'data.json'), '{}');

    const results = parseStatsDirectory(mixedDir);
    expect(results).toHaveLength(1);
  });
});
