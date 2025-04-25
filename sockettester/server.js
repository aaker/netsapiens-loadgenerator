import { io } from "socket.io-client";

import 'dotenv/config'


const hostname = process.env.HOSTNAME ;
const URL = process.env.URL || `https://${hostname}:8001`;
const MAX_CLIENTS = process.env.MAX_CLIENTS || 100;
const CLIENT_CREATION_INTERVAL_IN_MS = process.env.CLIENT_CREATION_INTERVAL_IN_MS || 50;

let clientCount = 0;
let lastReport = new Date().getTime();
let packetsSinceLastReport = 0;

const apikey = process.env.APIKEY;


console.log("Starting load test...");
console.log(`Max clients: ${MAX_CLIENTS}`);
console.log(`Client creation interval: ${CLIENT_CREATION_INTERVAL_IN_MS}ms`);
console.log(`APIKEY: ${apikey.substring(0, 12)}...`);
console.log(`Hostname: ${hostname}`);
console.log(`URL: ${URL}`);

let runtime = process.env.RUNTIME || 8 * 60 * 60 * 1000; // 8 hours
setTimeout(() => {
    console.log("Exiting after elasped runetime");
    
    process.exit(0);
},runtime ); // 8 hours then exit

if (!apikey || !hostname) {
    console.error("Please set the APIKEY and HOSTNAME environment variables.");
    process.exit(1);
}

const application = "loadtest";
let baseSubscribe = { application };
let domains_list = [];
const getJwt =  () => {

    const url = `https://${hostname}/ns-api/v2/jwt`;
    const headers = {
        "accept": "application/json",
        "authorization": `Bearer ${apikey}`,
        "content-type": "application/json",
    };
    const data = {
        "user": "1000",
        "domain": "netsapiens"
    };
    const options = {
        method: "POST",
        headers,
        body: JSON.stringify(data),
    };
    return new Promise((resolve,reject) => {
        fetch(url, options)
        .then((response) => {
            if (!response.ok) {

                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then((data) => {
            console.log("JWT:", data);
            baseSubscribe.bearer = data.token;
            resolve(data.token);
        })
        .catch((error) => {
            console.error("Error fetching JWT:", error);
        });
    
    });
    
}

const getDomains =  () => {

    const url = `https://${hostname}/ns-api/v2/domains?limit=2000`;
    const headers = {
        "accept": "application/json",
        "authorization": `Bearer ${apikey}`,
        "content-type": "application/json",
    };
    const options = {
        method: "GET",
        headers,
    };
    return new Promise((resolve,reject) => {
        fetch(url, options)
        .then((response) => {
            if (!response.ok) {

                throw new Error(`HTTP error! status: ${response.status}`);
            }
            resolve( response.json());
        })
        .then((data) => {
            resolve(data);
        })
        .catch((error) => {
            console.error("Error fetching JWT:", error);
            reject(error);
        });
    
    });
    
}


const createClient = (client_id) => {
    
    const transports = ["websocket"];

    const start_time = new Date().getTime();
    const socket = io(URL, {
        transports,
        timeout: 5000,
        'connect timeout': 5000
    });
    let thisDomain = domains_list[Math.floor(Math.random() * domains_list.length)];
    let domainBaseSubscribe = {domain:thisDomain, ...baseSubscribe}; 
    socket.on("connect", () => {
        
        const connect_time = new Date().getTime();
        const connection_duration = (connect_time - start_time) ;
        console.log(`client ${client_id} connected, domain ${thisDomain}. [${connection_duration}ms]`);
        socket.io.on("reconnection_attempt", () => {
            console.log(`client ${client_id} reconnection attempt`);
          });
          
          socket.io.on("reconnect", () => {
            console.log(`client ${client_id} reconnect`);
          });


        socket.emit("subscribe", {
            type: "call",
            filter: "1000",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "call",
            subtype: "domain",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "contacts",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "voicemail",
            filter: "1000",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "chat",
            user: "1000",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "queue",
            ...domainBaseSubscribe,
        });

        socket.emit("subscribe", {
            type: "agent",
            ...domainBaseSubscribe,
        });

        

    });

   

    socket.on('status', function (data) {
     packetsSinceLastReport++;
     if (data.status && !data.status.includes("Complete")) {
         console.log(`client ${client_id} client status:`, data.status);
     }
    });

    socket.io.on("error", (error) => {
        console.error(`client ${client_id} socket error: ${error}`);
    });

    socket.on("reconnect_attempt", (attemptNumber) => {
        console.log(`client ${client_id} reconnecting attempt ${attemptNumber}`);
    });
    socket.on("reconnect", (attemptNumber) => {
        console.log(`client ${client_id} reconnected on attempt ${attemptNumber}`);
    });
    socket.on("connect_error", (error) => {
        console.error(`client ${client_id} connect error: ${error}`);
    });
    socket.on("connect_timeout", (error) => {
        console.error(`client ${client_id} connect timeout: ${error}`);
    });
   

    socket.on("contacts-domain", () => {
        packetsSinceLastReport++;
    });
    socket.on("call", () => {
        packetsSinceLastReport++;
    });
    socket.on("agent", () => {
        packetsSinceLastReport++;
    });
    socket.on("queue", () => {
        packetsSinceLastReport++;
    });


    socket.on("disconnect", (reason) => {
        console.log(`disconnect due to ${reason}`);
    });

    if (++clientCount < MAX_CLIENTS) {
        setTimeout(createClient, CLIENT_CREATION_INTERVAL_IN_MS, clientCount);
    }
};


const bearer = getJwt().then((bearer) => {
    baseSubscribe.bearer = bearer;
    getDomains().then((domains) => {
        
        for (let i = 0; i < domains.length; i++) {
            domains_list.push(domains[i].domain);
        }
        createClient();
    });
    
}
).catch((error) => {
    console.error("Error fetching JWT:", error);
}
);



const printReport = () => {
    const now = new Date().getTime();
    const durationSinceLastReport = (now - lastReport) / 1000;
    const packetsPerSeconds = (
        packetsSinceLastReport / durationSinceLastReport
    ).toFixed(2);

    console.log(
        `client count: ${clientCount} ; average packets received per second: ${packetsPerSeconds}`
    );

    packetsSinceLastReport = 0;
    lastReport = now;
};

setInterval(printReport, 5000);