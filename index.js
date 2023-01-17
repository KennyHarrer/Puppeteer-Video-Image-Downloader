const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const downloadPath = path.resolve(__dirname, 'downloads');
let targetURL = 'https://example-img-and-video.triggeredforday.repl.co/';
let downloadFilter = { media: true, image: true };
let bufferLimit = 50; //in MB
let requests = {};

async function waitForRequestLoad(requestID) {
    if (!requests[requestID]) requests[requestID] = {};
    if (requests[requestID].loaded == true) return;
    let waitForLoad;
    let requestLoaded = new Promise((resolve) => {
        waitForLoad = resolve;
    });
    requests[requestID].loaded = waitForLoad;
    await requestLoaded;
}
//used for generating file names
function generateRandomFileName(length = 8) {
    return Math.random().toString(16).substr(2, length);
}

(async () => {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
    });

    let page = await browser.newPage();

    //create CDP session
    const client = await page.target().createCDPSession();

    //increase buffer limit of session
    await client.send('Network.enable', {
        maxResourceBufferSize: 1024 * 1024 * bufferLimit,
        maxTotalBufferSize: 1024 * 1024 * bufferLimit,
    });

    //mark requests as loaded
    client.on('Network.loadingFinished', async ({ requestId }) => {
        if (!requests[requestId]) requests[requestId] = {};
        if (typeof requests[requestId].loaded == 'function') {
            //run the resolve function for the saved promise
            requests[requestId].loaded();
        } else {
            //set to true because this request has loaded
            requests[requestId].loaded = true;
        }
    });

    //handle responses
    client.on('Network.responseReceived', async (event) => {
        let { requestId, response, type } = event;
        let { url, headers, mimeType } = response;

        if (!downloadFilter[type.toLowerCase()]) return; // if i'm not going to be downloaded disregaurd
        if (mimeType == 'image/svg+xml') return; //hide these, if you want to download these files simply remove this line.

        //wait for the request to load
        await waitForRequestLoad(requestId);
        //grab the request data
        let requestData;
        try {
            requestData = await client.send('Network.getResponseBody', { requestId });
        } catch (error) {
            if (error.originalMessage == 'Request content was evicted from inspector cache') {
                throw new Error('Increase bufferLimit in index.js');
            }
            throw error;
        }

        //create buffer from data
        let requestBuffer = Buffer.from(
            requestData.body,
            requestData.base64Encoded ? 'base64' : 'utf8'
        );

        if (type == 'Media') {
            if (!requests[requestId].chunks) requests[requestId].chunks = [];
            requests[requestId].chunks.push(requestBuffer);
            let { ['content-length']: contentLength, ['content-range']: contentRange } = headers;
            let soFar = Number(contentRange.split(' ').pop().split('-').pop().split('/')[0]);
            let total = Number(contentLength) - 1;
            if (soFar < total) return; //we are still waiting for more chunks
            let video = Buffer.concat(requests[requestId].chunks); //concat chunks to form video
            let fileType = url.split('.').pop();
            const stream = fs.createWriteStream(
                path.resolve(downloadPath, generateRandomFileName(10) + '.' + fileType)
            );
            stream.write(video, () => {
                stream.close();
            });
        } else if (type == 'Image') {
            let fileType = mimeType.split('/').pop();
            const stream = fs.createWriteStream(
                path.resolve(downloadPath, generateRandomFileName(10) + '.' + fileType)
            );
            stream.write(requestBuffer, () => {
                stream.close();
            });
        } else {
            console.log('unsupported type ', type);
        }
    });

    await page.goto(targetURL);
})();
