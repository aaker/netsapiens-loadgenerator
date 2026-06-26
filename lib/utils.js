var fs = require('fs');
var seedrandom = require('seedrandom');

function randomIntFromInterval(min, max) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min);
}

/**
 * Add phone number to CSV file
 * @param {Object} data - Phone number data
 * @param {string} serverId - Optional server ID for multi-server mode (default: uses legacy path)
 */
function addToCsvNumber(data, serverId = null) {
  // Determine the base path based on whether serverId is provided
  const basePath = serverId ? `sipp/csv/servers/${serverId}/phonenumbers/` : 'sipp/csv/phonenumbers/';

  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true }); // create directory
  }

  const time_zone = data.time_zone.replace("US/", "US_");
  const FILE_LOCATION = basePath + time_zone + ".csv";

  if (!fs.existsSync(FILE_LOCATION)) {
    fs.writeFileSync(FILE_LOCATION, "RANDOM\r\n");
  }

  // Sync read+append is intentional: concurrent async callbacks for the same file
  // would all pass the duplicate check before any write landed (TOCTOU race).
  // Sync ops run atomically within the Node.js event loop tick.
  const stringData = `${data.phonenumber};${data.domain};${data['dial-rule-description']}`;
  const filedata = fs.readFileSync(FILE_LOCATION);
  if (!filedata.includes(stringData)) {
    fs.appendFileSync(FILE_LOCATION, stringData + "\r\n");
  }
}

/**
 * Add device to CSV file
 * @param {Object} data - Device data
 * @param {string} serverId - Optional server ID for multi-server mode (default: uses legacy path)
 */
function addToCsv(data, serverId = null) {
  // Determine the base path based on whether serverId is provided
  const basePath = serverId ? `sipp/csv/servers/${serverId}/devices/` : 'sipp/csv/devices/';

  if (!fs.existsSync(basePath)) {
    fs.mkdirSync(basePath, { recursive: true }); // create directory
  }

  const FILE_LOCATION = basePath + data.domain + ".csv";

  if (!fs.existsSync(FILE_LOCATION)) {
    fs.writeFileSync(FILE_LOCATION, "SEQUENTIAL\r\n");
  }

  // Sync read+append is intentional: concurrent async callbacks for the same file
  // would all pass the duplicate check before any write landed (TOCTOU race).
  // Sync ops run atomically within the Node.js event loop tick.
  const stringData = `${data.displayName};${data.device};${data.domain};[authentication username=${data.device} password=${data['device-sip-registration-password']}]`;
  const filedata = fs.readFileSync(FILE_LOCATION);
  if (!filedata.includes(`;${data.device};${data.domain};`)) {
    fs.appendFileSync(FILE_LOCATION, stringData + "\r\n");
  }
}

function toHex(str) {
  var result = '';
  for (var i = 0; i < str.length; i++) {
    result += str.charCodeAt(i).toString(16);
  }

  return result.replace(/\D/g, '');
}

function getDomainSize(domain,i,domain_hardlimit_size = null) {
  const isSuperLargeDomaion = toHex(domain) % 101 >= 99;
  const isLargeDomaion = toHex(domain) % 101 >= 90;
  var rng = seedrandom(domain);
  var pysdoRandomVal = rng();

  var domainSize;
  if (domain_hardlimit_size) {
    domainSize = Math.floor(pysdoRandomVal * (domain_hardlimit_size - 8) + 8);
  } else if (i === 1000)
    domainSize = 10000; //special case for testing larger domains
  else if (isSuperLargeDomaion)
    domainSize = Math.floor(pysdoRandomVal * (2500 - 800) + 800);
  else if (isLargeDomaion)
    domainSize = Math.floor(pysdoRandomVal * (250 - 80) + 80)
  else
    domainSize = Math.floor(pysdoRandomVal * (50 - 5) + 5);


  if (domainSize > 10 && i != 1000 && i > 500)
    domainSize = Math.floor(domainSize / 4); //reduce size for later entries to avoid huge load

  return domainSize;
}


module.exports = {
  randomIntFromInterval,
  addToCsvNumber,
  addToCsv,
  toHex,
  getDomainSize
}

