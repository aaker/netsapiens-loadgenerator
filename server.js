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

// Configuration constants
const CONFIG = {
    USER_EXTENSION_START: 1000,
    QUEUE_EXTENSION_START: 4000,
    MAC_ADDRESS_PERCENTAGE: 0.5, // 50% of users get MAC addresses
    RECORDING_PERCENTAGE: 0.25, // 25% get recording (1/4)
    AGENTS_PER_QUEUE_PERCENTAGE: 0.1, // 10% of domain users per queue
    MIN_AGENTS_PER_QUEUE: 3,
    LARGE_DOMAIN_THRESHOLD: 100,
    USERS_PER_SITE: 30,
    QUEUES_PER_USERS_RATIO: 10, // 1 queue per 10 users
    MAX_QUEUES: 8,
    AREA_CODE_MIN: 200,
    AREA_CODE_MAX: 900,
    PHONE_LAST_FOUR_MIN: 1000,
    PHONE_LAST_FOUR_MAX: 9990
};

const SEED = process.env.SEED || 123456;
const APIKEY = process.env.APIKEY //'';
fakerator.seed(SEED);
//random.seed = SEED;
const TARGET_SERVER = process.env.TARGET_SERVER;
const MAX_DOMAIN = process.env.MAX_DOMAIN || 1;
const NDP_SERVERNAME = process.env.NDP_SERVERNAME || "core1";
const RESELLER = process.env.RESELLER || "NetSapiens";
const RECORDING_DIVISER = process.env.RECORDING_DIVISER || 4;


// Input validation
function validateEnvironment() {
    const errors = [];
    
    if (!APIKEY) {
        errors.push("APIKEY is required. Please set the APIKEY environment variable.");
    } else if (!APIKEY.startsWith('nss_')) {
        console.warn("Warning: APIKEY should typically start with 'nss_'");
    }
    
    if (!TARGET_SERVER) {
        errors.push("TARGET_SERVER is required. Please set the TARGET_SERVER environment variable.");
    } else if (!TARGET_SERVER.includes('.')) {
        console.warn("Warning: TARGET_SERVER should be a valid hostname");
    }
    
    if (MAX_DOMAIN < 1 || MAX_DOMAIN > 1000) {
        errors.push("MAX_DOMAIN must be between 1 and 1000");
    }
    
    if (RECORDING_DIVISER < 1) {
        errors.push("RECORDING_DIVISER must be greater than 0");
    }
    
    if (errors.length > 0) {
        console.error("Configuration errors:");
        errors.forEach(error => console.error(`  - ${error}`));
        process.exit(1);
    }
    
    console.log("Environment validation passed");
}

validateEnvironment();

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
        const area_code = Math.floor(area_random * (CONFIG.AREA_CODE_MAX - CONFIG.AREA_CODE_MIN) + CONFIG.AREA_CODE_MIN);
        const last_four = Math.floor(last_four_random * (CONFIG.PHONE_LAST_FOUR_MAX - CONFIG.PHONE_LAST_FOUR_MIN) + CONFIG.PHONE_LAST_FOUR_MIN);
        const number = area_code + "555" + (last_four + i);
        const time_zone = randomdata.timeZones[i % randomdata.timeZones.length];

        let sites = [];
        for (var s = 0; s <= Math.floor(domainSize / CONFIG.USERS_PER_SITE); s++) sites.push(fakerator.address.city());

        console.log("[" + i + "]Creating domain " + domain + " with " + domainSize + " users in " + time_zone + " timezone and area code " + area_code + " and main number " + number);
        try {
            await createDomain({ description, domain, domainSize, area_code, number, time_zone });
            //Domain should be created by now. 
            createNdpUiConfig({domain});
        } catch (error) {
            console.error(`Failed to create domain ${domain}:`, error.message);
            continue; // Skip this domain and move to the next one
        }

        
        // Prepare all user data upfront for better async batching
        const userDataBatch = [];
        const deviceDataBatch = [];
        const macDataBatch = [];
        
        for (let u = 0; u < domainSize; u++) {
            let userArgs = {
                domain: domain,
                user: CONFIG.USER_EXTENSION_START + u,
                "name-first-name": fakerator.names.firstName(),
                "name-last-name": fakerator.names.lastName(),
                "email-address": (CONFIG.USER_EXTENSION_START + u) + "@" + domain + ".com",
                "user-scope": u == 0 ? "Office Manager" : u == 1 ? "Call Center Supervisor": "Basic User",
                site: sites[u % sites.length],
                //use 6 departements if domain size is < 100, otherwise use 12 departments. Randomize start in the list by domain and user index.
                department: randomdata.departmentNames[((u%(domainSize>CONFIG.LARGE_DOMAIN_THRESHOLD?12:6))+i) % randomdata.departmentNames.length],
            }

            let deviceArgs = {
                domain: domain,
                user: CONFIG.USER_EXTENSION_START + u,
                device: CONFIG.USER_EXTENSION_START + u,
                displayName: userArgs["name-first-name"] + " " + userArgs["name-last-name"],
                'device-sip-registration-password': md5((CONFIG.USER_EXTENSION_START + u) + "@" + domain).substring(0, 12), //pysdo random password here. 
            }
            
            if (u % RECORDING_DIVISER == 0) { // 25% of users will use call recording. 
                userArgs['recording-configuration'] = "yes";
            }
            
            let macArgs = {
                domain: domain,
                device1: "sip:" + (CONFIG.USER_EXTENSION_START + u) + "@" + domain,
                'device-provisioning-mac-address': md5("mac" + (CONFIG.USER_EXTENSION_START + u) + "@" + domain).replace(/[^0-9a-fA-F]/g, '').substring(0, 12),
                'model': randomdata.phoneModels[u % randomdata.phoneModels.length],
                'server': NDP_SERVERNAME,
            }

            userDataBatch.push(userArgs);
            deviceDataBatch.push(deviceArgs);
            
            if (u % 10 < (CONFIG.MAC_ADDRESS_PERCENTAGE * 10)) { // 50% of users will have a phone 
                macDataBatch.push(macArgs);
            }
        }
        
        // Process users in smaller batches to avoid overwhelming the API
        const BATCH_SIZE = 10;
        for (let batchStart = 0; batchStart < userDataBatch.length; batchStart += BATCH_SIZE) {
            const userBatch = userDataBatch.slice(batchStart, batchStart + BATCH_SIZE);
            const deviceBatch = deviceDataBatch.slice(batchStart, batchStart + BATCH_SIZE);
            
            // Process user batch with proper error handling
            const userPromises = userBatch.map(async (userArgs) => {
                try {
                    await createUser(userArgs);
                    return { success: true, user: userArgs.user };
                } catch (error) {
                    console.error(`Failed to create user ${userArgs.user} in domain ${domain}:`, error.message);
                    return { success: false, user: userArgs.user, error };
                }
            });
            
            const userResults = await Promise.allSettled(userPromises);
            
            // Process devices (can be async without waiting)
            deviceBatch.forEach(deviceArgs => createDevice(deviceArgs));
            
            // Small delay between batches to be kind to the API
            if (batchStart + BATCH_SIZE < userDataBatch.length) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
        
        // Process MAC addresses asynchronously 
        macDataBatch.forEach(macArgs => createMac(macArgs));

        for (let h = 0; h * CONFIG.QUEUES_PER_USERS_RATIO < domainSize; h++) {
            if (h > CONFIG.MAX_QUEUES) continue;
            const queueName = randomdata.queueNames[(domainSize + h) % randomdata.queueNames.length];
            const queue_index = h;
            let queueArgs = {
                domain: domain,
                callqueue: CONFIG.QUEUE_EXTENSION_START + queue_index,
                description: queueName,
                "callqueue-agent-dispatch-timeout-seconds": 30,
                "callqueue-dispatch-type": "round-robin",
                "callqueue-calculate-statistics": "yes",

            }
            let queueUser = {
                domain: domain,
                user: CONFIG.QUEUE_EXTENSION_START + queue_index,
                "name-first-name": queueName,
                "name-last-name": "Queue",
                "email-address": (CONFIG.QUEUE_EXTENSION_START + queue_index) + "@" + domain + ".com",
                "service-code": "system-queue",
                "user-scope": "No Portal",
                "ring-no-answer-timeout-seconds": 120,
                "callqueue-max-wait-timeout-minutes": 30, // the sipp should exit well before this, but prevents issues if sipp dies. 
                "callqueue-calculate-statistics": "yes",
            }

            let phonenumberArgs = {
                domain: domain,
                "phonenumber": "1" + area_code + "555" + (last_four + queue_index),
                "dial-rule-description": "DID for " + queueName,
                "dial-rule-application": "to-callqueue",
                "dial-rule-translation-destination-user": CONFIG.QUEUE_EXTENSION_START + queue_index,
                "dial-rule-translation-destination-host": domain,
                "phone-number-description": queueName,
                "time_zone": time_zone //just for scheudling calls. 
            }

            try {
                await createQueue(queue_index, queueArgs, () => { }, updateQueue);
                await createUser(queueUser); // user for the queue
                createPhonenumber(phonenumberArgs);
            } catch (error) {
                console.error(`Failed to create queue ${queueArgs.callqueue} in domain ${domain}:`, error.message);
                continue; // Skip this queue and move to the next one
            }

            if (domainSize > CONFIG.LARGE_DOMAIN_THRESHOLD) await new Promise(resolve => setTimeout(resolve, 1000)); //wait 1s between queues for the agents to get into memory without errors.

            for (var a = 0; a < Math.floor(domainSize * CONFIG.AGENTS_PER_QUEUE_PERCENTAGE) + CONFIG.MIN_AGENTS_PER_QUEUE; a++) {   // 10% of domain users will be in each queue
                //get random user between 0 and domainSize
                const random_agent_index = utils.randomIntFromInterval(0, domainSize);

                if (a % 10 == 9 ) //sleep every 10 agents to allow the queue to get into memory.
                    await new Promise(resolve => setTimeout(resolve, 200));
                let agentArgs = {
                    domain: domain,
                    "callqueue-agent-id": (CONFIG.USER_EXTENSION_START + random_agent_index) + "@" + domain,
                    callqueue: CONFIG.QUEUE_EXTENSION_START + queue_index,
                    "callqueue-agent-priority": random_agent_index > domainSize / 2 ? "1" : "2"  // ~50% of agents will have priority 1
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
    await nsapi.apiCreateSync(path, data);
    await new Promise(resolve => setTimeout(resolve, 200)); 

}

async function createNdpUiConfig(args) {
    const path = `configurations` ;
    const data = {
        "reseller": "*",
        "user": "*",
        "user-scope": "*",
        "core-server": "*",
        "config-name": "PORTAL_DEVICE_NDP_SERVER",
        "config-value": NDP_SERVERNAME,
        "domain": args.domain
    }
    nsapi.apiCreate(path, data, () => { }, updateNdpUiConfig);
}

async function updateNdpUiConfig(data) {
    const path = `configurations` ;
    nsapi.apiUpdate(path, data);
}



async function createUser(data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/users';
    await nsapi.apiCreateSync(path, data, () => { }, updateUser);
}

async function createDevice(data) {
    const path = `domains/` + data.domain + '/users/' + data.user + '/devices';
    await nsapi.apiCreate(path, data, utils.addToCsv, updateDevice);
}

async function createMac(data) {
    const path = `domains/` + data.domain + '/phones';
    await nsapi.apiCreate(path, data);
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
    const path = `domains/` + data.domain + '/phonenumbers/' + data.phonenumber;
    nsapi.apiUpdate(path, data);
}

async function createQueue(i, data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/callqueues';
    await nsapi.apiCreateSync(path, data, () => {  }, updateQueue);
}

function updateQueue(data) {
    const path = `domains/` + data.domain + '/callqueues/'+ data.callqueue;
    nsapi.apiUpdate(path, data);
}



async function createAgent(data) {
    await new Promise(resolve => setTimeout(resolve, 3000)); //wait 3 seconds before sending in this API calls to allow the Queue to properly get into memory.
    const path = `domains/` + data.domain + '/callqueues/' + data.callqueue + '/agents';
    try {
        await nsapi.apiCreateSync(path, data);
    } catch (error) {
        console.error(`Failed to create agent ${data['callqueue-agent-id']} for queue ${data.callqueue}:`, error.message);
    }
}







