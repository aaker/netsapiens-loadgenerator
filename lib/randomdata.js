var fs = require('fs');


const timeZones = [
  "US/Pacific",
  "US/Mountain",
  "US/Central",
  "US/Eastern",
  "US/Alaska",
  "US/Hawaii",
  "US/Arizona"
]

const queueNames = [
  "Sales",
  "Support",
  "Billing",
  "Customer Service",
  "Technical Support",
  "General Information",
  "Emergency",
  "Accounting",
  "Human Resources",
  "Legal",
  "Marketing",
  "Public Relations",
  "Quality Assurance",
  "Research and Development",
  "Sales and Marketing",
  "Purchasing",
  "Information Technology",
  "Management",
  "Administration",
  "Operations",
  "Production",
  "Logistics",
  "Shipping",
  "Receiving",
  "Inventory",
  "Warehouse",
  "Maintenance",
  "Engineering",
  "Design",
  "Development",
  "Testing",
];

const phoneModels = [
  "Cisco 8851",
  "Yealink T46S",
  "Polycom VVX400",
  "Grandstream GXP-2170",
  "Snom D785",
  "Fanvil X7C",
  "Linksys spa942",
  "Crexendo CX270",
  "Avaya J169",
  "Polycom VVX600",
  "VTech VSP735",
  "Mitel 6873i",
  "SIP-T54W",
  "Polycom Edge E320"
];

async function buildRandomCallerData() {
  FILE_LOCATION = 'sipp/csv/random_caller_ids.csv';
  const MAX_CALLER_ID = 18;
  if (!fs.existsSync('sipp/csv/')) fs.mkdirSync('sipp/csv/', { recursive: true }); // create directory
  if (!fs.existsSync(FILE_LOCATION)) {
    fs.writeFileSync(FILE_LOCATION, "RANDOM\r\n", (err) => {
      if (err) throw err;
    });
    console.log("File created - " + FILE_LOCATION);
    for (var i = 0; i < 40000; i++) {
      let stringData = "";
      if (i % 5 == 0) {
        stringData = fakerator2.company.name().toUpperCase().substring(0, 18);
      }
      else if (i % 5 == 1) {
        stringData = (fakerator2.names.lastName() + ",  " + fakerator2.names.firstName()).toUpperCase().substring(0, MAX_CALLER_ID);
      }
      else if (i % 5 == 2) {
        stringData = (fakerator2.names.lastName() + ",  " + fakerator2.names.firstName()).toUpperCase().substring(0, MAX_CALLER_ID);
      }
      else if (i % 5 == 2) {
        stringData = fakerator.names.name().substring(0, MAX_CALLER_ID);
      }
      else {
        stringData = (fakerator.address.city()).toUpperCase().substring(0, MAX_CALLER_ID);
      }
      let number = (fakerator.phone.number()).replace(/\./g, '').replace(/-/g, '').replace(/\(/g, '').replace(/\)/g, '').split(" ")[0];
      let maxLoop = 5;
      while (number.length < 5 && maxLoop >0 ) {
        number = (fakerator.phone.number()).replace(/\./g, '').replace(/-/g, '').replace(/\(/g, '').replace(/\)/g, '').split(" ")[0];
        maxLoop--;
      }
      stringData = stringData + ";" + number + ";";
      //console.log(stringData);
      //const stringData = `${data.displayName};${data.device};${data.domain};[authentication username=${data.device} password=${data['device-sip-registration-password']}]`
      fs.appendFile(FILE_LOCATION, stringData + "\r\n", (err) => {
        if (err) throw err;
      });
    }

  }
}


module.exports = {
  timeZones,
  queueNames,
  phoneModels,
  buildRandomCallerData
}


