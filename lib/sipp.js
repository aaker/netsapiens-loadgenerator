const fs = require('fs');
const { execSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config("../.env");

const LOG_FILE = process.env.LOG_FILE || '/var/log/netsapiens-loadgenerator/sipp.log';
const LOG_DIR = process.env.LOG_DIR || '/var/log/netsapiens-loadgenerator';
const REGISTRATION_PCT = process.env.REGISTRATION_PCT;
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const TARGET_SERVER = process.env.TARGET_SERVER;
const IP_USE_PUBLIC = process.env.IP_USE_PUBLIC;

function log(level, message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substr(0, 19);
    const logMsg = `${timestamp} [${level}] ${message}`;
    console.log(logMsg); // This goes to stdout
    fs.appendFileSync(LOG_FILE, logMsg + "\n");
}

async function getPublicIP() {
    const response = await axios.get('https://api.ipify.org');
    return response.data;
}

function getPrivateIP() {
    return execSync('hostname -I').toString().split(' ')[0];
}

async function registerAll() {
    let counter = 0;
    if (process.argv[2]) {
        counter = parseInt(process.argv[2], 10);
    }

    const devicesDir = path.join(__dirname, '../sipp/csv/devices');
    const files = fs.readdirSync(devicesDir).length;
    log('INFO', `Found ${files} files`);

    const hourOfDay = new Date().getHours();
    const minOfHour = new Date().getMinutes();
    const adjustPort = hourOfDay % 2;

    let sipPort, mediaPort, controlPort;
    if (adjustPort === 0) {
        sipPort = 6060;
        mediaPort = 20000;
        controlPort = 10000;
    } else {
        sipPort = 8060;
        mediaPort = 30004;
        controlPort = 12004;
    }

    log('DEBUG', `Using SIPPORT=${sipPort}, MEDIAPORT=${mediaPort}, CONTROLPORT=${controlPort}`);

    const publicIP = await getPublicIP();
    const privateIP = getPrivateIP();

    log('DEBUG', `PUBLICIP=${publicIP}, PRIVATEIP=${privateIP}`);

    const mediaIP = IP_USE_PUBLIC === '1' ? publicIP : privateIP;
    // const sippScriptPath = path.join(__dirname, '../sipp/scripts/sipp_uas_pcap_g711a.xml');
    // const sippScriptContent = fs.readFileSync(sippScriptPath, 'utf8').replace('[media_ip]', mediaIP);
    // fs.writeFileSync(sippScriptPath, sippScriptContent);

    // log('DEBUG', `Replaced [media_ip] with ${mediaIP} in sipp_uas_pcap_g711a.xml`);

    execSync('ulimit -n 65536');
    log('INFO', 'scheduling batch');

    const registerAllFlag = '/tmp/register_all';
    let registerAll = 1;
    if (fs.existsSync(registerAllFlag)) {
        registerAll = 0;
        log('INFO', 'Flag /tmp/register_all found: using normal registration logic.');
    } else {
        log('INFO', 'Flag /tmp/register_all not found: registering ALL files immediately.');
    }

    const deviceFiles = fs.readdirSync(path.join(__dirname, '../sipp/csv/devices'));
    for (const file of deviceFiles) {
        sipPort += 1;
        controlPort += 1;
        mediaPort += 4;

        log('DEBUG', `Processing file ${file} with SIPPORT=${sipPort}, MEDIAPORT=${mediaPort}, CONTROLPORT=${controlPort}`);

        if (registerAll === 1) {
            log('INFO', `Registering ${file} (REGISTER_ALL active)`);
        } else {
            const modu = counter % 60;
            if (modu === minOfHour) {
                log('INFO', `Registering ${file}`);
            } else {
                counter += 1;
                log('DEBUG', `Skipping ${file}, COUNTER=${counter}`);
                continue;
            }
        }

        counter += 1;
        await new Promise(resolve => setTimeout(resolve, 2000));

        const transportType = counter % 3;
        let transport;
        if (transportType === 2) {
            transport = 'u1';
            var SERVER_URI = TARGET_SERVER + `:5060`
            log('DEBUG', `Using UDP transport with server ${SERVER_URI} for ${file}`);
        } else if (transportType === 1) {
            transport = 't1';
            var SERVER_URI = TARGET_SERVER + `:5060`
            log('DEBUG', `Using TCP transport with server ${SERVER_URI} for ${file}`);
        } else {
            transport = 'ln';
            var SERVER_URI = TARGET_SERVER + `:5061`
            log('DEBUG', `Using TLS transport with server ${SERVER_URI} for ${file}`);
        }

        register(SERVER_URI, path.join(__dirname, `../sipp/csv/devices/${file}`), transport, sipPort, mediaPort, controlPort);
    }

    if (registerAll === 1) {
        fs.writeFileSync(registerAllFlag, '');
        log('INFO', 'Created /tmp/register_all; future runs will use normal registration logic.');
    }
}

function register(SUT, inputFile, transport, sipPort, mediaPort, controlPort, mediaIP) {
    const maxUsers = Math.floor(parseFloat(REGISTRATION_PCT) * parseInt(execSync(`cat ${inputFile} | grep -v SEQUENTIAL | wc -l`).toString().trim(), 10));
    const callRate = 8;
    const sippErrorFile = path.join(LOG_DIR, `sipp_log_${TIMESTAMP}_${process.pid}.log`);

    log('INFO', `Registering ${inputFile}`);
    execSync('ulimit -n 65536');
    log('INFO', `[start] ${inputFile} ${sipPort} ${mediaPort} ${controlPort} (max users ${maxUsers}, pct users is ${REGISTRATION_PCT})`);

    const sippCommand = `
        sipp ${SUT} \
        -key expires 60 \
        -r ${callRate} \
        -m ${maxUsers} \
        -t ${transport} \
        -p ${sipPort} \
        -cp ${controlPort} \
        -rtp_echo \
        -sf ${path.join(__dirname, '../sipp/scripts/register.and.subscribe.sipp.xml')} \
        -oocsf ${path.join(__dirname, '../sipp/scripts/sipp_uas_pcap_g711a.xml')} \
        -inf ${inputFile} \
        -inf ${path.join(__dirname, '../sipp/csv/random_user_agents.csv')} \
        -recv_timeout 60000 \
        -watchdog_interval 0 \
        -watchdog_minor_threshold 920000 \
        -watchdog_major_threshold 9200000 \
        -aa -default_behaviors -abortunexp \
        -tls_cert ${path.join(__dirname, '../sipp/certs/cacert.pem')} \
        -tls_key ${path.join(__dirname, '../sipp/certs/cakey.pem')} \
        -bg -trace_err -error_file ${sippErrorFile} \
        -key media_ip ${mediaIP} \
        -key media_port ${mediaPort}
    `;

    try {
        execSync(sippCommand, { stdio: 'pipe' });
    } catch (error) {
        // If the exit status is 99 (SIPp's background mode), ignore the error.
        if (error.status === 99) {
            log('INFO', `SIPp started in background (exit code ${error.status} pid ${error.pid}).`);
        } else {
            throw error;
        }
    }
}

async function inbound() {
    const phoneDir = path.join(__dirname, '../sipp/csv/phonenumbers');
    // List only CSV files
    const files = fs.readdirSync(phoneDir).filter(f => f.endsWith('.csv'));
    if (files.length === 0) {
        console.error(`No CSV files found in ${phoneDir}`);
        process.exit(1);
    }
    // Pick a random CSV file from the directory.
    const randomFile = files[Math.floor(Math.random() * files.length)];
    const inputFile = path.join(phoneDir, randomFile);
    log('INFO', `Using inbound CSV file: ${inputFile}`);

    const peakCps = process.env.PEAK_CPS || 7;
    const maxUsers = parseInt(execSync(`cat ${inputFile} | grep -v SEQUENTIAL | wc -l`).toString().trim(), 10);

    const publicIP = await getPublicIP();
    const privateIP = getPrivateIP();
    const mediaIP = IP_USE_PUBLIC === '1' ? publicIP : privateIP;
    
    // Update the media IP in the SIPp scenario file.
    // const sippScriptPath = path.join(__dirname, '../sipp/scripts/sipp_uac_pcap_g711a.xml');
    // const sippScriptContent = fs.readFileSync(sippScriptPath, 'utf8').replace('[media_ip]', mediaIP);
    // fs.writeFileSync(sippScriptPath, sippScriptContent);

    const callRate = (peakCps / 7).toFixed(2);
    const duration = 275; // roughly 5 minutes minus some overhead
    const numCalls = Math.floor(callRate * duration);
    const sippErrorFile = path.join(LOG_DIR, `sipp_log_${TIMESTAMP}_${process.pid}.log`);

    log('INFO', `Submitting ${numCalls} inbound calls to ${TARGET_SERVER} for ${duration} seconds at ${callRate} cps using ${inputFile}`);

    const sippCommand = `
        sipp ${TARGET_SERVER} \
        -r "${callRate}" \
        -m ${numCalls} \
        -sf ${path.join(__dirname, '../sipp/scripts/sipp_uac_pcap_g711a.xml')} \
        -inf ${inputFile} \
        -watchdog_interval 900000 \
        -watchdog_minor_threshold 920000 \
        -watchdog_major_threshold 9200000 \
        -t t1 \
        -inf ${path.join(__dirname, '../sipp/csv/random_caller_ids.csv')} \
        -recv_timeout 60000 \
        -key media_ip ${mediaIP} \
        -bg \
        -trace_err \
        -error_file ${sippErrorFile}
    `;
    try {
        execSync(sippCommand, { stdio: 'pipe' });
    } catch (error) {
        // If the exit status is 99 (SIPp's background mode), ignore the error.
        if (error.status === 99) {
            log('INFO', `SIPp started in background (exit code ${error.status} pid ${error.pid}).`);
        } else {
            throw error;
        }
    }
}

module.exports = {
    registerAll,
    register,
    inbound
};