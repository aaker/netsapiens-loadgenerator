var Fakerator = require("fakerator");
var fs = require('fs');
var md5 = require('md5');
var fakerator = Fakerator("en-US");
var seedrandom = require('seedrandom');
var axios = require('axios');
var dotenv = require('dotenv');

var utils = require('./lib/utils');
var randomdata = require('./lib/randomdata');
var nsapi = require('./lib/nsapi');
const path = require("path");

dotenv.config();

const SEED = process.env.SEED | 0;
const APIKEY = process.env.APIKEY //'';
fakerator.seed(SEED);
//random.seed = SEED;
const TARGET_SERVER = process.env.TARGET_SERVER;
const MAX_DOMAIN = process.env.MAX_DOMAIN || 1;
const NDP_SERVERNAME = process.env.NDP_SERVERNAME || "core1";
const RESELLER = process.env.RESELLER || "NetSapiens";
const RECORDING_DIVISER = process.env.RECORDING_DIVISER || 4;


if (!APIKEY) {
    console.error("APIKEY is required. Please set the APIKEY environment variable.");
    process.exit(1);
}
if (!TARGET_SERVER) {
    console.error("TARGET_SERVER is required. Please set the TARGET_SERVER environment variable.");
    process.exit(1);
}

//function to generate random data for the caller ids.
randomdata.buildRandomCallerData();

async function buildDomains() {

    let domains_list = [];
    for (var i = 0; i < MAX_DOMAIN; i++) { //Preload the domains list to get conistent results.
        domains_list.push(fakerator.company.name());
    }

    for (var i = 0; i < domains_list.length; i++) {
        var description = domains_list[i];
        var domain = description.replace(/\s/g, '_').replace(/,/g, '_').replace(/\./g, '').replace(/\'/g, '_').toLowerCase();
        domain = domain.replace(/-/g, '_').replace(/__/g, '_');

        const domainSize = utils.getDomainSize(domain);

        var area_random = seedrandom(domain + "area_code")();
        var last_four_random = seedrandom(domain + "last_four")();
        const area_code = Math.floor(area_random * (900 - 200) + 200);
        const last_four = Math.floor(last_four_random * (9990 - 1000) + 1000);
        const number = area_code + "555" + (last_four + i);
        const time_zone = randomdata.timeZones[i % randomdata.timeZones.length];

        let sites = [];
        for (var s = 0; s <= Math.floor(domainSize / 30); s++) sites.push(fakerator.address.city());

        console.log("[" + i + "]Creating domain " + domain + " with " + domainSize + " users in " + time_zone + " timezone and area code " + area_code + " and main number " + number);
        await createDomain({ description, domain, domainSize, area_code, number, time_zone });
        //Domain should be created by now. 

        for (let u = 0; u < domainSize; u++) {

            let userArgs = {
                domain: domain,
                user: 1000 + u,
                "name-first-name": fakerator.names.firstName(),
                "name-last-name": fakerator.names.lastName(),
                "email-address": 1000 + u + "@" + domain + ".com",
                "user-scope": u == 0 ? "Office Manager" : "Basic User",
                site: sites[u % sites.length],
            }

            let deviceArgs = {
                domain: domain,
                user: 1000 + u,
                device: 1000 + u,
                displayName: userArgs["name-first-name"] + " " + userArgs["name-last-name"],
                'device-sip-registration-password': md5(1000 + u + "@" + domain).substring(0, 12), //pysdo random password here. 
            }
            if (u % RECORDING_DIVISER == 0) { // 25% of users will use call recording. 
                userArgs['recording-configuration'] = "yes";
            }
            let macArgs = {
                domain: domain,
                device1: "sip:" + (1000 + u) + "@" + domain,
                'device-provisioning-mac-address': md5("mac" + 1000 + u + "@" + domain).replace(/[^0-9a-fA-F]/g, '').substring(0, 12),
                'model': randomdata.phoneModels[u % randomdata.phoneModels.length],
                'server': NDP_SERVERNAME,
            }

            await createUser(userArgs);
            createDevice(deviceArgs); // Not waiting for this to complete

            if (u % 10 < 5) { // 50% of users will have a phone 
                createMac(macArgs);
            }

        }

        for (let h = 0; h * 10 < domainSize; h++) {
            if (h > 8) continue;
            const queueName = randomdata.queueNames[(domainSize + h) % randomdata.queueNames.length];
            const queue_index = h;
            let queueArgs = {
                domain: domain,
                callqueue: 4000 + queue_index,
                description: queueName,
                "callqueue-agent-dispatch-timeout-seconds": 30,
                "callqueue-dispatch-type": "round-robin"
            }
            let queueUser = {
                domain: domain,
                user: 4000 + queue_index,
                "name-first-name": queueName,
                "name-last-name": "Queue",
                "email-address": 4000 + queue_index + "@" + domain + ".com",
                "service-code": "system-queue",
                "user-scope": "No Portal",
                "ring-no-answer-timeout-seconds": 120,
                "callqueue-max-wait-timeout-minutes": 30, // the sipp should exit well before this, but prevents issues if sipp dies. 

            }

            let phonenumberArgs = {
                domain: domain,
                "phonenumber": "1" + area_code + "555" + (last_four + queue_index),
                "dial-rule-description": "DID for " + queueName,
                "dial-rule-application": "to-callqueue",
                "dial-rule-translation-destination-user": 4000 + queue_index,
                "dial-rule-translation-destination-host": domain,
                "phone-number-description": queueName,
                "time_zone": time_zone //just for scheudling calls. 
            }

            await createQueue(queue_index, queueArgs);
            await createUser(queueUser); // user for the queue
            createPhonenumber(phonenumberArgs);

            for (var a = 0; a < Math.floor(domainSize * .1) + 3; a++) {   // 10% of domain users will be in each queue
                //get random user between 0 and domainSize
                const random_agent_index = utils.randomIntFromInterval(0, domainSize);

                let agentArgs = {
                    domain: domain,
                    "callqueue-agent-id": (1000 + random_agent_index) + "@" + domain,
                    callqueue: 4000 + queue_index,
                    "callqueue-agent-priority": random_agent_index > domain / 2 ? "1" : "2"  // ~50% of agents will have priority 1
                }

                createAgent(JSON.parse(JSON.stringify(agentArgs))); // Not waiting for this to complete
            }






        }




    }
}

randomdata.buildRandomCallerData();
buildDomains();







async function createDomain(args) {
    //Add some default values to the data object to make sure we have all the required fields.
    const data = {
        synchronous: 'yes',
        domain: args.domain,
        description: args.description,
        'recording-configuration': 'no',
        'language-token': 'en_US',
        reseller: RESELLER,
        'caller-id-name': args.description.substring(0, 15),
        'area-code': args.area_code,
        'caller-id-number': args.number,
        'caller-id-number-emergency': args.number,
        'time-zone': args['time-zone'],
        'voicemail-enabled': 'yes',
        'domain-type': 'Standard',
        'dial-policy': 'US and Canada',
    }
    const path = `domains`;
    nsapi.apiCreateSync(path, data);

}

async function createUser(data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/users';
    nsapi.apiCreateSync(path, data, () => { }, updateUser);
}

async function createDevice(data) {
    const path = `domains/` + data.domain + '/users/' + data.user + '/devices';
    nsapi.apiCreate(path, data, utils.addToCsv, updateDevice);
}

async function createMac(data) {
    path = `domains/` + data.domain + '/phones';
    nsapi.apiCreate(path, data);
}

async function updateUser(data) {
    const path = `domains/` + data.domain + '/users/' + data.user;
    nsapi.apiUpdate(path, data);
}

async function updateDevice(data) {
    const path = `domains/` + data.domain + '/users/' + data.user + '/devices/' + data.device;
    nsapi.apiUpdate(path, data);
}

async function createPhonenumber(data) {
    const path = `domains/` + data.domain + '/phonenumbers';
    nsapi.apiCreate(path, data, utils.addToCsvNumber, updatePhonenumber);
}

async function updatePhonenumber(data) {
    console.log(data);
    const path = `domains/` + data.domain + '/phonenumbers/' + data.phonenumber;
    nsapi.apiUpdate(path, data);
}

async function createQueue(i, data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/callqueues';
    nsapi.apiCreateSync(path, data);
}

async function createAgent(data) {
    await new Promise(resolve => setTimeout(resolve, 3000)); //wait 3 seconds before sending in this API calls to allow the Queue to properly get into memory.
    const path = `domains/` + data.domain + '/callqueues/' + data.callqueue + '/agents';
    nsapi.apiCreate(path, data);
}







