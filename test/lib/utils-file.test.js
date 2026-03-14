const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;
let originalCwd;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utils-file-test-'));
  originalCwd = process.cwd();
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Require after chdir so file paths resolve correctly
const { addToCsv, addToCsvNumber } = require('../../lib/utils');

describe('addToCsv', () => {
  test('creates directory and file with SEQUENTIAL header', () => {
    const data = {
      displayName: 'John Doe',
      device: 'jdoe-dev1',
      domain: 'testcorp.com',
      'device-sip-registration-password': 'secret123'
    };

    addToCsv(data);

    // Wait for async file operations
    return new Promise((resolve) => {
      setTimeout(() => {
        const filePath = path.join(tmpDir, 'sipp/csv/devices/testcorp.com.csv');
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('SEQUENTIAL');
        expect(content).toContain('jdoe-dev1');
        expect(content).toContain('testcorp.com');
        expect(content).toContain('secret123');
        resolve();
      }, 200);
    });
  });

  test('does not duplicate entries', () => {
    const data = {
      displayName: 'Jane Smith',
      device: 'jsmith-dev1',
      domain: 'dedup.com',
      'device-sip-registration-password': 'pass456'
    };

    addToCsv(data);

    return new Promise((resolve) => {
      setTimeout(() => {
        // Add same device again after first write completes
        addToCsv(data);
        setTimeout(() => {
          const filePath = path.join(tmpDir, 'sipp/csv/devices/dedup.com.csv');
          const content = fs.readFileSync(filePath, 'utf-8');
          // Check for the dedup marker: ;device;domain;
          const matches = content.match(/;jsmith-dev1;dedup\.com;/g);
          expect(matches).toHaveLength(1);
          resolve();
        }, 500);
      }, 500);
    });
  }, 10000);

  test('uses server-specific path when serverId provided', () => {
    const data = {
      displayName: 'Test User',
      device: 'tuser-dev1',
      domain: 'servertest.com',
      'device-sip-registration-password': 'pass789'
    };

    addToCsv(data, 'srv1');

    return new Promise((resolve) => {
      setTimeout(() => {
        const filePath = path.join(tmpDir, 'sipp/csv/servers/srv1/devices/servertest.com.csv');
        expect(fs.existsSync(filePath)).toBe(true);
        resolve();
      }, 200);
    });
  });
});

describe('addToCsvNumber', () => {
  test('creates directory and file with RANDOM header', () => {
    const data = {
      phonenumber: '5551234567',
      domain: 'testcorp.com',
      'dial-rule-description': 'Inbound',
      time_zone: 'US/Eastern'
    };

    addToCsvNumber(data);

    return new Promise((resolve) => {
      setTimeout(() => {
        const filePath = path.join(tmpDir, 'sipp/csv/phonenumbers/US_Eastern.csv');
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('RANDOM');
        expect(content).toContain('5551234567');
        expect(content).toContain('testcorp.com');
        resolve();
      }, 200);
    });
  });

  test('replaces US/ with US_ in timezone for filename', () => {
    const data = {
      phonenumber: '5559876543',
      domain: 'tztest.com',
      'dial-rule-description': 'Inbound',
      time_zone: 'US/Pacific'
    };

    addToCsvNumber(data);

    return new Promise((resolve) => {
      setTimeout(() => {
        const filePath = path.join(tmpDir, 'sipp/csv/phonenumbers/US_Pacific.csv');
        expect(fs.existsSync(filePath)).toBe(true);
        resolve();
      }, 200);
    });
  });

  test('uses server-specific path when serverId provided', () => {
    const data = {
      phonenumber: '5551111111',
      domain: 'srvnum.com',
      'dial-rule-description': 'Inbound',
      time_zone: 'US/Central'
    };

    addToCsvNumber(data, 'srv2');

    return new Promise((resolve) => {
      setTimeout(() => {
        const filePath = path.join(tmpDir, 'sipp/csv/servers/srv2/phonenumbers/US_Central.csv');
        expect(fs.existsSync(filePath)).toBe(true);
        resolve();
      }, 200);
    });
  });
});
