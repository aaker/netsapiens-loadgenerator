var fs = require('fs');
var seedrandom = require('seedrandom');

function randomIntFromInterval(min, max) { // min and max included 
  return Math.floor(Math.random() * (max - min + 1) + min);
}

function addToCsvNumber(data) {
  if (!fs.existsSync('sipp/csv/phonenumbers/')) fs.mkdirSync('sipp/csv/phonenumbers/', { recursive: true }); // create directory
  const time_zone = data.time_zone.replace("US/", "US_");
  const FILE_LOCATION = 'sipp/csv/phonenumbers/' + time_zone + ".csv";
  if (!fs.existsSync(FILE_LOCATION)) {
    fs.writeFileSync(FILE_LOCATION, "RANDOM\r\n", (err) => {
      if (err) throw err;
    });
  }
  const stringData = `${data.phonenumber};${data.domain};${data['dial-rule-description']}`
  fs.readFile(FILE_LOCATION, function (err, filedata) {
    if (err) throw err;
    if (!filedata.includes(stringData)) {
      fs.appendFile(FILE_LOCATION, stringData + "\r\n", (err) => {
        if (err) throw err;
        //console.log('The data was appended to file!');
      });
    }
  });
}

function addToCsv(data) {
  const FILE_LOCATION = 'sipp/csv/devices/' + data.domain + ".csv";
  if (!fs.existsSync('sipp/csv/devices/')) fs.mkdirSync('sipp/csv/devices/', { recursive: true }); // create directory
  if (!fs.existsSync(FILE_LOCATION)) {
    fs.writeFileSync(FILE_LOCATION, "SEQUENTIAL\r\n", (err) => {
      if (err) throw err;

    });
  }
  const stringData = `${data.displayName};${data.device};${data.domain};[authentication username=${data.device} password=${data['device-sip-registration-password']}]`
  fs.readFile(FILE_LOCATION, function (err, filedata) {
    if (err) throw err;
    if (!filedata.includes(`;${data.device};${data.domain};`)) {
      fs.appendFile(FILE_LOCATION, stringData + "\r\n", (err) => {
        if (err) throw err;
        //console.log('The data was appended to file!');
      });
    }
  });
}

function toHex(str) {
  var result = '';
  for (var i = 0; i < str.length; i++) {
    result += str.charCodeAt(i).toString(16);
  }

  return result.replace(/\D/g, '');
}

function getDomainSize(domain) {
  const isSuperLargeDomaion = toHex(domain) % 101 >= 99;
  const isLargeDomaion = toHex(domain) % 101 >= 90;
  var rng = seedrandom(domain);
  var pysdoRandomVal = rng();

  var domainSize;
  if (isSuperLargeDomaion)
    domainSize = Math.floor(pysdoRandomVal * (2500 - 800) + 800);
  else if (isLargeDomaion)
    domainSize = Math.floor(pysdoRandomVal * (250 - 80) + 80)
  else
    domainSize = Math.floor(pysdoRandomVal * (50 - 5) + 5);
  return domainSize;
}


module.exports = {
  randomIntFromInterval,
  addToCsvNumber,
  addToCsv,
  toHex,
  getDomainSize
}

