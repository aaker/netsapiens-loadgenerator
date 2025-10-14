
var utils = require('./utils');
var axios = require('axios');
const https = require('https');

const path = require('path')
require('dotenv').config({
    path: path.resolve(__dirname, '../.env')
})

const APIKEY = process.env.APIKEY;
const TARGET_SERVER = process.env.TARGET_SERVER;
const API_DEBUG = process.env.API_DEBUG == "1";

// Configure axios with connection pooling and timeouts
const axiosInstance = axios.create({
    timeout: 30000, // 30 second timeout
    httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: 10, // Limit concurrent connections
        maxFreeSockets: 5,
        timeout: 30000,
        keepAliveMsecs: 30000,
        rejectUnauthorized: true
    }),
    headers: {
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=30, max=1000'
    }
});

// Retry configuration
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelay: 1000, // Start with 1 second
    maxDelay: 10000  // Cap at 10 seconds
};

// Retry wrapper for API calls
async function retryApiCall(apiCall, retries = RETRY_CONFIG.maxRetries) {
    try {
        return await apiCall();
    } catch (error) {
        // Check if error is retryable (socket hang up, timeout, etc.)
        const isRetryable = error.code === 'ECONNRESET' || 
                           error.code === 'ETIMEDOUT' || 
                           error.code === 'ECONNREFUSED' ||
                           error.code === 'ENOTFOUND' ||
                           (error.response && error.response.status >= 500);
        
        if (retries > 0 && isRetryable) {
            const delay = Math.min(
                RETRY_CONFIG.baseDelay * Math.pow(2, RETRY_CONFIG.maxRetries - retries),
                RETRY_CONFIG.maxDelay
            );
            
            if (API_DEBUG) {
                console.log(`Retrying API call in ${delay}ms. Retries left: ${retries}. Error: ${error.message}`);
            }
            
            await new Promise(resolve => setTimeout(resolve, delay));
            return retryApiCall(apiCall, retries - 1);
        }
        
        throw error; // Re-throw if not retryable or no retries left
    }
}

async function apiUpdate(path, data, successFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    
    const makeRequest = async () => {
        const options = {
            method: 'PUT',
            url,
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${APIKEY}`
            },
            data
        };
        
        if (API_DEBUG) console.log(options.method, url, data);
        return axiosInstance.request(options);
    };
    
    try {
        const response = await retryApiCall(makeRequest);
        if (API_DEBUG) console.log("Response", response.status, response.statusText);
        successFunction(data);
    } catch (error) {
        console.error("PUT ERROR - " + url);
        if (error?.response?.status) {
            console.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
            if (error.response.data) {
                console.error("Response data:", error.response.data);
            }
        } else {
            console.error("Network/Connection error:", error.message);
        }
    }
}

//This function is used to create a new object in the API, it will not wait for the response to return
async function apiCreate(path, data, successFunction, duplicateFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    if (typeof duplicateFunction !== 'function') duplicateFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    
    const makeRequest = async () => {
        const options = {
            method: 'POST',
            url,
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${APIKEY}`
            },
            data
        };
        
        if (API_DEBUG) console.log(options.method, url, data);
        return axiosInstance.request(options);
    };
    
    try {
        const response = await retryApiCall(makeRequest);
        if (API_DEBUG) console.log("Response", response.status, response.statusText);
        successFunction(data);
    } catch (error) {
        if (error.response && error.response.status == 409) {
            if (API_DEBUG) console.log("Response", error.response.status, error.response.statusText);
            duplicateFunction(data); //Duplicate function is the function to call if the API call is a duplicate. Might want to update instead?
            successFunction(data);
        } else {
            console.error("POST ERROR url - " + url);
            if (error?.response?.status) {
                console.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
                if (error.response.data) {
                    console.error("Response data:", error.response.data);
                }
            } else {
                console.error("Network/Connection error:", error.message);
            }
        }
    }
}

//This function is the same as the one above, but it is async. This is useful if you need to wait for the API call to finish before continuing.
async function apiCreateSync(path, data, successFunction, duplicateFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    if (typeof duplicateFunction !== 'function') duplicateFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    
    const makeRequest = async () => {
        const options = {
            method: 'POST',
            url,
            headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${APIKEY}`
            },
            data
        };
        
        if (API_DEBUG) console.log(options.method, url, data);
        return axiosInstance.request(options);
    };
    
    try {
        const response = await retryApiCall(makeRequest);
        if (API_DEBUG) console.log("Response", response.status, response.statusText);
        successFunction(data);
    } catch (error) {
        if (error.response && error.response.status == 409) {
            if (API_DEBUG) console.log("Response", error.response.status, error.response.statusText);
            duplicateFunction(data);
        } else {
            console.error("POST ERROR url - " + url);
            if (error?.response?.status) {
                console.error(`HTTP ${error.response.status}: ${error.response.statusText}`);
                if (error.response.data) {
                    console.error("Response data:", error.response.data);
                }
            } else {
                console.error("Network/Connection error:", error.message);
            }
        }
    }
}


module.exports = {
    apiUpdate,
    apiCreate,
    apiCreateSync
}
