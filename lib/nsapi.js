var dotenv = require('dotenv');
var utils = require('./utils');
var axios = require('axios');

dotenv.config("../.env");

const APIKEY = process.env.APIKEY;
const TARGET_SERVER = process.env.TARGET_SERVER;
const API_DEBUG = process.env.API_DEBUG=="1";

async function apiUpdate(path, data, successFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    const options = {
        method: 'PUT', //PUT FOR UPDATE
        url, //URL is hostname + path. Example: https://api.netsapiens.com/ns-api/v2/domains
        headers: {
            accept: 'application/json', //JSON for V2 API
            'content-type': 'application/json',
            authorization: `Bearer ${APIKEY}` //APIKEY is the token here for authentication
        },
        data //data is the payload to send to the API
    };
    if (API_DEBUG) console.log(options.method, url, data);
    axios.request(options)
        .then(function (response) {
            if (API_DEBUG) console.log("Response", response.status, response.statusText);
            successFunction(data);
        }) //Success function is the function to call if the API call is successful
        .catch(function (error) {
            console.error("PUT ERROR - " + url);
            console.error(error.response.statusText);
            console.error(error.response.config);
        });
}

//This function is used to create a new object in the API, it will not wait for the response to return
async function apiCreate(path, data, successFunction, duplicateFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    if (typeof duplicateFunction !== 'function') duplicateFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    const options = {
        method: 'POST', //POST FOR CREATE
        url, //URL is hostname + path. Example: https://api.netsapiens.com/ns-api/v2/domains
        headers: {
            accept: 'application/json', //JSON for V2 API
            'content-type': 'application/json',
            authorization: `Bearer ${APIKEY}` //APIKEY is the token here for authentication
        },
        data //data is the payload to send to the API
    };
    if (API_DEBUG) console.log(options.method, url, data);
    axios.request(options)
        .then(function (response) {  //Success function is the function to call if the API call is successful
            if (API_DEBUG) console.log("Response", response.status, response.statusText);
            successFunction(data);
        })
        .catch(function (error) {
            if (error.response && error.response.status == 409) {
                if (API_DEBUG) console.log("Response", error.response.status, error.response.statusText);
                duplicateFunction(data); //Duplicate function is the function to call if the API call is a duplicate. Might want to update instead?
                successFunction(data);
            }
            else {
                console.error("POST ERROR - " + url);
                console.error(error.response.statusText);
                console.error(error.response.config);
            }

        });
}

//This function is the same as the one above, but it is async. This is useful if you need to wait for the API call to finish before continuing.
async function apiCreateSync(path, data, successFunction, duplicateFunction) {
    if (typeof successFunction !== 'function') successFunction = () => { };
    if (typeof duplicateFunction !== 'function') duplicateFunction = () => { };
    const url = `https://${TARGET_SERVER}/ns-api/v2/${path}`;
    const options = {
        method: 'POST', //POST FOR CREATE
        url, //URL is hostname + path. Example: https://api.netsapiens.com/ns-api/v2/domains
        headers: {
            accept: 'application/json', //JSON for V2 API
            'content-type': 'application/json',
            authorization: `Bearer ${APIKEY}` //APIKEY is the token here for authentication
        },
        data //data is the payload to send to the API
    };
    if (API_DEBUG) console.log(options.method, url, data);
    await new Promise((resolve, reject) => {
        axios.request(options)
            .then(function (response) {  //Success function is the function to call if the API call is successful
                if (API_DEBUG) console.log("Response", response.status, response.statusText);
                successFunction(data);
                resolve();
            })
            .catch(function (error) {
                if (error.response && error.response.status == 409) {
                    if (API_DEBUG) console.log("Response", error.response.status, error.response.statusText);
                    duplicateFunction(data);
                    resolve();
                }
                else {
                    console.error("POST ERROR - " + url);
                    console.error(error.response.statusText);
                    console.error(error.response.config);
                    resolve();
                }

            });
    });
}


module.exports = {
    apiUpdate,
    apiCreate,
    apiCreateSync
}
