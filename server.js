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
const { loadConfig } = require('./lib/config');
const path = require("path");
const { timeStamp } = require("console");

// Load random domains from file
const randomDomainsFile = fs.readFileSync(path.join(__dirname, 'lib/fake_company_names.txt'), 'utf8');
const randomDomains = randomDomainsFile.split('\n').filter(line => line.trim() !== '');
const randomResellersFile = fs.readFileSync(path.join(__dirname, 'lib/fake_resellers.txt'), 'utf8');
const randomResellers = randomResellersFile.split('\n').filter(line => line.trim() !== '');

// Pool of realistic SIP User-Agent strings, assigned per-device into the device CSV.
const userAgents = randomdata.loadUserAgents();

dotenv.config();

// Load multi-server or single-server configuration
let appConfig;
let selectedServer;
let apiClient;

try {
    appConfig = loadConfig();
    selectedServer = appConfig.selectedServer;

    // Create API client for the selected server
    apiClient = new nsapi.ServerApiClient(selectedServer);

    console.log(`\n======================================`);
    console.log(`Configuration Mode: ${appConfig.mode}`);
    console.log(`Target Server: ${selectedServer.hostname}`);
    console.log(`Server ID: ${selectedServer.id}`);
    console.log(`Max Domains: ${selectedServer.maxDomains}`);
    console.log(`Max Resellers: ${selectedServer.maxResellers}`);
    console.log(`Peak CPS: ${selectedServer.peakCps}`);
    console.log(`Registration %: ${selectedServer.registrationPct}`);
    console.log(`SEED: ${selectedServer.seed}`);
    console.log(`======================================\n`);
    if (!selectedServer.maxResellers)
        throw new Error('maxResellers must be defined and greater than 0 in server configuration');
} catch (error) {
    console.error(`Failed to load configuration: ${error.message}`);
    process.exit(1);
}

// Configuration constants
const CONFIG = {
    USER_EXTENSION_START: 1000,
    QUEUE_EXTENSION_START: 4000,
    MAC_ADDRESS_PERCENTAGE: 0.5, // 50% of users get MAC addresses
    RECORDING_PERCENTAGE: 0.25, // 25% get recording (1/4)
    TRANSCODE_OPUS_PERCENTAGE: 1, // 20% of devices get transcode-opus=yes
    AGENTS_PER_QUEUE_PERCENTAGE: 0.15, // 10% of domain users per queue
    MIN_AGENTS_PER_QUEUE: 6,
    LARGE_DOMAIN_THRESHOLD: 100,
    USERS_PER_SITE: 30,
    QUEUES_PER_USERS_RATIO: 10, // 1 queue per 10 users
    MIN_QUEUES: 2,
    MAX_QUEUES: 12,
    AREA_CODE_MIN: 200,
    AREA_CODE_MAX: 900,
    PHONE_LAST_FOUR_MIN: 1000,
    PHONE_LAST_FOUR_MAX: 9990,
    // Performance tuning
    MAX_CONCURRENT_DOMAINS: parseInt(process.env.MAX_CONCURRENT_DOMAINS) || 3, // Process multiple domains in parallel
    USER_BATCH_SIZE: 25, // Increased from 15
    DEVICE_BATCH_SIZE: 25, // Larger batches for devices
    REDUCE_DELAYS: false, // Feature flag to reduce/eliminate delays
    AGENT_DELAY_MS: 500, // Reduced from 3000ms
    BATCH_DELAY_MS: 100, // Reduced from 200ms
    DEVICE_DELAY_MS: 25, // Reduced from 100ms
    AVATAR_MAX_CONCURRENT: parseInt(process.env.AVATAR_MAX_CONCURRENT) || 3, // Max concurrent avatar uploads
    EVEN_RESELLER_DISTRIBUTION: selectedServer.evenResellerDistribution == undefined ? process.env.EVEN_RESELLER_DISTRIBUTION === '1' : selectedServer.evenResellerDistribution, // If set, distribute domains evenly across resellers
    DOMAIN_SIZE_HARD_LIMIT: selectedServer.domainSizeHardLimit || null // Optional hard limit for domain size
};

// Use server-specific configuration values
const SEED = selectedServer.seed;
const APIKEY = selectedServer.apikey;
fakerator.seed(SEED);
const TARGET_SERVER = selectedServer.hostname;
const MAX_DOMAIN = selectedServer.maxDomains;
const MAX_RESELLERS = selectedServer.maxResellers;
const NDP_SERVERNAME = process.env.NDP_SERVERNAME || "core1";
const RESELLER = process.env.RESELLER || "NetSapiens";
const RECORDING_DIVISER = process.env.RECORDING_DIVISER || 4;
// Domain (scope) the inbound-carrier connection is created under.
const CARRIER_CONNECTION_DOMAIN = process.env.CARRIER_CONNECTION_DOMAIN || "*";
const domain_hardlimit_size = CONFIG.DOMAIN_SIZE_HARD_LIMIT;

// Whether a 409 (duplicate) response triggers an update (PUT). Defaults to yes
// when MAX_DOMAIN <= 1000, no above that to avoid hammering large deployments.
// Override per object type with env vars (1=yes, 0=no).
const _updateDefault = MAX_DOMAIN <= 1000;
const UPDATE_ON_409 = {
    resellers:    process.env.UPDATE_RESELLERS    !== undefined ? process.env.UPDATE_RESELLERS    === '1' : _updateDefault,
    domains:      process.env.UPDATE_DOMAINS      !== undefined ? process.env.UPDATE_DOMAINS      === '1' : _updateDefault,
    users:        process.env.UPDATE_USERS        !== undefined ? process.env.UPDATE_USERS        === '1' : _updateDefault,
    devices:      process.env.UPDATE_DEVICES      !== undefined ? process.env.UPDATE_DEVICES      === '1' : _updateDefault,
    phonenumbers: process.env.UPDATE_PHONENUMBERS !== undefined ? process.env.UPDATE_PHONENUMBERS === '1' : _updateDefault,
    queues:       process.env.UPDATE_QUEUES       !== undefined ? process.env.UPDATE_QUEUES       === '1' : _updateDefault,
    mac:          process.env.UPDATE_MAC          !== undefined ? process.env.UPDATE_MAC          === '1' : _updateDefault
};

// Input validation
function validateEnvironment() {
    const errors = [];

    // Configuration is now validated in config.js, but do additional checks here
    if (!APIKEY) {
        errors.push("APIKEY is required in server configuration");
    } else if (!APIKEY.startsWith('nss_')) {
        console.warn("Warning: APIKEY should typically start with 'nss_'");
    }

    if (!TARGET_SERVER) {
        errors.push("TARGET_SERVER is required in server configuration");
    } else if (!TARGET_SERVER.includes('.')) {
        console.warn("Warning: TARGET_SERVER should be a valid hostname");
    }

    if (MAX_DOMAIN < 1 || MAX_DOMAIN > 10000) {
        errors.push("MAX_DOMAIN must be between 1 and 10000");
    }

    if (RECORDING_DIVISER < 1) {
        errors.push("RECORDING_DIVISER must be greater than 0");
    }

    if (errors.length > 0) {
        console.error("Configuration errors:");
        errors.forEach(error => console.error(`  - ${error}`));
        process.exit(1);
    }

    console.log("Server configuration validation passed");
}

validateEnvironment();

//function to generate random data for the caller ids.
randomdata.buildRandomCallerData();
let resellers_list = [];
let resellers_list_descriptions = [];
async function buildDomains() {
    console.log(`Starting to build ${MAX_DOMAIN} domains with ${CONFIG.MAX_CONCURRENT_DOMAINS} concurrent processes...`);
    const startTime = Date.now();

    let domains_list = [];


    for (var i = 0; i < MAX_DOMAIN; i++) { //Preload the domains list to get consistent results.
        if (i<500)
            domains_list.push(fakerator.company.name());
        else if (i<700)
            domains_list.push(fakerator.address.city() + " " +fakerator.address.streetSuffix());
        else if (i<900)
            domains_list.push(fakerator.address.city() + " " +fakerator.address.state() + " " +fakerator.address.streetSuffix());
        else
        {
            // Use seeded random to select from randomDomains file (repeatable based on SEED and index)
            var domainRng = seedrandom(SEED + "domain" + i);
            var domainIndex = Math.floor(domainRng() * randomDomains.length);
            domains_list.push(randomDomains[domainIndex]);
        }         
    } 

    for (var i = 0; i < MAX_RESELLERS; i++) {
        // Use seeded random to select from randomResellers file (repeatable based on SEED and index)
        var resellerRng = seedrandom(SEED + "reseller" + i);
        var resellerIndex = Math.floor(resellerRng() * randomResellers.length);
        const cleanedresller = randomResellers[resellerIndex].replace(/\s/g, '_').replace(/,/g, '_').replace(/\'/g, '_').toLowerCase();
        resellers_list.push(cleanedresller);
        resellers_list_descriptions.push(randomResellers[resellerIndex]);
    }
    
    
    // Process domains in parallel batches
    const domainBatches = [];
    for (let i = 0; i < domains_list.length; i += CONFIG.MAX_CONCURRENT_DOMAINS) {
        domainBatches.push(domains_list.slice(i, i + CONFIG.MAX_CONCURRENT_DOMAINS));
    }

    console.log(`Validating and/or creating ${resellers_list.length} resellers...`);
    for (let i = 0; i < resellers_list.length; i++) {
        await createReseller({
            reseller: resellers_list[i],
            description: resellers_list_descriptions[i],
        });
    }

    // Inbound carrier connection: routes sip*@inbound-carrier traffic into the
    // "Inbound DID" dial plan with "Permit All" permission, IP checking disabled.
    await createConnection();


    for (let batchIndex = 0; batchIndex < domainBatches.length; batchIndex++) {
        const batch = domainBatches[batchIndex];
        const batchStartTime = Date.now();
        
        console.log(`Processing batch ${batchIndex + 1}/${domainBatches.length} with ${batch.length} domains...`);
        
        // Process all domains in this batch concurrently
        const domainPromises = batch.map((description, batchItemIndex) => {
            const globalIndex = batchIndex * CONFIG.MAX_CONCURRENT_DOMAINS + batchItemIndex;
            return processSingleDomain(description, globalIndex);
        });
        
        await Promise.allSettled(domainPromises);
        
        const batchTime = ((Date.now() - batchStartTime) / 1000).toFixed(2);
        console.log(`Batch ${batchIndex + 1} completed in ${batchTime}s`);
        
        // Small delay between batches to prevent API overload
        if (batchIndex < domainBatches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
        }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`All ${MAX_DOMAIN} domains completed in ${totalTime}s`);
    if (avatarConcurrency.current > 0) {
        console.log(`Waiting for ${avatarConcurrency.current} avatar uploads to complete, queued at max of ${avatarConcurrency.max} simultaneous uploads...`);
    }    
}

async function processSingleDomain(description, i) {
    try {
        var domain = description.replace(/\s/g, '_').replace(/,/g, '_').replace(/\./g, '').replace(/\'/g, '_').toLowerCase();
        domain = domain.replace(/-/g, '_').replace(/&/g, '_').replace(/___/g, '_').replace(/__/g, '_');

        //replace an non asci characters like É with their ascii equivalent
        domain = domain.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        const domainSize = utils.getDomainSize(domain, i, domain_hardlimit_size);

        const resi = domainSize > 9000;
        if (resi) description = "Residential - " + description;

        var area_random = seedrandom(domain + "area_code")();
        var last_four_random = seedrandom(domain + "last_four")();
        const area_code = Math.floor(area_random * (CONFIG.AREA_CODE_MAX - CONFIG.AREA_CODE_MIN) + CONFIG.AREA_CODE_MIN);
        const last_four = Math.floor(last_four_random * (CONFIG.PHONE_LAST_FOUR_MAX - CONFIG.PHONE_LAST_FOUR_MIN) + CONFIG.PHONE_LAST_FOUR_MIN);
        const number = area_code + "555" + (last_four + i);
        const time_zone = randomdata.timeZones[i % randomdata.timeZones.length];

        let sites = [];
        for (var s = 0; s <= Math.floor(domainSize / CONFIG.USERS_PER_SITE); s++) sites.push(fakerator.address.city());

        
        //we need some random logic for picking reseller for a domain. I would like to have 1 reseller that gets about 30% of the domains, then one getting about 15%, then the reset are random. 
        let reseller;
        if (CONFIG.EVEN_RESELLER_DISTRIBUTION) {
            reseller = resellers_list[i % resellers_list.length];
        } else if (i % 10 < 3)
            reseller = resellers_list[0];
        else if (i % 10 == 3 || i % 10 == 4)
            reseller = resellers_list[1];
        else 
        {
            var reseller_random = seedrandom(SEED + i +"reseller")();
            reseller = resellers_list[Math.floor(reseller_random * resellers_list.length-2)+2]; //skip first two resellers for random selection.
        }

        console.log("[" + i + "]Creating domain " + domain + " reseller is " + reseller + " with " + domainSize + " users in " + time_zone + " timezone and area code " + area_code + " and main number " + number);
        
            

        const domainParams = {reseller,description, domain, domainSize, area_code, number, time_zone,"domain-type": resi ? "Residential" : "Standard" };
        await createDomain(domainParams);
        //Domain should be created by now. 
        createNdpUiConfig({domain});

        
        // Prepare all user data upfront for better async batching
        const userDataBatch = [];
        const deviceDataBatch = [];
        const macDataBatch = [];
        const avatarBatch = [];

        const avatarFilenames = []; 
        const avatarDir = path.join(__dirname, 'avatar');
        fs.readdirSync(avatarDir).forEach(file => {
            if (file.toLocaleLowerCase().endsWith('.png') || file.toLocaleLowerCase().endsWith('.jpg')  ) {
                avatarFilenames.push(path.join(avatarDir, file));
            }
        });
        const avatarCount = avatarFilenames.length;

        const authKey = md5(SEED + domain + CONFIG.USER_EXTENSION_START + "@" + domain).substring(0, 13); //pysdo generate a random password here
        const macAuthKey = md5(SEED + domain + "mac" + CONFIG.USER_EXTENSION_START + "@" + domain).substring(0, 6); //pysdo generate a random password here
        
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
                'simultaneous_ring': 'yes',
                'forward': 'yes',


            }

            let deviceArgs = {
                domain: domain,
                user: CONFIG.USER_EXTENSION_START + u,
                device: CONFIG.USER_EXTENSION_START + u,
                displayName: userArgs["name-first-name"] + " " + userArgs["name-last-name"],
                'device-sip-registration-password': authKey, //pysdo random password here. 
            }
            
            if (u % RECORDING_DIVISER == 0) { // 25% of users will use call recording.
                userArgs['recording-configuration'] = "yes";
            }

            deviceArgs['device-transcode-opus'] = (seedrandom(SEED + domain + u + "opus")() < CONFIG.TRANSCODE_OPUS_PERCENTAGE) ? "yes" : "no";
            deviceArgs['device-sip-nat-traversal'] = 'automatic';

            // Assign a User-Agent from the pool (seeded for reproducibility) to write into the device CSV.
            deviceArgs.userAgent = userAgents[Math.floor(seedrandom(SEED + domain + u + "ua")() * userAgents.length)];
            
            let macArgs = {
                domain: domain,
                device1: "sip:" + (CONFIG.USER_EXTENSION_START + u) + "@" + domain,
                'device-provisioning-mac-address': md5("mac" + (CONFIG.USER_EXTENSION_START + u) + "@" + domain).replace(/[^0-9a-fA-F]/g, '').substring(0, 12),
                'model': randomdata.phoneModels[u % randomdata.phoneModels.length],
                'server': NDP_SERVERNAME,
                'device-provisioning-username': "user", //pysdo random password here.
                'device-provisioning-password': macAuthKey //pysdo random password here.
                
            }

            if (domain.startsWith("a") || domain.startsWith("b") || MAX_DOMAIN < 301)
            {
                let avatarArgs = {
                domain: domain,
                user: CONFIG.USER_EXTENSION_START + u,
                filePath: avatarFilenames[(i + u) % avatarCount] //random start using domain index and then each
                }

                avatarBatch.push(avatarArgs);
            }
            
            userDataBatch.push(userArgs);
            deviceDataBatch.push(deviceArgs);
            
            if (u % 10 < (CONFIG.MAC_ADDRESS_PERCENTAGE * 10)) { // 50% of users will have a phone 
                macDataBatch.push(macArgs);
            }
        }
        
        // Process users in optimized batches
        const BATCH_SIZE = CONFIG.USER_BATCH_SIZE;
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
            
            // Only create devices for successfully created users
            if (!CONFIG.REDUCE_DELAYS) {
                await new Promise(resolve => setTimeout(resolve, 250)); // Reduced wait time
            }
            
            const successfulUsers = userResults
                .map((result, index) => ({ result: result.value, device: deviceBatch[index] }))
                .filter(item => item.result && item.result.success)
                .map(item => item.device);
                
            // Process devices in larger batches for better performance
            const deviceBatchSize = Math.min(CONFIG.DEVICE_BATCH_SIZE, successfulUsers.length);
            for (let i = 0; i < successfulUsers.length; i += deviceBatchSize) {
                const deviceSubBatch = successfulUsers.slice(i, i + deviceBatchSize);
                
                // Create all devices in this sub-batch concurrently
                await Promise.all(deviceSubBatch.map(deviceArgs => createDevice(deviceArgs)));
                
                // Smaller delay between device batches
                if (i + deviceBatchSize < successfulUsers.length && !CONFIG.REDUCE_DELAYS) {
                    await new Promise(resolve => setTimeout(resolve, CONFIG.DEVICE_DELAY_MS));
                }
            }
            
            // Reduced delay between batches
            if (batchStart + BATCH_SIZE < userDataBatch.length && !CONFIG.REDUCE_DELAYS) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
            }
        }
        
        // Process MAC addresses asynchronously 
        macDataBatch.forEach(macArgs => createMac(macArgs));
        avatarBatch.forEach(avatarArgs => updateAvatar(avatarArgs));
      
        if (!resi)
        {
            for (let h = 0; h * CONFIG.QUEUES_PER_USERS_RATIO < domainSize || h < CONFIG.MIN_QUEUES; h++) {
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

                // Reduced wait time for large domains
                if (domainSize > CONFIG.LARGE_DOMAIN_THRESHOLD && !CONFIG.REDUCE_DELAYS) {
                    await new Promise(resolve => setTimeout(resolve, 250)); // Reduced from 1000ms
                }

                for (var a = 0; a < Math.floor(domainSize * CONFIG.AGENTS_PER_QUEUE_PERCENTAGE) + CONFIG.MIN_AGENTS_PER_QUEUE; a++) {   // 10% of domain users will be in each queue
                    //get random user between 0 and domainSize
                    if (i> 500 && a >35) continue; //limit agents for large domains to prevent overload.

                    const random_agent_index = utils.randomIntFromInterval(0, domainSize);

                    // Reduced agent processing delay
                    if (a % 20 == 19 && !CONFIG.REDUCE_DELAYS) { // Less frequent delays
                        await new Promise(resolve => setTimeout(resolve, 100)); // Reduced from 200ms
                    }
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
        else
        {
            console.log("Skipping queue creation for residential domain " + domain);
        }
        
        
        console.log(`[${i}] Domain ${domain} completed successfully`);
        
    } catch (error) {
        console.error(`[${i}] Failed to process domain ${description}:`, error.message);
        // Continue processing - don't let one domain failure stop others
    }
}

randomdata.buildRandomCallerData();
buildDomains()
    .then(() => waitForAvatarUploads())
    .then(() => {
        console.log("All work complete.");
    })
    .catch((error) => {
        console.error("Fatal error during domain generation:", error.message);
        process.exitCode = 1;
    });

// Resolves once no avatar uploads are active or queued, so the process can
// exit naturally when the event loop drains.
function waitForAvatarUploads() {
    return new Promise((resolve) => {
        const check = setInterval(() => {
            if (avatarConcurrency.current === 0 && avatarConcurrency.queue.length === 0) {
                clearInterval(check);
                resolve();
            }
        }, 500);
    });
}



async function createReseller(data) {
    const path = `resellers`;
    await apiClient.apiCreateSync(path, data,
        () => { console.log("Created reseller " + data.reseller + " with description " + data.description); },
        UPDATE_ON_409.resellers ? updateReseller : () => {}
    );
}

function updateReseller(data) {
    const path = `resellers/` + data.reseller;
    apiClient.apiUpdate(path, data);
}

// Creates the inbound-carrier connection (not domain-scoped endpoint).
// Inbound traffic matching sip*@inbound-carrier is routed to the "Inbound DID"
// dial plan with the "Permit All" dial policy. Source IP checking is disabled
// so calls are accepted regardless of originating IP.
async function createConnection() {
    const data = {
        synchronous: 'yes',
        domain: CARRIER_CONNECTION_DOMAIN,
        'connection-orig-match-pattern': 'sip*@inbound-carrier',
        'connection-term-match-pattern': 'sip*@inbound-carrier',
        'dial-plan': 'Inbound DID',
        'dial-policy': 'Permit All',
        'connection-source-ip-checking-enabled': 'no',
        'connection-orig-enabled': 'yes',
        'connection-term-enabled': 'no',
    };

    const path = `connections`;
    await apiClient.apiCreateSync(path, data,
        () => { console.log("Created inbound-carrier connection (sip*@inbound-carrier -> Inbound DID / Permit All, IP checking off)"); },
        () => { console.log("Inbound-carrier connection already exists"); }
    );
}



async function createDomain(args) {
    //Add some default values to the data object to make sure we have all the required fields.
    const data = {
        synchronous: 'yes',
        domain: args.domain,
        description: args.description,
        'recording-configuration': 'no',
        'language-token': 'en_US',
        reseller: args.reseller,
        'caller-id-name': args.description.substring(0, 15),
        'area-code': args.area_code,
        'caller-id-number': args.number,
        'caller-id-number-emergency': args.number,
        'time-zone': args['time-zone'],
        'voicemail-enabled': 'yes',
        'domain-type': args['domain-type'],
        'dial-policy': 'US and Canada',
    }

    const path = `domains`;
    await apiClient.apiCreateSync(path, data, () => { }, UPDATE_ON_409.domains ? updateDomain : () => {});
    await new Promise(resolve => setTimeout(resolve, 200));

}

function updateDomain(data) {
    const path = `domains/` + data.domain;
    apiClient.apiUpdate(path, data);    
    addDialRuleChaintoDefaultDialPlan(data);


}

async function addDialRuleChaintoDefaultDialPlan(args) {
    const path = `domains/` + args.domain + `/dialplans/` + args.domain + `/dialrules`;
    const data = {
        "dial-rule-matching-to-uri": "*",
        "dial-rule-matching-from-uri": "*",
        "dial-rule-translation-source-name": "[*]",
        "dial-rule-translation-source-user": "[*]",
        "dial-rule-translation-source-host": "[*]",
        "dial-rule-description": "Chain to "+ args.domain + " dial plan",
        "dial-rule-application": "<Cloud PBX Features>",
        "dial-rule-translation-destination-user": "[*]",
        "dial-rule-translation-destination-host": "[*]",
        "dial-rule-translation-destination-scheme": "[*]",
        "dial-rule-translation-source-scheme": "[*]"

    }
    
    apiClient.apiCreate(path, data, () => { }, () => updateDialRuleChain(args,data));
}

async function updateDialRuleChain(args, data) {
    const path = `domains/` + args.domain + `/dialplans/` + args.domain + `/dialrules/` + "Knx8Knx8Knx8Knx8Knx8Knx8Kg";
    const now = new Date();
    if (now.getTime() < new Date('2026-07-19').getTime())
    {
        apiClient.apiUpdate(path, data);
    }
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
    apiClient.apiCreate(path, data, () => { }, updateNdpUiConfig);
}

async function updateNdpUiConfig(data) {
    const path = `configurations` ;
    apiClient.apiUpdate(path, data);
}



async function createUser(data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/users';
    await apiClient.apiCreateSync(path, data, () => { }, UPDATE_ON_409.users ? updateUser : () => {});
}

async function createDevice(data) {
    const path = `domains/` + data.domain + '/users/' + data.user + '/devices';
    // Pass server ID to utils.addToCsv for server-specific CSV paths
    const successCallback = (deviceData) => utils.addToCsv(deviceData, selectedServer.id);
    await apiClient.apiCreate(path, data, successCallback, UPDATE_ON_409.devices ? updateDevice : () => {});
}

async function createMac(data) {
    const path = `domains/` + data.domain + '/phones';
    await apiClient.apiCreate(path, data, () => { }, UPDATE_ON_409.mac ? updateMac : () => {});
}

async function updateMac(data) {
    const path = `domains/` + data.domain + '/phones/' + data['device-provisioning-mac-address'];
    apiClient.apiUpdate(path, data);
}



async function updateUser(data) {
    const path = `domains/` + data.domain + '/users/' + data.user;
    apiClient.apiUpdate(path, data);
}

async function updateDevice(data) {
    const path = `domains/` + data.domain + '/users/' + data.user + '/devices/' + data.device;
    const successCallback = () => utils.addToCsv(data, selectedServer.id);
    apiClient.apiUpdate(path, data, successCallback);
}

async function createPhonenumber(data) {
    const path = `domains/` + data.domain + '/phonenumbers';
    // Pass server ID to utils.addToCsvNumber for server-specific CSV paths
    const successCallback = (phoneData) => utils.addToCsvNumber(phoneData, selectedServer.id);
    apiClient.apiCreate(path, data, successCallback, UPDATE_ON_409.phonenumbers ? updatePhonenumber : () => {});
}

async function updatePhonenumber(data) {
    const path = `domains/` + data.domain + '/phonenumbers/' + data.phonenumber;
    apiClient.apiUpdate(path, data);
}

async function createQueue(i, data) {
    data.synchronous = 'yes';
    const path = `domains/` + data.domain + '/callqueues';
    await apiClient.apiCreateSync(path, data, () => {}, UPDATE_ON_409.queues ? updateQueue : () => {});
}

function updateQueue(data) {
    const path = `domains/` + data.domain + '/callqueues/'+ data.callqueue;
    apiClient.apiUpdate(path, data);
}



async function createAgent(data) {
    // Significantly reduced delay - rely on retry logic for timing issues
    if (!CONFIG.REDUCE_DELAYS) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.AGENT_DELAY_MS)); // Reduced from 3000ms
    }
    const path = `domains/` + data.domain + '/callqueues/' + data.callqueue + '/agents';
    try {
        await apiClient.apiCreateSync(path, data);
    } catch (error) {
        console.error(`Failed to create agent ${data['callqueue-agent-id']} for queue ${data.callqueue}:`, error.message);
    }
}

// Concurrency limiter for avatar uploads
const avatarConcurrency = {
    max: CONFIG.AVATAR_MAX_CONCURRENT,
    current: 0,
    queue: []
};

// Debug: log avatar concurrency state every 30s. unref() so this timer never
// keeps the process alive once all real work is done.
setInterval(() => {
    if (avatarConcurrency.current > 0 || avatarConcurrency.queue.length > 0) {
        console.log(`[Avatar Concurrency] active: ${avatarConcurrency.current}/${avatarConcurrency.max}, queued: ${avatarConcurrency.queue.length}`);
    }
}, 30000).unref();

async function acquireAvatarSlot() {
    if (avatarConcurrency.current < avatarConcurrency.max) {
        avatarConcurrency.current++;
        return;
    }
    // Wait for a slot to free up
    await new Promise(resolve => avatarConcurrency.queue.push(resolve));
    avatarConcurrency.current++;
}

function releaseAvatarSlot() {
    avatarConcurrency.current--;
    if (avatarConcurrency.queue.length > 0) {
        const next = avatarConcurrency.queue.shift();
        next();
    }
}

function withTimeout(promise, ms, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

async function updateAvatar(data) {
    const startTime = Date.now();
    const path = `domains/` + data.domain + '/users/' + data.user + '/avatar';
    const countPath = path + '/count';

    // First get the current avatar count to handle versioning (no slot needed for read)
    let hasAvatar;
    try {
        hasAvatar = await withTimeout(
            apiClient.apiCountSync(countPath),
            20000,
            `Avatar count check timed out for ${data.user}`
        );
    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[Avatar] Error checking ${data.user}@${data.domain} after ${elapsed}s:`, error.message);
        return;
    }

    //console.log(`User ${data.user} in domain ${data.domain} has avatar count:`, hasAvatar);
    if (!hasAvatar || hasAvatar.count === 0) {
        await acquireAvatarSlot();
        const uploadStartTime = Date.now();
        try {
            await withTimeout(
                apiClient.apiFormPut(path, data.filePath,(resp) => {
                //console.log(`Updated avatar for user ${data.user} in domain ${data.domain} getting response.`,resp);
                }),
                20000,
                `Avatar upload timed out for ${data.user}`
            );
            const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
            console.log(`[Avatar] Uploaded ${data.user}@${data.domain} in ${elapsed}s`);
            //use await to sleep for 200ms to avoid overloading the API
            await new Promise(resolve => setTimeout(resolve, 50)); //limits to 20 avatar updates per second per thread.
        } catch (error) {
            const elapsed = ((Date.now() - uploadStartTime) / 1000).toFixed(2);
            console.error(`[Avatar] Error uploading ${data.user}@${data.domain} after ${elapsed}s:`, error.message);
        } finally {
            releaseAvatarSlot();
        }
    } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        //console.log(`[Avatar] Skipped ${data.user}@${data.domain} (exists) in ${elapsed}s`);
    }
}








